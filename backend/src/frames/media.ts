import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SIG_CELLS, SIG_H, SIG_W } from "./signature";

/**
 * Pictures out of YouTube, with the same tools speech uses for sound. A live stream is read by ffmpeg from the HLS
 * manifest yt-dlp resolves (one frame at the live edge, ~3.5 s). A recording is not: YouTube refuses ffmpeg's own range
 * reads past the first bytes, so yt-dlp downloads it (fast, in ranges) into ffmpeg, which decodes only keyframes.
 */

// --remote-components: yt-dlp's JS-challenge solver; without it YouTube hides some formats. Node is the runtime in this image.
const YTDLP = ["yt-dlp", "--no-playlist", "--no-warnings", "--remote-components", "ejs:github", "--js-runtimes", "node"];
const FORMAT = "bv*[height<=720]/b[height<=720]/bv*/b";
const FFMPEG = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y"];

export interface Resolved {
  live: boolean;
  /** The HLS manifest of a live stream, or the media URL of a recording. */
  media: string;
}

export interface Grab {
  image: Uint8Array;
  thumb: Uint8Array;
  sig: Uint8Array;
  width: number;
  height: number;
}

export interface Shape {
  width: number;
  thumb_width: number;
  quality: number;
}

export interface Media {
  resolve(url: string): Promise<Resolved>;
  /** One frame at the live edge of a manifest. */
  grabLive(manifest: string, shape: Shape): Promise<Grab>;
  /** Every interval_s from `from` of a recording: a signature for each, and the still to encode if it is kept. */
  sample(url: string, opts: { from: number; intervalS: number; width: number }, each: (s: { t: number; sig: Uint8Array; still: string }) => Promise<void>): Promise<number>;
  /** A still from `sample` as the stored image and its thumbnail. */
  encode(still: string, shape: Shape): Promise<Grab>;
}

function run(cmd: string[], timeoutMs: number, opts: { stdout?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0]!, cmd.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      if (opts.stdout !== false) out += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      err = (err + d.toString()).slice(-2000);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      // Never pass a media URL on: they carry the box's IP and a signature.
      const clean = err.replace(/https?:\/\/\S+/g, "<url>").trim();
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd[0]} ${signal ? `killed (${signal})` : `exited ${code}`}: ${clean.slice(-400)}`));
    });
  });
}

/** Width and height of a WebP, from its header (lossy VP8, lossless VP8L or extended VP8X). */
export function webpSize(b: Uint8Array): { width: number; height: number } {
  const tag = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (tag === "VP8 ") return { width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff };
  if (tag === "VP8L") {
    const bits = v.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (tag === "VP8X") return { width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
  throw new Error(`not a webp (${tag})`);
}

// One decode, three outputs: the image, its thumbnail, and the 64x36 grey signature (area-averaged: each value the mean of a block).
function outputs(dir: string, shape: Shape): string[] {
  const graph = `[0:v]split=3[a][b][c];[a]scale=${shape.width}:-2[f];[b]scale=${shape.thumb_width}:-2[t];[c]scale=${SIG_W}:${SIG_H}:flags=area,format=gray[s]`;
  const webp = ["-c:v", "libwebp", "-quality", String(shape.quality)];
  return [
    "-filter_complex", graph,
    "-map", "[f]", "-frames:v", "1", ...webp, join(dir, "f.webp"),
    "-map", "[t]", "-frames:v", "1", ...webp, join(dir, "t.webp"),
    "-map", "[s]", "-frames:v", "1", "-f", "rawvideo", join(dir, "s.gray"),
  ];
}

async function collect(dir: string): Promise<Grab> {
  const [image, thumb, sig] = await Promise.all(["f.webp", "t.webp", "s.gray"].map((f) => readFile(join(dir, f))));
  if (sig!.length !== SIG_CELLS) throw new Error(`signature of ${sig!.length} bytes`);
  return { image: new Uint8Array(image!), thumb: new Uint8Array(thumb!), sig: new Uint8Array(sig!), ...webpSize(image!) };
}

async function inTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "frame-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const ytMedia: Media = {
  async resolve(url) {
    const out = await run([...YTDLP, "-f", FORMAT, "--print", "%(live_status)s\t%(url)s", url], 90_000);
    const [status, media] = (out.split("\n").find((l) => l.includes("\t")) ?? "").split("\t");
    if (!media?.startsWith("http")) throw new Error("yt-dlp resolved no video URL");
    return { live: status === "is_live", media };
  },

  grabLive(manifest, shape) {
    return inTemp(async (dir) => {
      // The newest segment, not the three-back default: the frame is as close to now as the stream gives.
      await run([...FFMPEG, "-live_start_index", "-1", "-i", manifest, ...outputs(dir, shape)], 45_000);
      return collect(dir);
    });
  },

  async sample(url, opts, each) {
    return inTemp(async (dir) => {
      // Keyframes only (YouTube puts one every few seconds), then one still per interval on the stream's own clock:
      // still n is at from + n * interval. Stills are written as they come and read once the decode is done.
      const vf = `select=gte(t\\,${opts.from}),fps=1/${opts.intervalS}:start_time=${opts.from},split=2[a][b];[a]scale=${opts.width}:-2[o];[b]scale=${SIG_W}:${SIG_H}:flags=area,format=gray[s]`;
      // No pipefail: a download that dies part way still leaves ffmpeg's stills of what it got, and those are kept.
      const script = [
        `${quote([...YTDLP, "-f", FORMAT, "-o", "-", url])} 2>/dev/null | ${quote([...FFMPEG, "-skip_frame", "nokey", "-i", "pipe:0", "-filter_complex", `[0:v]${vf}`, "-map", "[o]", "-fps_mode", "passthrough", "-q:v", "2", join(dir, "s_%06d.jpg"), "-map", "[s]", "-fps_mode", "passthrough", "-f", "rawvideo", join(dir, "sigs.gray")])}`,
      ].join("\n");
      await run(["bash", "-c", script], 3 * 60 * 60 * 1000);
      const sigs = await readFile(join(dir, "sigs.gray"));
      const stills = (await readdir(dir)).filter((f) => f.startsWith("s_") && f.endsWith(".jpg")).sort();
      const n = Math.min(stills.length, Math.floor(sigs.length / SIG_CELLS));
      for (let i = 0; i < n; i++) {
        await each({ t: opts.from + i * opts.intervalS, sig: new Uint8Array(sigs.subarray(i * SIG_CELLS, (i + 1) * SIG_CELLS)), still: join(dir, stills[i]!) });
      }
      return n;
    });
  },

  encode(still, shape) {
    return inTemp(async (dir) => {
      await run([...FFMPEG, "-i", still, ...outputs(dir, shape)], 30_000);
      return collect(dir);
    });
  },
};

const quote = (args: string[]) => args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");

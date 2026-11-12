import { AwsClient } from "aws4fetch";

/** Where frames go: Cloudflare R2, read by browsers straight from its public URL, so no image goes through the api. */
export interface FrameStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  url(key: string): string;
}

export interface R2Env {
  R2_ENDPOINT?: string | undefined;
  R2_BUCKET?: string | undefined;
  R2_ACCESS_KEY_ID?: string | undefined;
  R2_SECRET_ACCESS_KEY?: string | undefined;
  R2_PUBLIC_URL?: string | undefined;
}

/** Null when any R2 value is missing: the framer then stays off and says so. */
export function r2Store(env: R2Env, fetchImpl: typeof fetch = fetch): FrameStore | null {
  const { R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_PUBLIC_URL } = env;
  if (!R2_ENDPOINT || !R2_BUCKET || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_PUBLIC_URL) return null;
  const client = new AwsClient({ accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY, service: "s3", region: "auto" });
  const base = `${R2_ENDPOINT.replace(/\/$/, "")}/${R2_BUCKET}`;
  const publicBase = R2_PUBLIC_URL.replace(/\/$/, "");
  return {
    async put(key, body, contentType) {
      const request = await client.sign(`${base}/${key}`, {
        method: "PUT",
        body: new Uint8Array(body) as Uint8Array<ArrayBuffer>,
        // A key is never written twice with other bytes, so a browser may keep it for good.
        headers: { "content-type": contentType, "cache-control": "public, max-age=31536000, immutable" },
      });
      const response = await fetchImpl(request);
      if (!response.ok) throw new Error(`R2 put ${key}: ${response.status} ${(await response.text()).slice(0, 200)}`);
    },
    url: (key) => `${publicBase}/${key}`,
  };
}

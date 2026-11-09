/** Stream seconds as mm:ss, or h:mm:ss past an hour. */
export function formatT(seconds: number): string {
  const whole = Math.floor(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const mmss = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}

/** Local wall-clock time of a stream instant, from the session's start. Null before the session started. */
export function wallTime(startedAt: string | null, t: number): string | null {
  if (!startedAt) return null;
  return new Date(new Date(startedAt).getTime() + t * 1000).toLocaleTimeString([], { hour12: false });
}

/** A hub id like pyannote/speaker-diarization-3.1 reads as its last part in a dense bar. Null when absent. */
export function shortModel(name: string | undefined): string | null {
  if (!name) return null;
  return name.slice(name.lastIndexOf("/") + 1) || name;
}

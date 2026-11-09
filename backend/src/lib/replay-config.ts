/**
 * The original's config, then the overrides, then the replay's speed; a null override removes the key so its default
 * applies. Speed is set last and a `speed` override is ignored: the Speed choice owns it, and the box must not unset it
 * or send a negative one to speech.
 */
export function replayConfig(original: Record<string, unknown>, speed: number, overrides: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...original };
  for (const [key, value] of Object.entries(overrides)) {
    if (key === "speed") continue;
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  merged.speed = speed;
  return merged;
}

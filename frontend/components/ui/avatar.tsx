import type { CSSProperties } from "react";

import { initials, nameHue } from "@/lib/format";
import { photoSrc } from "@/lib/photo";

const SIZES = { sm: "size-8 text-xs", md: "size-10 text-sm", lg: "size-14 text-lg", xl: "size-24 text-3xl" } as const;

/** A person's photo, or their initials on a colour that is always theirs. A voice nobody has named yet gets a plain mark. */
export function Avatar({ name, photoUrl, size = "md" }: { name: string | null; photoUrl?: string | null; size?: keyof typeof SIZES }) {
  const shape = `${SIZES[size]} shrink-0 rounded-full`;
  const src = photoSrc(photoUrl);
  if (src) {
    // A speaker photo is stored small already, or comes from wherever the admin found it, so it is a plain img, not an optimised one.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" className={`${shape} bg-sunk object-cover`} loading="lazy" />;
  }
  if (!name) return <span aria-hidden className={`${shape} flex items-center justify-center bg-sunk font-semibold text-ink-faint`}>?</span>;
  const hue = nameHue(name);
  return (
    <span aria-hidden className={`${shape} avatar-initials flex items-center justify-center font-semibold`} style={{ "--hue": hue } as CSSProperties}>
      {initials(name)}
    </span>
  );
}

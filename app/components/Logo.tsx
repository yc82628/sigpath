/**
 * The SigPath logo (finalised 2026-10-02, recoloured 2026-10-06 from cyan to
 * the palette's light sage #89b09f): light sage artwork on a black brush
 * circle. The lettering is custom (P-A-T-H share one top bar), so it ships as
 * the artwork itself, cut out of the source design onto a transparent
 * background, rather than as a font.
 *
 *   public/brand/sigpath-wordmark.png  the lettering alone, for the header
 *   public/brand/sigpath-badge.png     the full badge, for the home page
 *   app/icon.png                       the basket on a black disc, the favicon
 */

import Image from "next/image";

export const SLOGAN = "Deal Go – Scam Towed";

/** The light sage lettering, sized for the dark header bar. */
export function Wordmark() {
  return <Image className="logo-wordmark" src="/brand/sigpath-wordmark.png" alt="SigPath" width={297} height={65} priority />;
}

/** The full badge: basket, name and slogan in the brush circle. */
export function Badge({ className }: { className?: string }) {
  return (
    <Image
      className={className}
      src="/brand/sigpath-badge.png"
      alt={`SigPath — ${SLOGAN}`}
      width={471}
      height={471}
      priority
    />
  );
}

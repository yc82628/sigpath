/**
 * The SigPath logo (finalised 2026-10-02; recoloured 2026-10-06 from cyan to
 * light sage, and 2026-10-11 to Solana's purple -> blue -> green gradient, as
 * on the pitch deck): gradient artwork on a black brush circle. The lettering is custom (P-A-T-H share one top bar), so it ships as
 * the artwork itself, cut out of the source design onto a transparent
 * background, rather than as a font.
 *
 *   public/brand/sigpath-wordmark.png  the lettering alone, for the header
 *   public/brand/sigpath-badge.png     the full badge, for the home page
 *   app/icon.png                       the basket on a black disc, the favicon
 */

import Image from "next/image";

export const SLOGAN = "Deal Go – Scam Towed";

/** The gradient lettering, sized for the dark header bar. */
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

/**
 * An icon in SigPath's two styles, from Phosphor's duotone shapes (MIT, see
 * icon-paths.ts):
 *
 *   Pop (light theme): the dark outline over a solid colour fill, the fill
 *   shifted down and right, like a print slightly off register.
 *   Neon (dark theme, and the always-dark header): the outline in colour with
 *   a soft glow, over a faint wash of the same colour.
 *
 * The tone cycles through Solana's purple, blue and green. Decorative: the
 * text beside an icon says what it means, so it is hidden from screen readers.
 */

import { ICON_PATHS, type IconName } from "./icon-paths";

export type Tone = "purple" | "blue" | "green";
export const TONES: Tone[] = ["purple", "blue", "green"];

export default function PopIcon({
  name,
  tone = "purple",
  size = 24,
  neon = false,
  className = "",
}: {
  name: IconName;
  tone?: Tone;
  size?: number;
  /** Always Neon, whatever the theme: for dark surfaces like the header. */
  neon?: boolean;
  className?: string;
}) {
  const { fill, line } = ICON_PATHS[name];
  return (
    <svg
      className={`pop-icon tone-${tone}${neon ? " neon" : ""}${className ? ` ${className}` : ""}`}
      viewBox="0 0 256 256"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <g className="pop-fill">
        {fill.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
      <g className="pop-line">
        {line.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
    </svg>
  );
}

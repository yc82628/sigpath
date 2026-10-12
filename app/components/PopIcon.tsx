/**
 * An icon in SigPath's Flex Pop style, from Phosphor's duotone shapes (MIT,
 * see icon-paths.ts): the outline over a solid colour fill, the fill shifted
 * down and right, like a print slightly off register (globals.css).
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
  onDark = false,
  className = "",
}: {
  name: IconName;
  tone?: Tone;
  size?: number;
  /** A light outline whatever the theme: for dark surfaces like the header. */
  onDark?: boolean;
  className?: string;
}) {
  const { fill, line } = ICON_PATHS[name];
  return (
    <svg
      className={`pop-icon tone-${tone}${onDark ? " on-dark" : ""}${className ? ` ${className}` : ""}`}
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

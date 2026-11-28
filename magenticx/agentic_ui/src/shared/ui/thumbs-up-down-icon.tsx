import { useId } from "react";
import type { SVGProps } from "react";

import { cn } from "@/shared/lib/utils";

/**
 * The answer-feedback icons: a mitten-shaped thumb (a cuff on the side, a
 * short hand and a narrow finger with a rounded tip), alone or as a pair.
 * Drawn here because no icon set we use has a thumbs pair that reads at 16px:
 * lucide's thumbs blur into each other when overlapped, Material's
 * `thumbs_up_down` is a different weight from the lucide icons beside it. The
 * pair is ChatGPT's layout: the up thumb in front at the top left, the down
 * thumb (the same glyph turned 180°) behind it at the bottom right, with a gap
 * cut around the front one. The single thumbs use the same glyph, so the
 * button, its menu and the rated state are one family.
 */

/** The up thumb's cuff, its left side; open on the right, where the hand's edge closes it. */
const CUFF = "M3.8 5.5H2a.8.8 0 0 0-.8.8v5.2a.8.8 0 0 0 .8.8h1.8";
/** The hand and its finger, up thumb. Box: x 1.2–10.6, y 0.9–12.3. */
const HAND =
  "M3.8 12.3V5.5L5.3 4.3V2.6C5.3 1.5 6 .9 6.8 .9C7.6 .9 8.3 1.5 8.3 2.6V5.9L10.1 6.6a.8.8 0 0 1 .5.75V11.5a.8.8 0 0 1-.8.8H3.8Z";

/** The pair: the down thumb sits at the up one's box moved by (7.5, 7), turned 180° about the pair's centre. */
const PAIR_DOWN = "rotate(180 9.65 10.1)";
const PAIR_STROKE = 1.35;
const PAIR_GAP = 1.2;

function Thumb() {
  return (
    <>
      <path d={CUFF} />
      <path d={HAND} />
    </>
  );
}

const svgBase = {
  xmlns: "http://www.w3.org/2000/svg",
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
  overflow: "visible",
  "aria-hidden": true,
  focusable: false,
} as const;

/** The Feedback button's mark: both thumbs. 19px tall by default, the weight of a 16px lucide icon. */
export function ThumbsUpDownIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  // A mask id per instance; useId's colons are not safe inside url(#…).
  const maskId = `thumbs-gap-${useId().replace(/:/g, "")}`;
  return (
    <svg
      {...svgBase}
      viewBox="0 0 19.3 20.2"
      strokeWidth={PAIR_STROKE}
      className={cn("h-[19px] w-[18px] shrink-0", className)}
      {...props}
    >
      <mask id={maskId} maskUnits="userSpaceOnUse" x="-1" y="-1" width="21.3" height="22.2">
        <rect x="-1" y="-1" width="21.3" height="22.2" fill="white" />
        {/* The front thumb, filled and widened by the gap: the back one is cut away there. */}
        <g fill="black" stroke="black" strokeWidth={PAIR_STROKE + 2 * PAIR_GAP}>
          <path d={CUFF} />
          <path d={HAND} />
        </g>
      </mask>
      <g mask={`url(#${maskId})`}>
        <g transform={PAIR_DOWN}>
          <Thumb />
        </g>
      </g>
      <Thumb />
    </svg>
  );
}

/** One thumb up. */
export function ThumbUpIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      {...svgBase}
      viewBox="0.2 0 11.4 13.2"
      strokeWidth={1.15}
      className={cn("h-4 w-[14px] shrink-0", className)}
      {...props}
    >
      <Thumb />
    </svg>
  );
}

/** One thumb down: the up glyph turned 180°. */
export function ThumbDownIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      {...svgBase}
      viewBox="0.2 0 11.4 13.2"
      strokeWidth={1.15}
      className={cn("h-4 w-[14px] shrink-0", className)}
      {...props}
    >
      <g transform="rotate(180 5.9 6.6)">
        <Thumb />
      </g>
    </svg>
  );
}

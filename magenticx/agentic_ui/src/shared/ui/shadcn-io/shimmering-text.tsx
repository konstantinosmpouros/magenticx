/**
 * A label with a highlight that sweeps across it, left to right, then rests —
 * the "working on it" cue on live thoughts, sending and run markers.
 *
 * One element, drawn by CSS (plan 45): a gradient clipped to the glyphs and
 * moved by the shared `animate-shimmer-text` keyframe. The shadcn-io original
 * animated a `motion.span` per character from JavaScript, kept every one alive
 * on the main thread for as long as a run lasted, ignored reduced motion, and
 * was the only reason the `motion` package shipped.
 *
 * Reduced motion: the sweep stops and the label is drawn in its base colour.
 */
import * as React from "react";

import { cn } from "@/shared/lib/utils";

type ShimmeringTextProps = {
  text: string;
  /** Seconds the highlight takes to cross the label. */
  duration?: number;
  /** The label's colour. */
  color?: string;
  /** The highlight's colour at the peak of the sweep. */
  shimmeringColor?: string;
  /** Seconds of rest between sweeps; defaults to 50 ms per character. */
  pause?: number;
} & Omit<React.HTMLAttributes<HTMLSpanElement>, "children" | "color">;

// The gradient tile is twice the label's width and repeats, and the keyframe
// moves it two tiles per cycle (`200% 0` → `-200% 0`), so the highlight crosses
// the label twice per animation cycle: one cycle is two sweeps-plus-rest. The
// band spans 30–70% of the tile — lit for about 40% of each sweep-plus-rest,
// like the per-character glow it replaces.
const SHIMMER_CLASSES = cn(
  "relative inline-block",
  "bg-[linear-gradient(90deg,var(--color)_30%,var(--shimmering-color)_50%,var(--color)_70%)]",
  "bg-[length:200%_100%] bg-clip-text text-transparent animate-shimmer-text",
  "motion-reduce:animate-none motion-reduce:bg-none motion-reduce:text-[color:var(--color)]",
);

function ShimmeringText({
  text,
  duration = 1,
  className,
  color = "var(--color-neutral-500)",
  shimmeringColor = "var(--color-neutral-300)",
  pause,
  style,
  ...props
}: ShimmeringTextProps) {
  const rest = pause ?? text.length * 0.05;

  return (
    <span
      className={cn(SHIMMER_CLASSES, className)}
      style={
        {
          "--shimmering-color": shimmeringColor,
          "--color": color,
          // Two sweeps per keyframe cycle (see SHIMMER_CLASSES).
          animationDuration: `${2 * (duration + rest)}s`,
          ...style,
        } as React.CSSProperties
      }
      {...props}
    >
      {text}
    </span>
  );
}

export { ShimmeringText, type ShimmeringTextProps };

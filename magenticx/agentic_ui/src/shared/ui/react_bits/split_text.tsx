/**
 * Text whose characters rise and fade in one after another, with a springy
 * settle — the empty chat's greeting quote.
 *
 * Rewritten from react-bits' GSAP SplitText (plan 45): gsap, its SplitText and
 * ScrollTrigger plugins (~120 KB) shipped in the first download for this one
 * greeting, re-split the text through the DOM on every quote change, and left
 * `will-change` on the element for good. Here React renders the per-character
 * spans and each runs a native Web Animation (compositor-only: `transform` and
 * `opacity`) that ends on its own; nothing stays promoted afterwards.
 *
 * No shadcn/Radix part covers per-character entrance motion, hence a custom one.
 * Reduced motion: the text simply appears.
 */
import React, { useLayoutEffect, useMemo, useRef } from "react";

export interface SplitTextProps {
  text: string;
  className?: string;
  /** Milliseconds between one character's start and the next's. */
  delay?: number;
  /** Seconds each character's entrance lasts. */
  duration?: number;
  /** Pixels each character rises from. */
  offsetY?: number;
  tag?: "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "p" | "span";
  textAlign?: React.CSSProperties["textAlign"];
}

/**
 * GSAP's `elastic.out(1, 0.3)` (the original's ease), sampled into a CSS
 * `linear()` easing so the browser runs it natively.
 */
function elasticOutEasing(): string {
  const period = 0.3;
  const shift = period / 4;
  const steps = 60;
  const points: string[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const value =
      t === 0 ? 0 : 2 ** (-10 * t) * Math.sin(((t - shift) * (2 * Math.PI)) / period) + 1;
    points.push(value.toFixed(4));
  }
  return `linear(${points.join(", ")})`;
}

/** The springy ease where `linear()` is supported, else a close back-out curve. */
const ENTRANCE_EASING =
  typeof CSS !== "undefined" && CSS.supports?.("animation-timing-function", "linear(0, 1)")
    ? elasticOutEasing()
    : "cubic-bezier(0.34, 1.56, 0.64, 1)";

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const SplitText: React.FC<SplitTextProps> = ({
  text,
  className = "",
  delay = 100,
  duration = 2,
  offsetY = 40,
  tag = "p",
  textAlign = "center",
}) => {
  const ref = useRef<HTMLElement>(null);

  // Words stay whole (no line break inside a word, as GSAP's `smartWrap` did);
  // the spaces between them are plain text, where lines may break.
  const words = useMemo(() => {
    let index = 0;
    return text.split(" ").map((word) =>
      Array.from(word).map((char) => {
        index += 1;
        return { char, index: index - 1 };
      }),
    );
  }, [text]);

  // Layout effect: the animations start hidden (`fill: backwards`) before the
  // first paint, so the full text never flashes in first.
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || prefersReducedMotion()) return;
    const chars = root.querySelectorAll<HTMLElement>("[data-split-char]");
    const animations: Animation[] = [];
    chars.forEach((char, i) => {
      if (typeof char.animate !== "function") return;
      animations.push(
        char.animate(
          [
            { opacity: 0, transform: `translateY(${offsetY}px)` },
            { opacity: 1, transform: "translateY(0)" },
          ],
          { duration: duration * 1000, delay: i * delay, easing: ENTRANCE_EASING, fill: "backwards" },
        ),
      );
    });
    return () => {
      animations.forEach((animation) => animation.cancel());
    };
  }, [words, delay, duration, offsetY]);

  const Tag = tag;
  return (
    <Tag
      ref={ref as React.Ref<HTMLHeadingElement & HTMLParagraphElement>}
      // The characters are separate spans; the label keeps the text whole for
      // screen readers.
      aria-label={text}
      style={{ textAlign, wordWrap: "break-word" }}
      className={`split-parent overflow-hidden inline-block whitespace-normal ${className}`}
    >
      {words.map((chars, wordIndex) => (
        <React.Fragment key={wordIndex}>
          {wordIndex > 0 ? " " : null}
          <span aria-hidden="true" className="inline-block whitespace-nowrap">
            {chars.map(({ char, index }) => (
              <span key={index} data-split-char className="inline-block">
                {char}
              </span>
            ))}
          </span>
        </React.Fragment>
      ))}
    </Tag>
  );
};

export default SplitText;

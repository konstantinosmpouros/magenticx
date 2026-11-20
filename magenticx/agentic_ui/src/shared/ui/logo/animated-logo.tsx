import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";

import { cn } from "@/shared/lib/utils";

import { LogoRenderer } from "./logo-renderer";
import { ACTIVE_BOOST, type MotionPreset } from "./motion";

type AnimatedLogoProps = {
  /** The artwork (the active theme's, from the theme registry). */
  src: string;
  motion: MotionPreset;
  /** While the AI works: faster flow and a gentle pulse. */
  active?: boolean;
  /** Size it with width and height classes; the artwork fills the square. */
  className?: string;
  /** Accessible name; leave out for a decorative artwork. */
  label?: string;
};

const TAU = Math.PI * 2;
/** Seconds over which the motion grows from the still image. */
const RAMP_SECONDS = 1.2;
const MAX_CANVAS_PX = 1024;
/**
 * Below this CSS size the artwork stays a still image (plan 45): at 18-30px
 * the flow is too small to see, and every animated logo costs a WebGL context
 * (browsers allow only a few) and a loop.
 */
const STILL_BELOW_PX = 32;
/** The loop draws at most 30 frames a second: the liquid moves slowly. */
const FRAME_MS = 1000 / 30;

/**
 * An artwork, animated: its own pixels moved by a WebGL shader (see
 * `logo-renderer.ts`) — the liquid inside flows while the outline stays. A
 * new `src` (a theme change) crossfades in. Paused while off screen or in a
 * hidden tab. Reduced motion, no WebGL, or a size under 32px shows the still
 * image.
 */
export function AnimatedLogo({ src, motion, active = false, className, label }: AnimatedLogoProps) {
  const reduceMotion = useReducedMotion();
  const boxRef = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<LogoRenderer | null>(null);
  const loadedSrcRef = useRef<string | null>(null);
  const srcRef = useRef(src);
  srcRef.current = src;
  const activeRef = useRef(active);
  activeRef.current = active;
  // Measured before the first paint, then kept current: a small logo (or one
  // not laid out, e.g. hidden on a short window) never starts WebGL.
  const [small, setSmall] = useState(true);
  // The GPU dropped the context or a draw failed: the still image for good.
  const [failed, setFailed] = useState(false);
  const animate = !reduceMotion && !small && !failed;
  const [mode, setMode] = useState<"loading" | "live">("loading");

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const measure = () => setSmall(box.clientWidth < STILL_BELOW_PX);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!animate || !canvas) return;
    const renderer = LogoRenderer.create(canvas);
    if (!renderer) {
      setFailed(true);
      return;
    }
    rendererRef.current = renderer;
    renderer.setMotion(motion);
    setMode("loading");

    // The loop: phase advances with the (eased) speed; amplitude ramps up from
    // zero once, so the first frame is the still image.
    let phase = 0;
    let ramp = 0;
    let liveliness = 0;
    let last = 0;
    let frame = 0;
    let onScreen = true;
    let contextLost = false;
    let painted = false;

    // Back to the still image for good: the GPU dropped the context (too many
    // on the page, a GPU reset — DevTools' device mode can cause one) or a
    // draw failed. A blank canvas must never stand in for the artwork.
    const fallBack = () => {
      contextLost = true;
      cancelAnimationFrame(frame);
      setFailed(true);
    };
    // One frame. The canvas replaces the still image only once it has really
    // drawn one, so a paused loop (off screen) or a texture still loading
    // never leaves the spot empty.
    const paint = () => {
      if (contextLost) return;
      try {
        if (renderer.contextLost) return fallBack();
        if (renderer.draw(phase, ramp * ramp * (3 - 2 * ramp)) && !painted && canvas.width > 0) {
          painted = true;
          setMode("live");
        }
      } catch {
        fallBack();
      }
    };

    loadedSrcRef.current = srcRef.current;
    renderer.setImage(srcRef.current).then(paint, () => setFailed(true));

    // Resizing a canvas clears it: draw again straight away, so it is never
    // left blank while the loop is paused.
    const size = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const side = Math.min(MAX_CANVAS_PX, Math.round(canvas.clientWidth * ratio));
      if (side > 0) {
        renderer.resize(side, side);
        paint();
      }
    };
    size();
    const resizeObserver = new ResizeObserver(size);
    resizeObserver.observe(canvas);

    const tick = (now: number) => {
      // Every other frame on a 60 Hz screen (a 2ms slack absorbs jitter).
      if (last && now - last < FRAME_MS - 2) {
        frame = requestAnimationFrame(tick);
        return;
      }
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
      last = now;
      const target = activeRef.current ? 1 : 0;
      liveliness += (target - liveliness) * Math.min(1, dt * 2.5);
      const speed = 1 + (ACTIVE_BOOST.speed - 1) * liveliness;
      phase = (phase + (dt * speed * TAU) / motion.period) % TAU;
      ramp = Math.min(1, ramp + dt / RAMP_SECONDS);
      renderer.setLiveliness(
        motion.flow * (1 + (ACTIVE_BOOST.flow - 1) * liveliness),
        motion.breath + ACTIVE_BOOST.breath * liveliness,
      );
      paint();
      if (!contextLost) frame = requestAnimationFrame(tick);
    };
    const run = () => {
      cancelAnimationFrame(frame);
      if (onScreen && !contextLost && !document.hidden) {
        last = 0;
        frame = requestAnimationFrame(tick);
      }
    };
    const intersection = new IntersectionObserver(([entry]) => {
      onScreen = entry?.isIntersecting ?? true;
      run();
    });
    intersection.observe(canvas);
    document.addEventListener("visibilitychange", run);
    // Browsers drop the oldest contexts when too many are open: show the still image.
    canvas.addEventListener("webglcontextlost", fallBack);
    run();

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      intersection.disconnect();
      document.removeEventListener("visibilitychange", run);
      canvas.removeEventListener("webglcontextlost", fallBack);
      renderer.dispose();
      rendererRef.current = null;
      loadedSrcRef.current = null;
      setMode("loading");
    };
  }, [motion, animate]);

  // A theme switch: the new artwork crossfades in.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || loadedSrcRef.current === src) return;
    loadedSrcRef.current = src;
    renderer.setImage(src).catch(() => setFailed(true));
  }, [src]);

  const live = animate && mode === "live";

  // The still image, placed where the canvas draws the artwork, so the swap is seamless.
  const stillStyle = { transform: `scale(${motion.scale})` };

  return (
    <span
      ref={boxRef}
      className={cn("relative inline-block shrink-0", className)}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {!live && (
        <img
          src={src}
          alt=""
          draggable={false}
          className="absolute inset-0 h-full w-full select-none object-contain"
          style={stillStyle}
        />
      )}
      {animate && (
        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-full w-full"
          style={{ opacity: live ? 1 : 0 }}
        />
      )}
    </span>
  );
}

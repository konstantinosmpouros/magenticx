/**
 * Runs a callback at most once per animation frame (plan 45, Phase 3).
 *
 * The bridge sends about one WebSocket frame per streamed token, often far more
 * than the screen can show. The run engine still folds every frame as it
 * arrives — nothing is dropped or merged — and uses this to hand the result to
 * React once per frame instead of once per token.
 *
 * Browsers pause `requestAnimationFrame` in a background tab, so a timer is
 * armed beside it: whichever fires first runs the callback and cancels the
 * other. In a visible tab the frame wins (~16 ms); in a hidden one the timer
 * does, at the browser's throttled rate, so state still moves forward.
 */
export type FrameScheduler = {
  /** Ask for one run of the callback; repeated asks before it runs are merged. */
  schedule: () => void;
  /** Run the callback now if a run is pending (and drop the pending one). */
  flush: () => void;
  /** Drop a pending run without calling the callback. */
  cancel: () => void;
};

/** How long the background-tab fallback waits. */
const FALLBACK_MS = 100;

export function createFrameScheduler(callback: () => void): FrameScheduler {
  let frame: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clear = () => {
    if (frame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
    if (timer !== null) clearTimeout(timer);
    frame = null;
    timer = null;
  };

  const run = () => {
    if (frame === null && timer === null) return;
    clear();
    callback();
  };

  return {
    schedule() {
      if (frame !== null || timer !== null) return;
      if (typeof requestAnimationFrame === "function") frame = requestAnimationFrame(run);
      timer = setTimeout(run, FALLBACK_MS);
    },
    flush: run,
    cancel: clear,
  };
}

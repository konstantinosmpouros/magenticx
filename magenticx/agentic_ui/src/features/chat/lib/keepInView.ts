/**
 * Keep an element where it is on screen across a layout change (plan 44):
 * opening the canvas narrows the chat column, every message above re-wraps,
 * and the chat would land somewhere else than where the user clicked. This
 * notes the clicked element's place, runs the change, then — for the next
 * frames, while the dock slides in and the column settles — scrolls the
 * chat's scroller by however far the element moved, so it stays put.
 *
 * The user scrolling (wheel, touch, keys) ends it at once: their scroll wins.
 */

/** How long the column takes to settle (the dock's 300 ms slide-in, with margin). */
const SETTLE_MS = 700;

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight)
      return node;
  }
  return null;
}

export function keepInView(anchor: HTMLElement | null | undefined, change: () => void): void {
  const scroller = anchor ? scrollParent(anchor) : null;
  if (!anchor || !scroller) {
    change();
    return;
  }
  const top = anchor.getBoundingClientRect().top;
  change();

  let stopped = false;
  const stop = () => {
    stopped = true;
    scroller.removeEventListener("wheel", stop);
    scroller.removeEventListener("touchstart", stop);
    scroller.removeEventListener("keydown", stop);
  };
  scroller.addEventListener("wheel", stop, { passive: true });
  scroller.addEventListener("touchstart", stop, { passive: true });
  scroller.addEventListener("keydown", stop);

  const start = performance.now();
  const step = () => {
    if (stopped || !anchor.isConnected) return stop();
    const moved = anchor.getBoundingClientRect().top - top;
    if (Math.abs(moved) >= 1) scroller.scrollTop += moved;
    if (performance.now() - start < SETTLE_MS) requestAnimationFrame(step);
    else stop();
  };
  requestAnimationFrame(step);
}

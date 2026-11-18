import { useEffect, useState, type RefObject } from "react";

/**
 * Whether the element in `ref` is narrower than `px`, kept current with a
 * ResizeObserver (the canvas is resized by dragging, not only the window).
 * False until measured, and where ResizeObserver is missing.
 */
export function useNarrowWidth(ref: RefObject<HTMLElement | null>, px: number): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const sizes = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? el.getBoundingClientRect().width;
      setNarrow(width > 0 && width < px);
    });
    sizes.observe(el);
    return () => sizes.disconnect();
  }, [ref, px]);
  return narrow;
}

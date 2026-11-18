import { useEffect, useRef } from "react";

/**
 * A ref for an element at the end of a list: when it scrolls into view (with
 * some margin, so the next page is usually there before the user reaches the
 * end), `onVisible` runs. The list's "Load more" button stays as the fallback
 * for browsers or tests without IntersectionObserver, and for keyboard users.
 */
export function useLoadMoreSentinel<T extends Element>(enabled: boolean, onVisible: () => void) {
  const ref = useRef<T | null>(null);
  const callbackRef = useRef(onVisible);
  callbackRef.current = onVisible;

  useEffect(() => {
    const node = ref.current;
    if (!enabled || !node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) callbackRef.current();
      },
      { rootMargin: "320px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled]);

  return ref;
}

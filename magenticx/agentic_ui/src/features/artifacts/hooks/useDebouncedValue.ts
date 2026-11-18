import { useEffect, useState } from "react";

/**
 * The value, once it has stopped changing for `delayMs` — so a search box asks
 * the bridge once per pause in typing, not once per keystroke.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

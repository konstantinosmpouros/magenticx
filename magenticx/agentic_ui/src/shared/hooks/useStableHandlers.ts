import { useLayoutEffect, useRef } from "react";

// Any function a handler map can hold. `never[]` parameters accept every
// function type, whatever its arguments.
type AnyHandler = (...args: never[]) => unknown;
type HandlerMap = Record<string, AnyHandler | undefined>;

/**
 * Stable stand-ins for a set of callbacks: each keeps one identity for the
 * component's lifetime and always calls the latest callback passed under its
 * name (plan 45, Phase 3).
 *
 * For handing callbacks to memoized children whose parent receives new
 * functions on every render (the workspace bundle rebuilds its handlers each
 * time): with the originals, `memo` never holds; with these it does, and a
 * child that skipped a render still calls the current handler, never a stale
 * one. A missing callback stays `undefined`, so a child that hides a control
 * when its handler is absent behaves exactly as before.
 *
 * Call the stand-ins from events and effects, not during render: the latest
 * callbacks are recorded after the render commits.
 */
export function useStableHandlers<T extends HandlerMap>(handlers: T): T {
  const latest = useRef(handlers);
  useLayoutEffect(() => {
    latest.current = handlers;
  });

  const stable = useRef<Partial<Record<keyof T, AnyHandler>>>({});
  const result = {} as Record<keyof T, AnyHandler | undefined>;
  for (const key of Object.keys(handlers) as (keyof T)[]) {
    if (!handlers[key]) {
      result[key] = undefined;
      continue;
    }
    let wrapper = stable.current[key];
    if (!wrapper) {
      wrapper = (...args: never[]) => (latest.current[key] as AnyHandler)(...args);
      stable.current[key] = wrapper;
    }
    result[key] = wrapper;
  }
  return result as T;
}

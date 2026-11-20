// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cardLayoutDependency,
  useCardLayoutWindow,
} from "@/features/automations/hooks/useCardLayoutWindow";

/**
 * The Automations cards' layout animation window (plan 45, Phase 6).
 *
 * Framer measures a layout-animated card on every render unless its
 * `layoutDependency` is unchanged, so the cards carry a constant one — no
 * measuring on the list's poll — and `undefined` for a moment after a change
 * the user made: a filter/search/sort/area change, or an action that arms it.
 */

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useCardLayoutWindow", () => {
  it("stays closed while nothing the user controls changes (a poll)", () => {
    const { result, rerender } = renderHook(({ key }) => useCardLayoutWindow(key), {
      initialProps: { key: "schedules|all||next" },
    });
    rerender({ key: "schedules|all||next" });
    expect(result.current.armed).toBe(false);
    expect(cardLayoutDependency(result.current.armed)).toBe("settled");
  });

  it("opens in the render where a filter changes, then closes", () => {
    const { result, rerender } = renderHook(({ key }) => useCardLayoutWindow(key), {
      initialProps: { key: "schedules|all||next" },
    });
    rerender({ key: "schedules|paused||next" });
    expect(result.current.armed).toBe(true);
    expect(cardLayoutDependency(result.current.armed)).toBeUndefined();

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.armed).toBe(false);
  });

  it("opens when an action arms it, and a second arming restarts the window", () => {
    const { result } = renderHook(() => useCardLayoutWindow("schedules|all||next"));
    act(() => result.current.arm());
    expect(result.current.armed).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    act(() => result.current.arm());
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.armed).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.armed).toBe(false);
  });
});

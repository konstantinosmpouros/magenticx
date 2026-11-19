// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { endsInOpenCodeFence } from "@/shared/lib/streaming-markdown";
import { CODE_FENCE_THROTTLE_MS, useCodeFenceThrottle } from "@/shared/hooks/useCodeFenceThrottle";

/**
 * Plan 45, Phase 3: a code block streaming in is re-highlighted (twice) on
 * every change of its text, so while the answer ends inside an open block its
 * text is handed on a few times a second instead of per token — never dropped.
 */
describe("endsInOpenCodeFence", () => {
  it("is true only inside a fence that has not closed", () => {
    expect(endsInOpenCodeFence("plain text")).toBe(false);
    expect(endsInOpenCodeFence("intro\n```ts\nconst a = 1;")).toBe(true);
    expect(endsInOpenCodeFence("```ts\nconst a = 1;\n```\nafter")).toBe(false);
    expect(endsInOpenCodeFence("~~~\ncode")).toBe(true);
    // An inline span is not a fence.
    expect(endsInOpenCodeFence("use `npm i` here")).toBe(false);
  });
});

describe("useCodeFenceThrottle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes prose through at once", () => {
    const { result, rerender } = renderHook(({ text }) => useCodeFenceThrottle(text, false), {
      initialProps: { text: "a" },
    });
    rerender({ text: "ab" });
    expect(result.current).toBe("ab");
  });

  it("holds an open code block back to one update per interval, then shows the newest text", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ text, hold }) => useCodeFenceThrottle(text, hold), {
      initialProps: { text: "```\nx", hold: false },
    });
    rerender({ text: "```\nx1", hold: true });
    rerender({ text: "```\nx12", hold: true });
    rerender({ text: "```\nx123", hold: true });
    // Nothing new yet within the interval…
    expect(result.current).toBe("```\nx");
    act(() => {
      vi.advanceTimersByTime(CODE_FENCE_THROTTLE_MS);
    });
    // …then the newest text, not an intermediate one.
    expect(result.current).toBe("```\nx123");
  });

  it("shows the full text at once when the block closes", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ text, hold }) => useCodeFenceThrottle(text, hold), {
      initialProps: { text: "```\nx", hold: true },
    });
    rerender({ text: "```\nx1", hold: true });
    rerender({ text: "```\nx1\n```", hold: false });
    expect(result.current).toBe("```\nx1\n```");
  });
});

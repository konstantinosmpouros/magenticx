// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

import { nextLiveThinkingState, patchRowById } from "@/features/inference/runState";
import { useKeyboardShortcuts } from "@/features/chat/hooks/useKeyboardShortcuts";
import type { ThinkingState } from "@/shared/lib/types";

/**
 * Plan 45, Phase 2: a run event arrives about once per streamed token, so the
 * state it touches must keep its identity when the event changes nothing —
 * otherwise every token re-renders the sidebar and every message.
 */
describe("patchRowById", () => {
  const rows = [
    { id: "a", activeRunId: null as string | null, isStreaming: false },
    { id: "b", activeRunId: "r1" as string | null, isStreaming: true },
  ];

  it("keeps the same list when the patched fields already match", () => {
    expect(patchRowById(rows, "b", { activeRunId: "r1", isStreaming: true })).toBe(rows);
  });

  it("keeps the same list when no row has the id", () => {
    expect(patchRowById(rows, "zzz", { isStreaming: true })).toBe(rows);
  });

  it("replaces only the changed row", () => {
    const next = patchRowById(rows, "a", { activeRunId: "r2", isStreaming: true });
    expect(next).not.toBe(rows);
    expect(next[0]).toEqual({ id: "a", activeRunId: "r2", isStreaming: true });
    expect(next[1]).toBe(rows[1]);
  });
});

describe("nextLiveThinkingState", () => {
  const base: ThinkingState = {
    messageId: "m1",
    thoughts: ["one", "two"],
    currentThoughtIndex: 1,
    isActive: true,
    isDone: false,
    startTime: 1000,
    branchPath: ["u1", "m1"],
  };

  it("keeps the previous object when an equal state is rebuilt", () => {
    const rebuilt = { ...base, thoughts: [...base.thoughts], branchPath: [...base.branchPath!] };
    expect(nextLiveThinkingState(base, rebuilt)).toBe(base);
  });

  it("takes the new state when a thought arrives", () => {
    const next = { ...base, thoughts: ["one", "two", "three"], currentThoughtIndex: 2 };
    expect(nextLiveThinkingState(base, next)).toBe(next);
  });

  it("takes the new state when a thought's text changes", () => {
    const next = { ...base, thoughts: ["one", "two and more"] };
    expect(nextLiveThinkingState(base, next)).toBe(next);
  });

  it("takes the new state for another message or with no previous state", () => {
    const other = { ...base, messageId: "m2" };
    expect(nextLiveThinkingState(base, other)).toBe(other);
    expect(nextLiveThinkingState(null, base)).toBe(base);
  });
});

describe("useKeyboardShortcuts", () => {
  it("registers its listeners once and still calls the latest action", () => {
    const add = vi.spyOn(window, "addEventListener");
    const first = vi.fn();
    const second = vi.fn();
    const context = { canTogglePrivateMode: false };
    const { rerender } = renderHook(
      ({ action }) =>
        useKeyboardShortcuts({ actions: { "ui.escape": action }, context: { ...context } }),
      { initialProps: { action: first } },
    );
    const keydownAdds = () => add.mock.calls.filter(([type]) => type === "keydown").length;
    const afterMount = keydownAdds();
    rerender({ action: second });
    rerender({ action: second });
    expect(keydownAdds()).toBe(afterMount);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    add.mockRestore();
  });
});

// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useWorkspaceSearch } from "@/features/search/handlers/search";
import type { WorkspaceSearchResult } from "@/shared/lib/types";

/**
 * Workspace search (plan 45, Phase 5): typing on aborts the request still in
 * flight instead of merely ignoring its answer, so the browser drops the
 * connection and an older, slower answer can never land over a newer one.
 */

const { searchWorkspace } = vi.hoisted(() => ({ searchWorkspace: vi.fn() }));
vi.mock("@/shared/lib/api", () => ({ searchWorkspace }));

const result = (title: string) =>
  ({ kind: "conversation", id: title, conversationId: title, title }) as WorkspaceSearchResult;

type Call = { query: string; signal: AbortSignal; resolve: (r: WorkspaceSearchResult[]) => void };

describe("useWorkspaceSearch", () => {
  let calls: Call[];

  beforeEach(() => {
    vi.useFakeTimers();
    calls = [];
    searchWorkspace.mockReset();
    searchWorkspace.mockImplementation(
      (_user: string, query: string, _limit: number, signal: AbortSignal) =>
        new Promise<WorkspaceSearchResult[]>((resolve) => calls.push({ query, signal, resolve })),
    );
  });
  afterEach(() => vi.useRealTimers());

  it("aborts the previous request when the query changes", async () => {
    const { result: hook } = renderHook(() => useWorkspaceSearch({ userId: "u1" }));
    act(() => hook.current.openSearchPanel());
    act(() => hook.current.setSearchQuery("pla"));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(calls).toHaveLength(1);
    expect(calls[0].signal.aborted).toBe(false);

    act(() => hook.current.setSearchQuery("plan"));
    expect(calls[0].signal.aborted).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ query: "plan" });

    // The aborted request answering late changes nothing.
    await act(async () => calls[0].resolve([result("stale")]));
    expect(hook.current.searchResults).toEqual([]);
    expect(hook.current.searchLoading).toBe(true);

    await act(async () => calls[1].resolve([result("fresh")]));
    expect(hook.current.searchResults).toEqual([result("fresh")]);
    expect(hook.current.searchLoading).toBe(false);
  });

  it("sends nothing for keystrokes inside the debounce, and aborts on close", async () => {
    const { result: hook } = renderHook(() => useWorkspaceSearch({ userId: "u1" }));
    act(() => hook.current.openSearchPanel());
    act(() => hook.current.setSearchQuery("a"));
    await act(async () => vi.advanceTimersByTimeAsync(100));
    act(() => hook.current.setSearchQuery("ab"));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(calls.map((call) => call.query)).toEqual(["ab"]);

    act(() => hook.current.closeSearchPanel());
    expect(calls[0].signal.aborted).toBe(true);
  });
});

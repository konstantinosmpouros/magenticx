// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAutomations } from "@/features/automations/hooks/useAutomations";
import {
  WORKFLOWS_VISIBLE_RELOAD_MIN_MS,
  useWorkflows,
} from "@/features/workflows/hooks/useWorkflows";
import type { ScheduledTask } from "@/shared/lib/types";
import { useWorkspaceStore } from "@/shared/stores/workspaceStore";

/**
 * Background polling (plan 45, Phase 5): a hidden tab polls nothing and
 * catches up when it is shown again; a poll that brings nothing new keeps the
 * same array, so it re-renders nothing; and the workflow list reloads on a
 * tab return at most once per 30 s instead of on every return.
 */

const api = vi.hoisted(() => ({
  listScheduledTasks: vi.fn(),
  createScheduledTask: vi.fn(),
  deleteScheduledTask: vi.fn(),
  updateScheduledTask: vi.fn(),
  listWorkflows: vi.fn(),
}));
vi.mock("@/shared/lib/api", () => api);

const ACTIVE_POLL_MS = 8000;
const BACKGROUND_POLL_MS = 60000;

let hidden = false;
const setHidden = (value: boolean) => {
  hidden = value;
  document.dispatchEvent(new Event("visibilitychange"));
};

const task = (id: string, status = "active") =>
  ({ id, name: `task ${id}`, status, schedule: "0 * * * *" }) as unknown as ScheduledTask;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
  // Fresh objects on every poll, as off the wire.
  api.listScheduledTasks.mockImplementation(async () => [task("t1"), task("t2")]);
  api.listWorkflows.mockResolvedValue([]);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useAutomations polling", () => {
  it("polls nothing while the tab is hidden, and catches up when it is shown", async () => {
    hidden = true;
    renderHook(() => useAutomations({ userId: "u1", active: false }));
    await act(async () => vi.advanceTimersByTimeAsync(BACKGROUND_POLL_MS * 3));
    expect(api.listScheduledTasks).not.toHaveBeenCalled();

    await act(async () => setHidden(false));
    expect(api.listScheduledTasks).toHaveBeenCalledTimes(1);
  });

  it("stops polling when the tab is hidden mid-session, and does not double-poll on return", async () => {
    renderHook(() => useAutomations({ userId: "u1", active: true }));
    await act(async () => {});
    expect(api.listScheduledTasks).toHaveBeenCalledTimes(1);

    await act(async () => setHidden(true));
    await act(async () => vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * 5));
    expect(api.listScheduledTasks).toHaveBeenCalledTimes(1);

    // Back after a missed tick: one catch-up poll, then the cadence resumes.
    await act(async () => setHidden(false));
    expect(api.listScheduledTasks).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS));
    expect(api.listScheduledTasks).toHaveBeenCalledTimes(3);

    // A quick hide-and-show inside one interval polls nothing extra.
    await act(async () => setHidden(true));
    await act(async () => setHidden(false));
    expect(api.listScheduledTasks).toHaveBeenCalledTimes(3);
  });

  it("keeps the same list when a poll brings nothing new, and swaps it when it does", async () => {
    const { result } = renderHook(() => useAutomations({ userId: "u1", active: true }));
    await act(async () => {});
    const first = result.current.items;
    expect(first).toHaveLength(2);

    await act(async () => vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS));
    expect(api.listScheduledTasks).toHaveBeenCalledTimes(2);
    expect(result.current.items).toBe(first);

    api.listScheduledTasks.mockImplementation(async () => [task("t1", "paused"), task("t2")]);
    await act(async () => vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS));
    expect(result.current.items).not.toBe(first);
    expect(result.current.items[0].task).toMatchObject({ status: "paused" });
  });
});

describe("useWorkflows tab-return reload", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ userId: "u1", pendingDeletion: null });
  });

  it("reloads on a tab return at most once per 30 s", async () => {
    renderHook(() => useWorkflows());
    await act(async () => {});
    expect(api.listWorkflows).toHaveBeenCalledTimes(1);

    // Back after 5 s: too soon.
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    await act(async () => setHidden(true));
    await act(async () => setHidden(false));
    expect(api.listWorkflows).toHaveBeenCalledTimes(1);

    // Back after the window: one reload, and an immediate second return adds none.
    await act(async () => vi.advanceTimersByTimeAsync(WORKFLOWS_VISIBLE_RELOAD_MIN_MS));
    await act(async () => setHidden(true));
    await act(async () => setHidden(false));
    await act(async () => setHidden(true));
    await act(async () => setHidden(false));
    expect(api.listWorkflows).toHaveBeenCalledTimes(2);
  });
});

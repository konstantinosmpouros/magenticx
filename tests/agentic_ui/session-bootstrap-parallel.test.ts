// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAuthRehydrateEffect } from "@/features/auth/hooks/useSessionEffects";

/**
 * The start-up bootstrap (plan 45, Phase 5). It used to be a waterfall —
 * restore, then the IndexedDB snapshot, then five catalogs, then
 * `authResolved`, and only then the deep-linked conversation. Now the snapshot
 * is read while the restore is in flight (under the stored user id, discarded
 * if the restored user is someone else), and `sessionReady` goes up straight
 * after the restore so the route's detail loads in parallel with the catalogs.
 */

const api = vi.hoisted(() => ({
  restoreSessionWhenReachable: vi.fn(),
  getAgents: vi.fn(),
  getTools: vi.fn(),
  getUserPreferences: vi.fn(),
  getSidebarConversations: vi.fn(),
}));
vi.mock("@/shared/lib/api", () => api);

const auth = vi.hoisted(() => ({
  loadSession: vi.fn(),
  clearSession: vi.fn(),
  updateSession: vi.fn(),
  saveSession: vi.fn(),
}));
vi.mock("@/shared/lib/authStorage", () => auth);

const ui = vi.hoisted(() => ({ loadUISnapshot: vi.fn(), saveUISnapshot: vi.fn() }));
vi.mock("@/shared/lib/uiStateStorage", () => ui);

vi.mock("@/shared/lib/sessionRefresh", () => ({
  ensureFreshSession: vi.fn(),
  sessionRetryDelay: vi.fn(() => 1000),
}));

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const snapshotFor = (selectedAgent: string) => ({
  version: 5,
  selectedAgent,
  isPrivateMode: false,
  activeProfileTab: "general",
  sidebarOpen: true,
  lastConversationId: null,
  agents: [],
  conversations: [],
  availableTools: [],
  myRegistrySkills: [],
  userPreferences: { suggestionsEnabled: true },
});

const restoredAs = (id: string, extra: Record<string, unknown> = {}) => ({
  authenticated: true,
  user: { id, username: id },
  tokenTtl: 3600,
  ...extra,
});

const mount = () => {
  const setters = {
    setIsLoggedIn: vi.fn(),
    setUserId: vi.fn(),
    setUserProfile: vi.fn(),
    setAuthResolved: vi.fn(),
    setSessionReady: vi.fn(),
    setPendingDeletion: vi.fn(),
    setAgents: vi.fn(),
    setAvailableTools: vi.fn(),
    setMyRegistrySkills: vi.fn(),
    setUserPreferences: vi.fn(),
    setConversations: vi.fn(),
    setConversationsLoading: vi.fn(),
    setLoadingConversation: vi.fn(),
    setSelectedAgent: vi.fn(),
    setIsPrivateMode: vi.fn(),
    setActiveProfileTab: vi.fn(),
    setSidebarOpen: vi.fn(),
    persistUIState: vi.fn(),
    toast: vi.fn(),
  };
  renderHook(() => useAuthRehydrateEffect(setters));
  return setters;
};

describe("session bootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.loadSession.mockReturnValue({ userId: "u1" });
    ui.loadUISnapshot.mockResolvedValue(snapshotFor("agent-u1"));
    api.getAgents.mockResolvedValue([]);
    api.getTools.mockResolvedValue([]);
    api.getUserPreferences.mockResolvedValue({});
    api.getSidebarConversations.mockResolvedValue([]);
  });

  it("reads the stored user's snapshot while the restore is still in flight", async () => {
    const restore = deferred<unknown>();
    api.restoreSessionWhenReachable.mockReturnValue(restore.promise);

    mount();
    await act(async () => {});

    expect(ui.loadUISnapshot).toHaveBeenCalledWith("u1");
    expect(api.restoreSessionWhenReachable).toHaveBeenCalled();
    await act(async () => restore.resolve(restoredAs("u1")));
    // The early read is reused, not repeated.
    expect(ui.loadUISnapshot).toHaveBeenCalledTimes(1);
  });

  it("raises sessionReady before the catalogs land, and authResolved after them", async () => {
    api.restoreSessionWhenReachable.mockResolvedValue(restoredAs("u1"));
    const agents = deferred<unknown[]>();
    api.getAgents.mockReturnValue(agents.promise);

    const s = mount();
    await act(async () => {});

    expect(s.setSessionReady).toHaveBeenCalledWith(true);
    expect(s.setAuthResolved).not.toHaveBeenCalled();
    // The snapshot's remembered agent is applied before the route may load,
    // so the conversation's own agent always lands after it.
    expect(s.setSelectedAgent).toHaveBeenCalledWith("agent-u1");
    expect(s.setSelectedAgent.mock.invocationCallOrder[0]).toBeLessThan(
      s.setSessionReady.mock.invocationCallOrder[0],
    );

    await act(async () => agents.resolve([]));
    expect(s.setAuthResolved).toHaveBeenCalledWith(true);
    // The route owns the loading flag now; the bootstrap must not clear it
    // under a detail request that is already under way.
    expect(s.setLoadingConversation).not.toHaveBeenCalled();
  });

  it("discards the early snapshot when the restored session is another user's", async () => {
    auth.loadSession.mockReturnValue({ userId: "old-user" });
    ui.loadUISnapshot.mockImplementation(async (id: string) =>
      snapshotFor(id === "old-user" ? "agent-of-old-user" : "agent-of-new-user"),
    );
    api.restoreSessionWhenReachable.mockResolvedValue(restoredAs("new-user"));

    const s = mount();
    await act(async () => {});

    expect(ui.loadUISnapshot.mock.calls.map(([id]) => id)).toEqual(["old-user", "new-user"]);
    expect(s.setSelectedAgent).toHaveBeenCalledWith("agent-of-new-user");
    expect(s.setSelectedAgent).not.toHaveBeenCalledWith("agent-of-old-user");
  });

  it("never raises sessionReady for an account awaiting deletion", async () => {
    api.restoreSessionWhenReachable.mockResolvedValue(
      restoredAs("u1", { pendingDeletion: { scheduledFor: "2026-12-01T00:00:00Z" } }),
    );

    const s = mount();
    await act(async () => {});

    expect(s.setAuthResolved).toHaveBeenCalledWith(true);
    expect(s.setSessionReady).not.toHaveBeenCalledWith(true);
    expect(api.getAgents).not.toHaveBeenCalled();
  });

  it("raises nothing but authResolved when there is no session", async () => {
    api.restoreSessionWhenReachable.mockResolvedValue({ authenticated: false });

    const s = mount();
    await act(async () => {});

    expect(s.setAuthResolved).toHaveBeenCalledWith(true);
    expect(s.setSessionReady).not.toHaveBeenCalledWith(true);
    expect(s.setIsLoggedIn).toHaveBeenCalledWith(false);
  });
});

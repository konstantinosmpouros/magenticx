// @vitest-environment happy-dom
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useConversationRouting } from "@/features/chat/hooks/useConversationRouting";
import {
  PREFETCH_HOVER_INTENT_MS,
  usePrefetchConversation,
} from "@/features/chat/hooks/usePrefetchConversation";
import {
  CONVERSATION_DETAIL_CACHE_MAX,
  conversationDetailKey,
} from "@/features/chat/lib/conversationDetailCache";
import type { ConversationDetail } from "@/shared/lib/types";

/**
 * Conversation detail loading (plan 45, Phase 5): a per-user cache of recently
 * opened details, so reopening a conversation seen in the last 30 s paints at
 * once (no loading overlay) and revalidates quietly; a deep link that starts
 * loading as soon as the session is restored; and a hover prefetch that sends
 * at most one request however fast the pointer sweeps the sidebar.
 */

const { getConversationDetail } = vi.hoisted(() => ({ getConversationDetail: vi.fn() }));
vi.mock("@/shared/lib/api", () => ({ getConversationDetail }));

const detail = (id: string, title = `title-${id}`) =>
  ({
    id,
    title,
    agent: { id: `agent-${id}` },
    isPrivate: false,
    messages: [],
  }) as unknown as ConversationDetail;

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const T0 = new Date("2026-11-20T10:00:00Z").getTime();

const wrapperFor = (client: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };

type RouteProps = { conversationId?: string; authResolved?: boolean; sessionReady?: boolean };

/**
 * The routing hook over a tiny stand-in for the workspace store: the shown
 * conversation is fed back as `currentConversation` on every render, and the
 * setter accepts an updater like the real store's does.
 */
const mountRouting = (client: QueryClient, initialProps: RouteProps) => {
  let shown: ConversationDetail | null = null;
  const spies = {
    navigate: vi.fn(),
    setCurrentConversation: vi.fn(
      (v: ConversationDetail | null | ((p: ConversationDetail | null) => ConversationDetail | null)) => {
        shown = typeof v === "function" ? v(shown) : v;
      },
    ),
    setSelectedAgent: vi.fn(),
    setIsPrivateMode: vi.fn(),
    setInactiveAgentFallback: vi.fn(),
    setLoadingConversation: vi.fn(),
    setThinkingState: vi.fn(),
    setExpandedThinking: vi.fn(),
    setAttachments: vi.fn(),
    setCurrentMessage: vi.fn(),
    setBranchSelections: vi.fn(),
    closeVoiceSession: vi.fn(),
    deriveBranchSelectionsForActiveRun: vi.fn(() => null),
    requestPersist: vi.fn(),
    toast: vi.fn(),
  };
  const view = renderHook(
    (p: RouteProps) =>
      useConversationRouting({
        ...spies,
        navigate: spies.navigate as never,
        conversationId: p.conversationId,
        isPageRoute: false,
        authResolved: p.authResolved ?? true,
        sessionReady: p.sessionReady,
        isLoggedIn: true,
        userId: "u1",
        currentConversation: shown,
        agents: [],
        selectedAgent: "",
      }),
    { initialProps, wrapper: wrapperFor(client) },
  );
  return {
    spies,
    shown: () => shown,
    /** Navigate to another route, the way the URL would. */
    go: (conversationId: string | undefined) => view.rerender({ conversationId }),
    rerender: view.rerender,
  };
};

const overlayRaised = (setLoading: ReturnType<typeof vi.fn>) =>
  setLoading.mock.calls.some(([value]) => value === true);

describe("conversation detail cache", () => {
  let client: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    client = new QueryClient();
    getConversationDetail.mockReset();
    getConversationDetail.mockImplementation(async (_user: string, id: string) => detail(id));
  });
  afterEach(() => {
    client.clear();
    vi.useRealTimers();
  });

  /** Open c1, then c2: c1 is now a conversation "seen a moment ago". */
  const openC1ThenC2 = async () => {
    const h = mountRouting(client, { conversationId: "c1" });
    await act(async () => {});
    h.go("c2");
    await act(async () => {});
    expect(h.shown()?.id).toBe("c2");
    h.spies.setLoadingConversation.mockClear();
    getConversationDetail.mockClear();
    return h;
  };

  it("paints a conversation reopened within 30 s at once, with no overlay", async () => {
    const h = await openC1ThenC2();
    vi.setSystemTime(T0 + 2_000);

    h.go("c1");

    // Painted during the navigation itself, not after a request.
    expect(h.shown()?.id).toBe("c1");
    expect(overlayRaised(h.spies.setLoadingConversation)).toBe(false);
    expect(h.spies.setSelectedAgent).toHaveBeenLastCalledWith("agent-c1");
    await act(async () => {});
    // Fetched two seconds ago: not asked for again.
    expect(getConversationDetail).not.toHaveBeenCalled();
  });

  it("revalidates an older cached copy in the background and swaps it in", async () => {
    const h = await openC1ThenC2();
    vi.setSystemTime(T0 + 10_000);
    getConversationDetail.mockResolvedValueOnce(detail("c1", "renamed elsewhere"));

    h.go("c1");
    expect(h.shown()?.title).toBe("title-c1");
    await act(async () => {});

    expect(getConversationDetail).toHaveBeenCalledWith("u1", "c1");
    expect(h.shown()?.title).toBe("renamed elsewhere");
    expect(overlayRaised(h.spies.setLoadingConversation)).toBe(false);
  });

  it("never lets the revalidation overwrite a send that started on top of the cached copy", async () => {
    const h = await openC1ThenC2();
    vi.setSystemTime(T0 + 10_000);
    const fresh = deferred<ConversationDetail>();
    getConversationDetail.mockReturnValueOnce(fresh.promise);

    h.go("c1");
    // The user sends before the background read lands.
    const withSend = { ...h.shown()!, messages: [{ id: "temp-1" }] } as unknown as ConversationDetail;
    h.spies.setCurrentConversation(withSend);
    await act(async () => {
      fresh.resolve(detail("c1", "server copy"));
    });

    expect(h.shown()).toBe(withSend);
  });

  it("does not serve a conversation that changed on screen before the user left it", async () => {
    const h = mountRouting(client, { conversationId: "c1" });
    await act(async () => {});
    // A streamed answer replaced the shown object.
    h.spies.setCurrentConversation({
      ...h.shown()!,
      messages: [{ id: "m-1" }],
    } as unknown as ConversationDetail);
    h.go("c2");
    await act(async () => {});
    h.spies.setLoadingConversation.mockClear();
    getConversationDetail.mockClear();

    h.go("c1");
    await act(async () => {});

    expect(overlayRaised(h.spies.setLoadingConversation)).toBe(true);
    expect(getConversationDetail).toHaveBeenCalledWith("u1", "c1");
  });

  it("loads an entry older than 30 s the normal way", async () => {
    const h = await openC1ThenC2();
    vi.setSystemTime(T0 + 31_000);

    h.go("c1");
    await act(async () => {});

    expect(overlayRaised(h.spies.setLoadingConversation)).toBe(true);
    expect(getConversationDetail).toHaveBeenCalledTimes(1);
  });

  it("does not serve a copy fetched while a run was streaming in it", async () => {
    getConversationDetail.mockImplementation(async (_user: string, id: string) =>
      id === "c1" ? { ...detail("c1"), activeRunId: "run-1", isStreaming: true } : detail(id),
    );
    const h = await openC1ThenC2();

    h.go("c1");
    await act(async () => {});

    expect(overlayRaised(h.spies.setLoadingConversation)).toBe(true);
    expect(getConversationDetail).toHaveBeenCalledTimes(1);
  });

  it("starts a deep link's detail as soon as the session is restored, once", async () => {
    const h = mountRouting(client, {
      conversationId: "c1",
      authResolved: false,
      sessionReady: false,
    });
    await act(async () => {});
    expect(getConversationDetail).not.toHaveBeenCalled();

    // Session restored; the catalogs are still loading (authResolved false).
    h.rerender({ conversationId: "c1", authResolved: false, sessionReady: true });
    await act(async () => {});
    expect(getConversationDetail).toHaveBeenCalledWith("u1", "c1");
    expect(h.shown()?.id).toBe("c1");

    // The catalogs land: no second request.
    h.rerender({ conversationId: "c1", authResolved: true, sessionReady: true });
    await act(async () => {});
    expect(getConversationDetail).toHaveBeenCalledTimes(1);
  });

  it("keys every entry by user and keeps a bounded number of them", async () => {
    const h = mountRouting(client, { conversationId: "c0" });
    await act(async () => {});
    for (let i = 1; i <= CONVERSATION_DETAIL_CACHE_MAX + 3; i += 1) {
      vi.setSystemTime(T0 + i * 100);
      h.go(`c${i}`);
      await act(async () => {});
    }

    const entries = client.getQueryCache().findAll({ queryKey: ["conversation", "u1"] });
    expect(entries).toHaveLength(CONVERSATION_DETAIL_CACHE_MAX);
    expect(client.getQueryData(conversationDetailKey("u1", "c0"))).toBeUndefined();
  });
});

describe("prefetchConversation (sidebar hover intent)", () => {
  let client: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers();
    client = new QueryClient();
    getConversationDetail.mockReset();
    getConversationDetail.mockImplementation(async (_user: string, id: string) => detail(id));
  });
  afterEach(() => {
    client.clear();
    vi.useRealTimers();
  });

  const mountPrefetch = (userId: string | null = "u1") =>
    renderHook(
      (p: { userId: string | null }) =>
        usePrefetchConversation({
          userId: p.userId,
          canPrefetch: (id) => id.startsWith("c"),
        }),
      { initialProps: { userId }, wrapper: wrapperFor(client) },
    );

  it("sends one request for a sweep over twenty rows: the row the pointer rests on", async () => {
    const { result } = mountPrefetch();

    for (let i = 0; i < 20; i += 1) {
      result.current(`c${i}`);
      await vi.advanceTimersByTimeAsync(20);
    }
    await vi.advanceTimersByTimeAsync(PREFETCH_HOVER_INTENT_MS);

    expect(getConversationDetail).toHaveBeenCalledTimes(1);
    expect(getConversationDetail).toHaveBeenCalledWith("u1", "c19");
    expect(client.getQueryData(conversationDetailKey("u1", "c19"))).toMatchObject({ id: "c19" });
  });

  it("does not ask again for a row that is fresh in the cache", async () => {
    const { result } = mountPrefetch();
    result.current("c1");
    await vi.advanceTimersByTimeAsync(PREFETCH_HOVER_INTENT_MS);
    result.current("c1");
    await vi.advanceTimersByTimeAsync(PREFETCH_HOVER_INTENT_MS);

    expect(getConversationDetail).toHaveBeenCalledTimes(1);
  });

  it("only prefetches the user's own conversations, and never without a user", async () => {
    const { result, rerender } = mountPrefetch();
    result.current("foreign-1");
    await vi.advanceTimersByTimeAsync(PREFETCH_HOVER_INTENT_MS);
    result.current("shared:tok");
    await vi.advanceTimersByTimeAsync(PREFETCH_HOVER_INTENT_MS);

    rerender({ userId: null });
    result.current("c1");
    await vi.advanceTimersByTimeAsync(PREFETCH_HOVER_INTENT_MS);

    expect(getConversationDetail).not.toHaveBeenCalled();
  });

  it("drops a pending hover when the account changes", async () => {
    const { result, rerender } = mountPrefetch("u1");
    result.current("c1");
    rerender({ userId: "u2" });
    await vi.advanceTimersByTimeAsync(PREFETCH_HOVER_INTENT_MS);

    expect(getConversationDetail).not.toHaveBeenCalled();
  });

  it("hands the routing a request already in flight instead of a second one", async () => {
    const pending = deferred<ConversationDetail>();
    getConversationDetail.mockReturnValueOnce(pending.promise);
    const prefetch = mountPrefetch();
    prefetch.result.current("c1");
    await vi.advanceTimersByTimeAsync(PREFETCH_HOVER_INTENT_MS);
    expect(getConversationDetail).toHaveBeenCalledTimes(1);

    // The click lands while the hover's request is still out.
    const h = mountRouting(client, { conversationId: "c1" });
    await act(async () => {
      pending.resolve(detail("c1"));
    });

    expect(getConversationDetail).toHaveBeenCalledTimes(1);
    expect(h.shown()?.id).toBe("c1");
  });
});

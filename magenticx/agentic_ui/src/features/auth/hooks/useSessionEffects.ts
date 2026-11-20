import { useEffect, useRef, useCallback, useMemo } from "react";
import type {
  Agent,
  ConversationDetail,
  ConversationSummary,
  PendingDeletion,
  ToolMetadata,
  UserPreferences,
  UserProfile,
  UserSkill,
} from "@/shared/lib/types";
import { loadSession, clearSession, updateSession, saveSession } from "@/shared/lib/authStorage";
import {
  loadUISnapshot,
  saveUISnapshot,
  UISnapshotSerializable,
} from "@/shared/lib/uiStateStorage";
import {
  getAgents,
  getSidebarConversations,
  getTools,
  getUserPreferences,
  restoreSessionWhenReachable,
} from "@/shared/lib/api";
import { ensureFreshSession, sessionRetryDelay } from "@/shared/lib/sessionRefresh";
import { sortByUpdatedAtDesc } from "@/shared/lib/utils";
import { CONV_INITIAL_PAGE_SIZE } from "@/shared/lib/consts";

// ---------------------------------------------------------------------------
// Initial session state helper
// ---------------------------------------------------------------------------
export function useInitialSessionState() {
  const initialSession = typeof window !== "undefined" ? loadSession() : null;
  const initialUserId = initialSession?.userId ?? null;
  const initialUserProfile = initialSession?.user ?? null;
  const initialLoggedIn = false;
  return { initialUserId, initialUserProfile, initialLoggedIn };
}

/**
 * Read a user's IndexedDB UI snapshot, never rejecting: a broken or blocked
 * store only means the first frame paints without it (the bootstrap fetches
 * repopulate everything), so a failure is logged and read as "no snapshot".
 */
const readUISnapshot = (userId: string): Promise<UISnapshotSerializable | null> =>
  loadUISnapshot(userId).catch((error) => {
    console.error("Failed to hydrate from snapshot", error);
    return null;
  });

// ---------------------------------------------------------------------------
// Auth rehydrate effect
// ---------------------------------------------------------------------------
/**
 * Restore the session on page load and bootstrap the workspace.
 *
 * Ordered for the shortest path to a painted conversation (plan 45, Phase 5):
 * the IndexedDB snapshot is read while `restoreSession` is in flight (under
 * the stored user id, and thrown away if the restored session is someone
 * else's); `sessionReady` goes up straight after the restore, so the route's
 * conversation detail loads in parallel with the five catalogs; and
 * `authResolved` goes up once those are in. An account awaiting deletion
 * never gets `sessionReady`: its session is frozen and nothing may load.
 */
export function useAuthRehydrateEffect(params: {
  setIsLoggedIn: (v: boolean) => void;
  setUserId: (v: string | null) => void;
  setUserProfile: (v: UserProfile | null) => void;
  setAuthResolved?: (v: boolean) => void;
  /** Lets the route start loading its conversation before the catalogs land. */
  setSessionReady?: (v: boolean) => void;
  setPendingDeletion?: (v: PendingDeletion | null) => void;
  setAgents: (v: any) => void;
  setAvailableTools?: (v: ToolMetadata[]) => void;
  setMyRegistrySkills?: (v: UserSkill[]) => void;
  setUserPreferences?: (v: UserPreferences | null) => void;
  setConversations: (v: any) => void;
  setConversationsLoading?: (v: boolean) => void;
  setCurrentConversation?: (v: ConversationDetail | null) => void;
  setLoadingConversation?: (v: boolean) => void;
  setSelectedAgent?: (v: string) => void;
  setIsPrivateMode?: (v: boolean) => void;
  setActiveProfileTab?: (v: string) => void;
  setSidebarOpen?: (v: boolean) => void;
  persistUIState?: () => void;
  toast?: (opts: {
    title: string;
    description?: string;
    variant?: string;
    duration?: number;
  }) => void;
}) {
  const {
    setIsLoggedIn,
    setUserId,
    setUserProfile,
    setAuthResolved,
    setSessionReady,
    setPendingDeletion,
    setAgents,
    setAvailableTools,
    setMyRegistrySkills,
    setUserPreferences,
    setConversations,
    setConversationsLoading,
    setLoadingConversation,
    setSelectedAgent,
    setIsPrivateMode,
    setActiveProfileTab,
    setSidebarOpen,
    persistUIState,
    toast,
  } = params;
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const run = async () => {
      try {
        const existing = loadSession();
        // Start reading the stored user's snapshot now, alongside the restore
        // (plan 45): IndexedDB is local and the restore is a network round trip,
        // so the snapshot is normally ready by the time the restore answers.
        // Only used if the restore names the same user (checked below).
        const earlySnapshot = existing?.userId ? readUISnapshot(existing.userId) : null;
        // Retried until the bridge answers, with the loader still up. A tab
        // restored at browser start (or reloaded right after waking) often runs
        // this before the network is back; giving up then would send a user with
        // a valid session to the login screen.
        const restored = await restoreSessionWhenReachable({
          onUnreachable: () =>
            toast?.({
              title: "Can't reach the server",
              description: "You'll be signed back in as soon as the connection returns.",
              variant: "warning",
              duration: 5000,
            }),
        });

        if (!restored?.authenticated || !restored.user || !restored.user.id) {
          clearSession();
          setIsLoggedIn(false);
          setUserId(null);
          setUserProfile(null);
          setAgents([]);
          setAvailableTools?.([]);
          setUserPreferences?.(null);
          setConversations([]);
          setConversationsLoading?.(false);
          setLoadingConversation?.(false);
          setAuthResolved?.(true);
          return;
        }

        const ttlMs =
          typeof restored.tokenTtl === "number" && restored.tokenTtl > 0
            ? restored.tokenTtl * 1000
            : 60 * 60 * 1000;
        saveSession(restored.user, ttlMs);
        // Only carry the previous session's UI position forward when it belongs
        // to the SAME user. After a server-side session swap (adding an account
        // through the OIDC callback) localStorage still describes the previous
        // account, and inheriting its last conversation id would have the new
        // account try to open someone else's chat.
        if (existing && existing.userId === restored.user.id) {
          updateSession({
            lastConversationId: existing.lastConversationId,
            selectedAgent: existing.selectedAgent,
            isPrivateMode: existing.isPrivateMode,
          });
        }

        setIsLoggedIn(true);
        setUserId(restored.user.id);
        setUserProfile(restored.user);

        // The account awaits deletion (plan 32): the session is frozen — every
        // workspace call would answer 403 — so load nothing. The shell shows the
        // pending screen, which offers only cancel, download and sign out.
        setPendingDeletion?.(restored.pendingDeletion ?? null);
        if (restored.pendingDeletion) {
          setAuthResolved?.(true);
          return;
        }
        setConversationsLoading?.(true);

        let hasSnapshotAgents = false;
        const needsTools = Boolean(setAvailableTools);
        let needsPreferences = Boolean(setUserPreferences);
        let needsConversations = true;

        try {
          // The early read was under the stored id; after a server-side session
          // swap (an account added through the OIDC callback) that is another
          // user's snapshot, so it is discarded and this user's is read instead.
          const snapshot = await (earlySnapshot && existing?.userId === restored.user.id
            ? earlySnapshot
            : readUISnapshot(restored.user.id));
          if (snapshot) {
            if (typeof snapshot.selectedAgent === "string" && setSelectedAgent) {
              setSelectedAgent(snapshot.selectedAgent);
            }
            if (typeof snapshot.isPrivateMode === "boolean" && setIsPrivateMode) {
              setIsPrivateMode(snapshot.isPrivateMode);
            }
            if (typeof snapshot.sidebarOpen === "boolean" && setSidebarOpen) {
              setSidebarOpen(snapshot.sidebarOpen);
            }
            if (snapshot.activeProfileTab && setActiveProfileTab)
              setActiveProfileTab(snapshot.activeProfileTab);

            setAgents(snapshot.agents ?? []);
            hasSnapshotAgents = Boolean(snapshot.agents && snapshot.agents.length > 0);
            if (setAvailableTools) setAvailableTools(snapshot.availableTools ?? []);
            if (setMyRegistrySkills) setMyRegistrySkills(snapshot.myRegistrySkills ?? []);
            if (setUserPreferences) setUserPreferences(snapshot.userPreferences ?? null);
            setConversations(snapshot.conversations ?? []);

            // Tools are always refetched, like agents: the snapshot only paints
            // the first frame. Skipping the fetch when the snapshot had tools
            // kept a catalog that no longer exists (MCP turned off, a server
            // removed) on screen across reloads until the next sign-in.
            needsPreferences = Boolean(setUserPreferences) && !snapshot.userPreferences;
            needsConversations = true;
          }
        } catch (error) {
          console.error("Failed to hydrate from snapshot", error);
        }

        // The session is good: the route may load its conversation now, in
        // parallel with the catalogs below, instead of after them. After the
        // snapshot on purpose, so the conversation's own agent and privacy
        // land after the snapshot's remembered ones, never under them.
        setSessionReady?.(true);

        const requests: Promise<unknown>[] = [];

        requests.push(
          getAgents()
            .then((agents) => setAgents(agents))
            .catch((error) => {
              console.error("Failed to fetch agents on rehydrate", error);
              if (!hasSnapshotAgents) {
                setAgents([]);
              }
            }),
        );

        if (needsTools) {
          requests.push(
            getTools()
              .then((tools) => setAvailableTools?.(tools))
              .catch((error) => {
                console.error("Failed to fetch tools on rehydrate", error);
                setAvailableTools?.([]);
              }),
          );
        }

        // The user's pool is fetched authoritatively inside useSkills when the
        // userId resolves; the snapshot paint above (setMyRegistrySkills) is
        // just the instant-paint seed. No rehydrate fetch needed here.

        if (needsPreferences) {
          requests.push(
            getUserPreferences(restored.user.id)
              .then((prefs) => setUserPreferences?.(prefs))
              .catch((error) => {
                console.error("Failed to fetch preferences on rehydrate", error);
                setUserPreferences?.(null);
              }),
          );
        }

        if (needsConversations) {
          requests.push(
            getSidebarConversations(restored.user.id, CONV_INITIAL_PAGE_SIZE)
              .then((conversationList) => setConversations(sortByUpdatedAtDesc(conversationList)))
              .catch((error) => {
                console.error("Failed to fetch conversations on rehydrate", error);
                setConversations([]);
              }),
          );
        }

        if (requests.length > 0) {
          await Promise.all(requests);
        }

        // Conversation loading is URL-driven (the route's :conversationId is the
        // single source of truth), and since `sessionReady` it may already be
        // under way — so the loading flag is the route's to clear, not this.

        persistUIState?.();
        setConversationsLoading?.(false);
        setAuthResolved?.(true);
      } catch (error) {
        console.error("Failed to restore session", error);
        clearSession();
        setSessionReady?.(false);
        setIsLoggedIn(false);
        setUserId(null);
        setUserProfile(null);
        setAgents([]);
        setAvailableTools?.([]);
        setUserPreferences?.(null);
        setConversations([]);
        setConversationsLoading?.(false);
        setLoadingConversation?.(false);
        setAuthResolved?.(true);
      }
    };

    void run();
  }, []);
}

// ---------------------------------------------------------------------------
// UI snapshot persistence helper
// ---------------------------------------------------------------------------
/** How long a requested UI snapshot save waits for more requests to join it. */
const UI_SNAPSHOT_PERSIST_DEBOUNCE_MS = 300;

export function useUISnapshotPersistence(params: {
  userId: string | null;
  selectedAgent: string;
  isPrivateMode: boolean;
  sidebarOpen: boolean;
  activeProfileTab: string;
  currentConversationId: string | null;
  availableTools: ToolMetadata[];
  myRegistrySkills?: UserSkill[];
  agents: Agent[];
  conversations: ConversationSummary[];
  userPreferences: UserPreferences | null;
}) {
  const {
    userId,
    selectedAgent,
    isPrivateMode,
    sidebarOpen,
    activeProfileTab,
    currentConversationId,
    availableTools,
    myRegistrySkills,
    agents,
    conversations,
    userPreferences,
  } = params;

  // The skill pool follows the same snapshot-then-overwrite pattern as agents
  // — the IndexedDB copy is just a paint accelerator on refresh; the
  // always-fetch path overwrites it with whatever the bridge returns.
  const uiSnapshot = useMemo<UISnapshotSerializable | null>(() => {
    if (!userId) return null;
    return {
      version: 5,
      selectedAgent,
      isPrivateMode,
      sidebarOpen,
      activeProfileTab,
      lastConversationId: currentConversationId,
      availableTools,
      myRegistrySkills: myRegistrySkills ?? [],
      agents,
      conversations,
      userPreferences,
    };
  }, [
    userId,
    selectedAgent,
    isPrivateMode,
    sidebarOpen,
    activeProfileTab,
    currentConversationId,
    availableTools,
    myRegistrySkills,
    agents,
    conversations,
    userPreferences,
  ]);

  const snapshotRef = useRef<UISnapshotSerializable | null>(null);
  // Stamp the snapshot with the user it was built for. Without this, a `userId`
  // change re-runs the effect below with a NON-zero persistSignal and the
  // PREVIOUS user's snapshot still in the ref — writing one account's
  // conversations under another account's key, which then survives a reload.
  // Reachable on every account switch, where the store is still populated with
  // the outgoing account when the id flips.
  const snapshotOwnerRef = useRef<string | null>(null);
  useEffect(() => {
    if (uiSnapshot) {
      snapshotRef.current = uiSnapshot;
      snapshotOwnerRef.current = userId;
    }
  }, [uiSnapshot, userId]);

  // A save is requested by about twenty handlers (switching panels, the
  // sidebar, agents, every conversation load). It used to be a state tick,
  // which re-rendered the whole workspace for each request just to schedule
  // the write (plan 45). Now a plain debounced call: no render, and a burst of
  // requests becomes one IndexedDB write of the newest snapshot. By the time
  // it fires, the render that carried the requesting handler's state changes
  // has updated `snapshotRef`, so the write includes them.
  const userIdRef = useRef(userId);
  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistNow = useCallback(() => {
    persistTimerRef.current = null;
    const owner = userIdRef.current;
    if (!owner || !snapshotRef.current) return;
    if (snapshotOwnerRef.current !== owner) return;
    saveUISnapshot(owner, snapshotRef.current).catch(() => {});
  }, []);
  const requestPersist = useCallback(() => {
    if (persistTimerRef.current !== null) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(persistNow, UI_SNAPSHOT_PERSIST_DEBOUNCE_MS);
  }, [persistNow]);
  // A save still waiting when the workspace unmounts or the page is hidden
  // (closing the tab) is written at once rather than lost.
  useEffect(() => {
    const flush = () => {
      if (persistTimerRef.current === null) return;
      clearTimeout(persistTimerRef.current);
      persistNow();
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [persistNow]);

  return { uiSnapshot, requestPersist };
}

// ---------------------------------------------------------------------------
// Session auto-refresh effect
// ---------------------------------------------------------------------------
// Refresh ~10 min before the access token expires. The single-flight + cross-tab
// coordination (and the "already fresh, another tab beat us to it" skip) all live
// in ensureFreshSession now, so this effect only decides WHEN to refresh and how
// to reflect success/failure in React state.
export function useSessionAutoRefreshEffect(params: {
  isLoggedIn: boolean;
  setIsLoggedIn: (v: boolean) => void;
  setUserId: (v: string | null) => void;
  setUserProfile: (v: UserProfile | null) => void;
  toast?: (opts: {
    title: string;
    description?: string;
    variant?: string;
    duration?: number;
  }) => void;
}) {
  const { isLoggedIn, setIsLoggedIn, setUserId, setUserProfile, toast } = params;
  const timerRef = useRef<number | null>(null);
  const refreshingRef = useRef(false);
  const scheduleRef = useRef<() => void>(() => {});
  // Consecutive refreshes that got no answer from the bridge. Non-zero means a
  // refresh is still owed: the scheduler retries it rather than waiting for the
  // normal pre-expiry slot, and the count picks the backoff step.
  const retryAttemptRef = useRef(0);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const performRefresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    try {
      // ensureFreshSession does the single-flight refresh (cross-tab lock + fresh
      // marker skip + local persistence). We only sync React state and re-arm.
      const outcome = await ensureFreshSession();
      if (outcome.status === "unavailable") {
        // No answer from the bridge — offline, or the tab woke from sleep a few
        // seconds before Wi-Fi (or Docker Desktop's port forward) came back. The
        // session may be perfectly valid, so stay signed in and try again: on
        // `online`/tab focus straight away (see the effect below), otherwise
        // after the backoff. Logging out here used to sign people out on wake
        // while their refresh cookie was still valid.
        const delay = sessionRetryDelay(retryAttemptRef.current);
        retryAttemptRef.current += 1;
        clearTimer();
        // Offline means no attempt can succeed; the `online` listener retries.
        if (navigator.onLine !== false) {
          timerRef.current = window.setTimeout(() => scheduleRef.current(), delay);
        }
        return;
      }
      if (outcome.status === "failed") {
        // The bridge refused the refresh token (idle >12d, absolute >20d, or
        // revoked) — the session is genuinely over.
        throw new Error("session refresh failed");
      }
      retryAttemptRef.current = 0;

      // 'refreshed' carries the rotated user; 'already-fresh' means another tab
      // just refreshed, so read the shared persisted session for the profile.
      const existing = loadSession();
      const user = outcome.status === "refreshed" ? outcome.user : (existing?.user ?? null);
      if (user) {
        setUserProfile(user);
        if (user.id) setUserId(user.id);
      } else if (existing?.userId) {
        setUserId(existing.userId);
      }

      setIsLoggedIn(true);
      scheduleRef.current();
    } catch (error) {
      console.error("Session refresh failed:", error);
      retryAttemptRef.current = 0;
      clearTimer();
      clearSession();
      setIsLoggedIn(false);
      setUserId(null);
      setUserProfile(null);
      toast?.({
        title: "Session expired",
        description: "Please sign in again.",
        variant: "warning",
        duration: 4000,
      });
    } finally {
      refreshingRef.current = false;
    }
  }, [clearTimer, setIsLoggedIn, setUserId, setUserProfile, toast]);

  const scheduleRefresh = useCallback(() => {
    clearTimer();
    if (!isLoggedIn) {
      return;
    }
    const session = loadSession();
    if (!session) return;

    const remaining = session.expiresAt - Date.now();
    // A refresh still owed after an unanswered attempt is retried now, whatever
    // ran the scheduler (backoff timer, `online`, tab focus) — the normal
    // pre-expiry slot below has already passed for it.
    if (remaining <= 0 || retryAttemptRef.current > 0) {
      void performRefresh();
      return;
    }

    // Refresh ~10 min before the 8-hour access token expires — a 2-min margin
    // on an 8h token is too thin if the network is slow.
    const bufferMs = 10 * 60 * 1000;
    const delay = remaining > bufferMs ? remaining - bufferMs : Math.max(remaining - 5000, 0);

    if (delay <= 0) {
      void performRefresh();
      return;
    }

    timerRef.current = window.setTimeout(() => {
      void performRefresh();
    }, delay);
  }, [clearTimer, isLoggedIn, performRefresh]);

  useEffect(() => {
    scheduleRef.current = scheduleRefresh;
  }, [scheduleRefresh]);

  useEffect(() => {
    if (!isLoggedIn) {
      clearTimer();
      retryAttemptRef.current = 0;
      return;
    }
    scheduleRefresh();

    // Silent refresh on return. Browsers throttle (and a slept device pauses)
    // timers in a backgrounded tab, so the scheduled refresh can drift or miss.
    // When the tab becomes visible / regains focus we re-evaluate via the same
    // scheduler: it refreshes immediately if the access token already expired or
    // is about to, otherwise it just re-arms the (drifted) timer. This is what
    // keeps an active-but-returning user signed in without a surprise logout,
    // and with zero per-request coupling. Uses scheduleRef so it always runs the
    // latest scheduler closure.
    const onWake = () => {
      if (document.visibilityState === "visible") {
        scheduleRef.current();
      }
    };
    // The network coming back is the moment an owed refresh can finally
    // succeed. Visibility is irrelevant here: a backgrounded tab with an expired
    // session should be repaired before the user returns to it.
    const onOnline = () => scheduleRef.current();
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    window.addEventListener("online", onOnline);

    return () => {
      clearTimer();
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
      window.removeEventListener("online", onOnline);
    };
  }, [isLoggedIn, scheduleRefresh, clearTimer]);
}

// ---------------------------------------------------------------------------
// Session state sync effect
// ---------------------------------------------------------------------------
export function useSessionStateSyncEffect(params: {
  userId: string | null;
  selectedAgent: string;
  currentConversationId: string | null;
  isPrivateMode: boolean;
}) {
  const { userId, selectedAgent, currentConversationId, isPrivateMode } = params;
  useEffect(() => {
    if (!userId) return;
    updateSession({
      userId,
      selectedAgent,
      lastConversationId: currentConversationId,
      isPrivateMode,
    });
  }, [userId, selectedAgent, currentConversationId, isPrivateMode]);
}

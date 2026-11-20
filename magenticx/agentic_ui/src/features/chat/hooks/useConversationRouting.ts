import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { NavigateFunction } from "react-router-dom";

import {
  CONVERSATION_DETAIL_REVALIDATE_MS,
  fetchConversationDetail,
  forgetConversationDetail,
  readCachedConversationDetail,
  settleConversationDetailOnLeave,
} from "@/features/chat/lib/conversationDetailCache";
import { toastError } from "@/shared/lib/toast";
import type {
  Agent,
  ConversationDetail,
  SharedConversationDetail,
  ThinkingState,
} from "@/shared/lib/types";

type ToastFn = (opts: {
  title: string;
  description?: string;
  variant?: string;
  duration?: number;
}) => void;

/** Store setters accept a value or an updater, like `useState`. */
type SetStateArg<T> = T | ((prev: T) => T);

type UseConversationRoutingOptions = {
  // ── route ──
  /** `:conversationId`; undefined on "/" and on the pages ("/automations", "/agents…"). */
  conversationId: string | undefined;
  /** A full page over the chat — Automations ("/automations") or Agents ("/agents…"). */
  isPageRoute: boolean;
  navigate: NavigateFunction;

  // ── identity gate ──
  authResolved: boolean;
  /**
   * The session is restored, before the catalogs have loaded (plan 45): enough
   * to start loading `:conversationId`, in parallel with them.
   */
  sessionReady?: boolean;
  isLoggedIn: boolean;
  userId: string | null;

  // ── shared-conversation mode (read-only, token instead of an id) ──
  sharedConversationToken?: string;
  initialSharedConversation?: SharedConversationDetail | null;

  // ── workspace state this fills ──
  currentConversation: ConversationDetail | null;
  agents: Agent[];
  selectedAgent: string;
  setCurrentConversation: (v: SetStateArg<ConversationDetail | null>) => void;
  setSelectedAgent: (v: SetStateArg<string>) => void;
  setIsPrivateMode: (v: SetStateArg<boolean>) => void;
  setInactiveAgentFallback: (v: SetStateArg<Agent | null>) => void;
  setLoadingConversation: (v: SetStateArg<boolean>) => void;

  // ── conversation-scoped state this erases on leaving ──
  setThinkingState: Dispatch<SetStateAction<ThinkingState | null>>;
  setExpandedThinking: Dispatch<SetStateAction<{ [key: string]: boolean }>>;
  setAttachments: Dispatch<SetStateAction<File[]>>;
  setCurrentMessage: Dispatch<SetStateAction<string>>;
  setBranchSelections: Dispatch<SetStateAction<Record<string, number>>>;

  // ── collaborators ──
  closeVoiceSession: () => void;
  deriveBranchSelectionsForActiveRun: (detail: ConversationDetail) => Record<string, number> | null;
  requestPersist: () => void;
  toast: ToastFn;
};

/**
 * The URL is the single source of truth for which conversation is on screen, and
 * this hook is everything that follows from that.
 *
 * It replaced several older load paths (a click-handler setTimeout choreography
 * and a separate "hydrate the last conversation" effect) that fought each other.
 * Consolidating them here is what makes conversation switching safe mid-stream
 * and mid-animation, so the effects below are deliberately kept together rather
 * than filed next to the state each one happens to touch.
 *
 * Read the two guards before changing anything here — both encode a bug that
 * shipped:
 *
 *  - **The generation counter, NOT a `loading` flag.** Every run bumps `gen`, and
 *    a resolved fetch drops its own result if a newer navigation has started.
 *    An `if (loading) return` guard was tried and reverted: it blocks switching
 *    while a load or animation is in flight, which is exactly the freeze users hit.
 *  - **`null -> id` promotion only.** Clicking "New chat" on `/c/:id` navigates to
 *    "/", but on that render `currentConversation` is still the old one (the reset
 *    commits next render). Without the previous-id check, the promotion effect
 *    would see that stale id with no `:conversationId` and bounce straight back.
 *
 * Details go through a small per-user cache (plan 45, `conversationDetailCache`):
 * reopening a conversation seen in the last 30 s paints it at once, with no
 * loading overlay, and revalidates it in the background. The refreshed copy
 * replaces the screen only while the screen still shows the cached one — a
 * send or a stream that started meanwhile is never overwritten.
 */
export function useConversationRouting({
  conversationId,
  isPageRoute,
  navigate,
  authResolved,
  sessionReady = false,
  isLoggedIn,
  userId,
  sharedConversationToken,
  initialSharedConversation,
  currentConversation,
  agents,
  selectedAgent,
  setCurrentConversation,
  setSelectedAgent,
  setIsPrivateMode,
  setInactiveAgentFallback,
  setLoadingConversation,
  setThinkingState,
  setExpandedThinking,
  setAttachments,
  setCurrentMessage,
  setBranchSelections,
  closeVoiceSession,
  deriveBranchSelectionsForActiveRun,
  requestPersist,
  toast,
}: UseConversationRoutingOptions) {
  const queryClient = useQueryClient();
  // Bumped by every load; a resolved fetch compares against it to decide whether
  // it is still the newest navigation.
  const loadGenRef = useRef(0);
  // Loading may start once the session is restored; the bootstrap need not have
  // finished its catalogs. One flag in the deps, so `authResolved` flipping
  // after `sessionReady` does not restart a load already under way.
  const canLoad = authResolved || sessionReady;

  // A shared conversation arrives fully-formed as a prop (no id, no fetch), so it
  // is hydrated into the workspace once per token rather than loaded by route.
  const hydratedSharedTokenRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      !sharedConversationToken ||
      !initialSharedConversation ||
      !authResolved ||
      !isLoggedIn ||
      !userId
    )
      return;
    if (hydratedSharedTokenRef.current === sharedConversationToken) return;

    hydratedSharedTokenRef.current = sharedConversationToken;
    setSelectedAgent(initialSharedConversation.agent.id);
    setIsPrivateMode(false);
    setCurrentConversation({
      id: `shared:${sharedConversationToken}`,
      agent: initialSharedConversation.agent,
      title: initialSharedConversation.title || "Shared conversation",
      isPrivate: false,
      created_at: initialSharedConversation.createdAt,
      updated_at: initialSharedConversation.createdAt,
      messages: initialSharedConversation.messages,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- store setters are stable
  }, [authResolved, initialSharedConversation, isLoggedIn, sharedConversationToken, userId]);

  // ── URL-driven conversation loading ────────────────────────────────────
  // `currentConversation` is read but deliberately omitted from the deps, so
  // navigating does not retrigger on every streamed message.
  useEffect(() => {
    if (!canLoad || !isLoggedIn || !userId || sharedConversationToken) return;
    const gen = ++loadGenRef.current;
    // Voice never survives a navigation between conversations/pages.
    closeVoiceSession();

    // Leaving a conversation: its cached detail survives only if it is still
    // exactly what the screen shows (nothing was sent, streamed or edited).
    if (currentConversation?.id && currentConversation.id !== conversationId) {
      settleConversationDetailOnLeave(queryClient, userId, currentConversation);
    }

    if (!conversationId) {
      // "/" or a page ("/automations", "/agents…") → erase conversation-scoped state
      // synchronously.
      setThinkingState(null);
      setExpandedThinking({});
      setAttachments([]);
      setCurrentMessage("");
      setInactiveAgentFallback(null);
      setCurrentConversation(null);
      setIsPrivateMode(false);
      setLoadingConversation(false);
      return;
    }

    // Already showing this conversation (e.g. just created / forked) → no refetch.
    if (currentConversation?.id === conversationId) return;

    const showDetail = (detail: ConversationDetail) => {
      // Pin branch selections to the active run's path so a streaming /
      // HITL-paused message isn't hidden on a sibling branch.
      const activeRunBranchSelections = deriveBranchSelectionsForActiveRun(detail);
      setSelectedAgent(detail.agent?.id || "");
      if (activeRunBranchSelections) setBranchSelections(activeRunBranchSelections);
      setCurrentConversation(detail);
      setIsPrivateMode(detail.isPrivate || false);
      setInactiveAgentFallback(null);
      requestPersist();
    };
    const reportLoadError = (error: unknown) =>
      toastError(toast, "Failed to load conversation", error, {
        description: "There was an error loading the conversation. Please try again.",
        duration: 3000,
      });

    // Seen in the last 30 s: paint it now, no overlay, and revalidate quietly.
    const cached = readCachedConversationDetail(queryClient, userId, conversationId);
    if (cached) {
      showDetail(cached);
      // A superseded load may have raised the overlay; it no longer owns it.
      setLoadingConversation(false);
      fetchConversationDetail(queryClient, userId, conversationId, {
        maxAgeMs: CONVERSATION_DETAIL_REVALIDATE_MS,
      })
        .then((fresh) => {
          if (gen !== loadGenRef.current || fresh === cached) return;
          // Only the agent selection and privacy were set from the cached copy;
          // the user may have changed the picker since, so only the
          // conversation itself is refreshed — and only while the screen still
          // shows the cached copy (no send or stream has started on top of it).
          setCurrentConversation((shown) => (shown === cached ? fresh : shown));
        })
        .catch((error) => {
          forgetConversationDetail(queryClient, userId, conversationId);
          if (gen !== loadGenRef.current) return;
          reportLoadError(error);
        });
      return;
    }

    setLoadingConversation(true);
    fetchConversationDetail(queryClient, userId, conversationId)
      .then((detail) => {
        if (gen !== loadGenRef.current) return; // superseded by a newer navigation
        showDetail(detail);
      })
      .catch((error) => {
        if (gen !== loadGenRef.current) return;
        reportLoadError(error);
      })
      .finally(() => {
        if (gen === loadGenRef.current) setLoadingConversation(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, canLoad, isLoggedIn, userId, sharedConversationToken]);

  // Promote a conversation created from the empty "/" state (first message sent)
  // into the URL so it is linkable and survives refresh. See the `null -> id`
  // note in the hook docblock for why the previous-id check is load-bearing.
  const lastConversationIdRef = useRef<string | null>(null);
  useEffect(() => {
    const id = currentConversation?.id ?? null;
    // "" is the optimistic conversation shell of an in-flight first send — it
    // counts as empty so the shell→real-id transition still promotes the URL
    // (and `if (id && …)` below keeps the shell itself from being navigated to).
    const wasEmpty = !lastConversationIdRef.current;
    lastConversationIdRef.current = id;
    if (id && wasEmpty && !id.startsWith("shared:") && !conversationId && !isPageRoute) {
      navigate("/c/" + id, { replace: true });
    }
  }, [currentConversation?.id, conversationId, isPageRoute, navigate]);

  // Entering a page (Automations, Agents) tears down any live voice session. The
  // load effect only fires on :conversationId changes, and "/" ↔ a page keeps it
  // null, so voice is closed here for that transition.
  useEffect(() => {
    if (isPageRoute) closeVoiceSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPageRoute]);

  // With no conversation open, the picker's selection must name an agent that is
  // actually in the catalog. An open conversation may legitimately point at one
  // that isn't (its own inactive/removed agent, merged into the list for display),
  // but once that conversation is gone the id is unusable: it would leave the
  // trigger blank and send inference against an agent that no longer exists.
  // Guarded on the route param too, so this never races an in-flight load that is
  // about to set the selection from the conversation itself — which is why it
  // lives here rather than beside the rest of the agent-catalog code.
  useEffect(() => {
    if (conversationId || currentConversation || agents.length === 0) return;
    if (agents.some((agent) => agent.id === selectedAgent)) return;
    const nextAgent = agents.find((agent) => agent.isActive) ?? agents[0];
    setSelectedAgent(nextAgent?.id ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- store setters are stable
  }, [conversationId, currentConversation, agents, selectedAgent]);
}

import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { prefetchConversationDetail } from "@/features/chat/lib/conversationDetailCache";

/** How long the pointer (or focus) must rest on a row before its detail is fetched. */
export const PREFETCH_HOVER_INTENT_MS = 150;

type UsePrefetchConversationArgs = {
  /** The signed-in user; null (signed out, account frozen) prefetches nothing. */
  userId: string | null;
  /**
   * Whether this id may be prefetched, asked when the hover intent fires: only
   * the user's own, listed conversations (plan 45 §9), never the open one.
   */
  canPrefetch: (conversationId: string) => boolean;
};

/**
 * A stable `prefetchConversation(conversationId)` for the sidebar's rows
 * (plan 45, Phase 5): resting on a row warms its detail in the conversation
 * cache, so the click that usually follows paints without the loading overlay
 * (or joins the request already in flight).
 *
 * Hover intent, not hover: each call replaces the one before, and only a row
 * the pointer rests on for {@link PREFETCH_HOVER_INTENT_MS} is fetched — a
 * sweep over twenty rows sends at most one request. A row whose detail is
 * fresh, or already being fetched, sends none. The request is the same one a
 * click makes; no new endpoint.
 */
export function usePrefetchConversation({ userId, canPrefetch }: UsePrefetchConversationArgs) {
  const queryClient = useQueryClient();
  const latest = useRef({ userId, canPrefetch });
  useEffect(() => {
    latest.current = { userId, canPrefetch };
  });

  const timerRef = useRef<number | null>(null);
  const cancelPending = useCallback(() => {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  // A pending hover never outlives the account it was made under, nor the hook.
  useEffect(() => cancelPending, [userId, cancelPending]);

  return useCallback(
    (conversationId: string) => {
      cancelPending();
      const owner = latest.current.userId;
      if (!owner || !conversationId || conversationId.startsWith("shared:")) return;
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        const { userId: current, canPrefetch: allowed } = latest.current;
        if (current !== owner || !allowed(conversationId)) return;
        void prefetchConversationDetail(queryClient, owner, conversationId);
      }, PREFETCH_HOVER_INTENT_MS);
    },
    [cancelPending, queryClient],
  );
}

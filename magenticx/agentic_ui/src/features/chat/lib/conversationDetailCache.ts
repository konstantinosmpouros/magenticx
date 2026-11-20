import type { QueryClient } from "@tanstack/react-query";

import { getConversationDetail } from "@/shared/lib/api";
import type { ConversationDetail } from "@/shared/lib/types";

/**
 * A small per-user cache of recently opened conversation details (plan 45,
 * Phase 5), kept in the app's TanStack `QueryClient` under
 * `["conversation", userId, conversationId]`.
 *
 * Why the query client, used imperatively, and not `useQuery` in the chat:
 * the open conversation lives in the workspace store, where the streaming
 * run, optimistic sends and edits rewrite it many times a second. Moving it
 * onto a query would put two writers on one object. Instead the URL-driven
 * loader (`useConversationRouting`) reads and fills this cache, and the store
 * stays the single owner of what is on screen. The client gives us request
 * de-duplication (a click after a hover joins the hover's request), staleness
 * and garbage collection for free, and is cleared on logout and account switch.
 *
 * The cache only serves what the server sent: a conversation changed on this
 * screen (a send, a stream, an edit) is dropped when the user leaves it, so a
 * reopen never paints an older copy than the one they just saw.
 */

/** How long an entry may be painted at once on reopen, without the loading overlay. */
export const CONVERSATION_DETAIL_STALE_MS = 30_000;
/** A painted entry younger than this is not asked for again (a hover just fetched it). */
export const CONVERSATION_DETAIL_REVALIDATE_MS = 5_000;
/** How long an unused entry is kept at all. Details can be large, so not long. */
const CONVERSATION_DETAIL_GC_MS = 60_000;
/** At most this many details per user; the oldest go first. */
export const CONVERSATION_DETAIL_CACHE_MAX = 12;

const ROOT_KEY = "conversation";

/** The query key of one conversation's detail; the user id keeps accounts apart. */
export const conversationDetailKey = (userId: string, conversationId: string) =>
  [ROOT_KEY, userId, conversationId] as const;

const detailQuery = (userId: string, conversationId: string, staleTime: number) => ({
  queryKey: conversationDetailKey(userId, conversationId),
  queryFn: () => getConversationDetail(userId, conversationId),
  staleTime,
  gcTime: CONVERSATION_DETAIL_GC_MS,
});

/**
 * Keep at most `max` details for a user, dropping the least recently fetched.
 * A hover over many rows would otherwise hold every one of them for a minute.
 * A request still in flight is never dropped (its caller is waiting on it).
 */
export function trimConversationDetailCache(
  queryClient: QueryClient,
  userId: string,
  max: number = CONVERSATION_DETAIL_CACHE_MAX,
): void {
  const cache = queryClient.getQueryCache();
  const entries = cache.findAll({ queryKey: [ROOT_KEY, userId] });
  if (entries.length <= max) return;
  const removable = entries
    .filter((query) => query.state.fetchStatus === "idle")
    .sort((a, b) => a.state.dataUpdatedAt - b.state.dataUpdatedAt);
  for (const query of removable.slice(0, entries.length - max)) cache.remove(query);
}

/**
 * The cached detail the chat may paint right away, or null: it must be younger
 * than {@link CONVERSATION_DETAIL_STALE_MS} and have had no run streaming when
 * it was fetched (that copy goes out of date within seconds, and painting it
 * would point the run machinery at a run that may have ended).
 */
export function readCachedConversationDetail(
  queryClient: QueryClient,
  userId: string,
  conversationId: string,
  now: number = Date.now(),
): ConversationDetail | null {
  const state = queryClient.getQueryState<ConversationDetail>(
    conversationDetailKey(userId, conversationId),
  );
  const detail = state?.data;
  if (!state || !detail) return null;
  if (now - state.dataUpdatedAt >= CONVERSATION_DETAIL_STALE_MS) return null;
  if (detail.activeRunId || detail.isStreaming) return null;
  return detail;
}

/**
 * Load a conversation's detail through the cache: an entry younger than
 * `maxAgeMs` is returned as is, a request already in flight (a hover's
 * prefetch) is joined, anything else is fetched.
 *
 * Resolves with the object the cache holds, not the raw response: structural
 * sharing keeps unchanged parts (and an unchanged detail as a whole) at their
 * old identity, which is what lets the loader tell "nothing changed" apart and
 * spares the message list a re-render.
 */
export async function fetchConversationDetail(
  queryClient: QueryClient,
  userId: string,
  conversationId: string,
  { maxAgeMs = 0 }: { maxAgeMs?: number } = {},
): Promise<ConversationDetail> {
  const fetched = await queryClient.fetchQuery(detailQuery(userId, conversationId, maxAgeMs));
  trimConversationDetailCache(queryClient, userId);
  return (
    queryClient.getQueryData<ConversationDetail>(conversationDetailKey(userId, conversationId)) ??
    fetched
  );
}

/**
 * Warm the cache for a conversation the user is about to open (sidebar hover
 * or focus). A fresh entry or a request in flight makes this a no-op, and a
 * failure is swallowed: the click will load it the normal way.
 */
export async function prefetchConversationDetail(
  queryClient: QueryClient,
  userId: string,
  conversationId: string,
): Promise<void> {
  await queryClient.prefetchQuery(
    detailQuery(userId, conversationId, CONVERSATION_DETAIL_STALE_MS),
  );
  trimConversationDetailCache(queryClient, userId);
}

/** Drop one conversation's cached detail (deleted, failed to load, or changed here). */
export function forgetConversationDetail(
  queryClient: QueryClient,
  userId: string,
  conversationId: string,
): void {
  queryClient.removeQueries({
    queryKey: conversationDetailKey(userId, conversationId),
    exact: true,
  });
}

/**
 * Called as the user leaves a conversation: its cached detail stays only if
 * the screen still shows that very object. Any change made here (a send, a
 * streamed answer, an edit, a rename) replaced it in the store, and the cache
 * would otherwise paint the older copy on the way back.
 */
export function settleConversationDetailOnLeave(
  queryClient: QueryClient,
  userId: string,
  shown: ConversationDetail,
): void {
  const key = conversationDetailKey(userId, shown.id);
  const cached = queryClient.getQueryData<ConversationDetail>(key);
  if (cached !== undefined && cached !== shown) forgetConversationDetail(queryClient, userId, shown.id);
}

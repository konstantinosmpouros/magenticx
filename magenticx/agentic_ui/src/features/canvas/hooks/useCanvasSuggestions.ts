import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import type {
  CanvasDocumentVersion,
  CanvasDocumentVersionMeta,
  CanvasSuggestionDecision,
  CanvasSuggestionReview,
} from "@/shared/lib/types";

import { canvasContentKey } from "../lib/queryKeys";
import { loadReviewedVersion, saveReviewedVersion } from "../lib/reviewStorage";
import { buildSuggestions, resolveSuggestions, suggestionDisplay } from "../lib/suggestions";
import { useCanvasVersionText } from "./useCanvasVersionText";

/**
 * Suggesting mode (plan 44, Phase 4.6): whether the open document has agent
 * changes for the user to review, and the review itself.
 *
 * **The base** — what the agent's changes are shown against — is the newer
 * of two versions:
 *
 * 1. the newest version the user wrote (a save, a restore, a rejection);
 * 2. the last version the user has **reviewed**, kept in localStorage per
 *    user, conversation and path. It moves to the latest version when the
 *    document opens in Editing or Viewing (the user reads it plainly), to
 *    the version that was on screen when a newer one arrives while the text
 *    showed plainly (in any mode — so Editing's reload with the shine still
 *    leaves that change to review in Suggesting), and to the agent's version
 *    once its suggestions are all decided. Opening a document in Suggesting
 *    with neither (the agent wrote every version, and this browser has no
 *    record) starts the record at the latest version: nothing to review yet.
 *
 * There is something to review when the latest version is the agent's and
 * is newer than the base: every agent version since the base collapses into
 * one set of suggestions (base text → latest text). Only while the editor
 * holds nothing unsaved: with unsaved edits a newer version stays the
 * "The agent saved vN — Review" banner, as in Editing.
 *
 * Decisions are kept here until the last suggestion is decided; then
 * `onResolved` gets the text to save — null when everything was accepted
 * (the agent's version simply stays) — and the version is marked reviewed.
 */
export function useCanvasSuggestions({
  userId,
  conversationId,
  path,
  active,
  latest,
  versions,
  versionsFailed,
  loadVersions,
  clean,
  onResolved,
}: {
  userId: string;
  conversationId: string;
  path: string;
  /** Suggesting mode, on the latest version. */
  active: boolean;
  latest: CanvasDocumentVersion | null;
  /** The document's versions, newest first, or null until loaded. */
  versions: CanvasDocumentVersionMeta[] | null;
  versionsFailed: boolean;
  loadVersions: () => void;
  /** The editor holds nothing unsaved (and no save is on its way). */
  clean: boolean;
  /** The decisions' text to save as the user's version; null: nothing to save. */
  onResolved: (markdown: string | null) => void;
}): { review: CanvasSuggestionReview | null; waiting: boolean } {
  const queryClient = useQueryClient();
  const [reviewed, setReviewed] = useState(() => loadReviewedVersion(userId, conversationId, path));
  const markReviewed = useCallback(
    (version: number) => {
      setReviewed((current) => {
        const next = Math.max(current ?? 0, version);
        if (next !== current) saveReviewedVersion(userId, conversationId, path, next);
        return next;
      });
    },
    [userId, conversationId, path],
  );

  const agentLatest = latest?.author === "agent" ? latest : null;
  const lastUserVersion = useMemo(() => {
    if (!versions) return null;
    const ceiling = latest?.version ?? Infinity;
    const mine = versions.filter((meta) => meta.author === "user" && meta.version <= ceiling);
    return mine.length > 0 ? Math.max(...mine.map((meta) => meta.version)) : 0;
  }, [versions, latest?.version]);

  const needVersions = active && agentLatest !== null;
  useEffect(() => {
    if (needVersions) loadVersions();
  }, [needVersions, loadVersions]);

  // The base, once it is known (`undefined`: still loading the versions).
  const versionsKnown = versions !== null || versionsFailed;
  const base: number | null | undefined = !versionsKnown
    ? undefined
    : Math.max(lastUserVersion ?? 0, reviewed ?? 0) || null;

  // Opened in Editing or Viewing: the user reads the latest plainly.
  const openedRef = useRef(false);
  useEffect(() => {
    if (openedRef.current || !latest) return;
    openedRef.current = true;
    if (!active) markReviewed(latest.version);
  }, [latest, active, markReviewed]);

  // Opened in Suggesting with no record and no version of the user's: start here.
  useEffect(() => {
    if (needVersions && versions !== null && lastUserVersion === 0 && reviewed === null && latest)
      markReviewed(latest.version);
  }, [needVersions, versions, lastUserVersion, reviewed, latest, markReviewed]);

  const candidate =
    active && agentLatest && base !== undefined && base !== null && base < agentLatest.version
      ? base
      : null;
  const baseText = useCanvasVersionText(userId, conversationId, path, candidate);

  const set = useMemo(
    () =>
      agentLatest && baseText !== null ? buildSuggestions(baseText, agentLatest.content) : null,
    [agentLatest, baseText],
  );
  const key = candidate !== null && agentLatest ? `${candidate}->${agentLatest.version}` : "";
  const [decided, setDecided] = useState<{
    key: string;
    map: Record<string, CanvasSuggestionDecision>;
  }>({ key: "", map: {} });
  // Stable between renders: the review's value is built from it.
  const decisions = useMemo(() => (decided.key === key ? decided.map : {}), [decided, key]);

  // Nothing but spelling changed (the same blocks): nothing to review.
  const empty = set !== null && set.suggestions.length === 0;
  useEffect(() => {
    if (empty && agentLatest) markReviewed(agentLatest.version);
  }, [empty, agentLatest, markReviewed]);

  const pending = Boolean(set && !empty && clean && agentLatest);
  const waiting =
    active &&
    agentLatest !== null &&
    !pending &&
    clean &&
    (base === undefined || (candidate !== null && set === null));

  // A newer version arrived: the one on screen, shown plainly, was read.
  // Its text is kept in the cache under its number: it may be the next base.
  // `shownPlainly` is what the last committed render showed (updated below,
  // after this effect has read it).
  const plainNow = !pending && !waiting;
  const shownPlainly = useRef(true);
  const previous = useRef(latest);
  useEffect(() => {
    const before = previous.current;
    previous.current = latest;
    if (!before || !latest || latest.version <= before.version) return;
    const cacheKey = canvasContentKey(userId, conversationId, path, before.version);
    if (!queryClient.getQueryData(cacheKey)) queryClient.setQueryData(cacheKey, before);
    if (shownPlainly.current) markReviewed(before.version);
  }, [latest, queryClient, userId, conversationId, path, markReviewed]);
  useEffect(() => {
    shownPlainly.current = plainNow;
  });

  const resolvedRef = useRef(onResolved);
  resolvedRef.current = onResolved;
  const decide = useCallback(
    (ids: string[], decision: CanvasSuggestionDecision) => {
      if (!set || !agentLatest) return;
      const map = { ...decisions };
      for (const id of ids) map[id] ??= decision;
      setDecided({ key, map });
      if (set.suggestions.some((item) => !map[item.id])) return;
      const rejected = new Set(
        set.suggestions.filter((item) => map[item.id] === "reject").map((item) => item.id),
      );
      markReviewed(agentLatest.version);
      resolvedRef.current(rejected.size === 0 ? null : resolveSuggestions(set, rejected));
    },
    [set, agentLatest, decisions, key, markReviewed],
  );

  const value = useMemo(() => (set ? suggestionDisplay(set, decisions) : null), [set, decisions]);
  const remaining = useMemo(
    () => (set ? set.suggestions.filter((item) => !decisions[item.id]) : []),
    [set, decisions],
  );

  if (!pending || !set || !value) return { review: null, waiting };
  return {
    waiting: false,
    review: {
      key,
      value,
      remaining,
      onAccept: (id) => decide([id], "accept"),
      onReject: (id) => decide([id], "reject"),
      onAcceptAll: () =>
        decide(
          remaining.map((item) => item.id),
          "accept",
        ),
      onRejectAll: () =>
        decide(
          remaining.map((item) => item.id),
          "reject",
        ),
    },
  };
}

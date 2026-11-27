import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  getDocumentVersion,
  getLatestDocument,
  listConversationDocuments,
  listDocumentVersions,
} from "@/shared/lib/api";
import { ApiError } from "@/shared/lib/http";

import { canvasContentKey, canvasKey, canvasListKey, canvasVersionsKey } from "../lib/queryKeys";
import { useCanvasBranchMessage } from "../lib/branch";

/** A 404 is an answer (the document is gone), not a fault worth retrying. */
const isNotFound = (error: unknown): boolean => error instanceof ApiError && error.status === 404;

const retryUnlessGone = (failures: number, error: unknown): boolean =>
  !isNotFound(error) && failures < 2;

/**
 * The data behind the canvas (plan 44, Phases 4.1–4.2): the open document's
 * latest version (always read: the editor is based on it, and a newer one
 * arriving is how a finished run shows up), the version the user picked to
 * read instead, the conversation's other documents (the title's ▾ menu) and,
 * once asked for, the document's version list (the byline menu, History).
 *
 * `revision` is anything that changes when the conversation may have new
 * versions (the chat passes its message count and whether a run is live): a
 * run that finishes rewrites the agent's file, so the canvas re-reads instead
 * of showing a stale text. Picking another document goes back to its latest
 * version.
 */
export function useCanvasDocument(
  userId: string,
  conversationId: string,
  path: string,
  revision: string,
) {
  const messageId = useCanvasBranchMessage();
  const queryClient = useQueryClient();
  // The picked version and "the version list was asked for" belong to one
  // document: held with its key, so opening another one starts fresh on its
  // very first render (no stale request for the old document's version).
  const docKey = `${conversationId}|${path}`;
  const [picked, setPicked] = useState<{ docKey: string; version: number | null } | null>(null);
  const [versionsFor, setVersionsFor] = useState<string | null>(null);
  const pickedVersion = picked?.docKey === docKey ? picked.version : null;
  const versionsWanted = versionsFor === docKey;

  // A new turn may have written a new version: re-read what is cached. Not on
  // mount — the queries below are fetching for the first time already. Another
  // branch needs no re-read: its message is in the keys, so it is its own query.
  const seenRevision = useRef(revision);
  useEffect(() => {
    if (seenRevision.current === revision) return;
    seenRevision.current = revision;
    void queryClient.invalidateQueries({ queryKey: canvasKey(userId, conversationId) });
  }, [queryClient, userId, conversationId, revision]);

  // The list, the latest version and the version list describe what is current,
  // so they opt out of the app's 30 s freshness (plan 45) and re-read on every
  // mount, as before: a run that wrote a new version while the canvas was
  // closed must show on reopen. (`revision` only catches changes while open.)
  // Content read by version number never changes, so it keeps the default.
  const documents = useQuery({
    queryKey: canvasListKey(userId, conversationId, messageId),
    queryFn: ({ signal }) => listConversationDocuments(userId, conversationId, messageId, signal),
    retry: retryUnlessGone,
    staleTime: 0,
    // A new message (or another branch) is a new key: keep the shown list meanwhile.
    placeholderData: (previous) => previous,
  });

  const latest = useQuery({
    queryKey: canvasContentKey(userId, conversationId, messageId, path, "latest"),
    queryFn: ({ signal }) => getLatestDocument(userId, conversationId, messageId, path, signal),
    retry: retryUnlessGone,
    staleTime: 0,
    // Each turn moves the branch's message, so the key: the editor keeps the
    // document it shows until the read for the new key lands.
    placeholderData: (previous) => (previous?.path === path ? previous : undefined),
  });

  const older = useQuery({
    queryKey: canvasContentKey(userId, conversationId, messageId, path, pickedVersion ?? 0),
    queryFn: ({ signal }) =>
      getDocumentVersion(userId, conversationId, messageId, path, pickedVersion ?? 0, signal),
    enabled: pickedVersion !== null,
    retry: retryUnlessGone,
    // Switching versions keeps the shown text until the next one arrives.
    placeholderData: (previous) => (previous?.path === path ? previous : undefined),
  });

  const versions = useQuery({
    queryKey: canvasVersionsKey(userId, conversationId, messageId, path),
    queryFn: ({ signal }) => listDocumentVersions(userId, conversationId, messageId, path, signal),
    enabled: versionsWanted,
    retry: retryUnlessGone,
    staleTime: 0,
  });

  // The latest version's number, to tell "an earlier version" from "the latest".
  const latestVersion =
    latest.data?.version ??
    documents.data?.find((doc) => doc.path === path)?.version ??
    versions.data?.[0]?.version;
  const isLatest = pickedVersion === null || pickedVersion === latestVersion;
  const content = isLatest ? latest : older;

  // Stable, so effects and memoized callbacks that use them don't re-run.
  const loadVersions = useCallback(() => setVersionsFor(docKey), [docKey]);
  const pickVersion = useCallback(
    (version: number | null) => setPicked({ docKey, version }),
    [docKey],
  );
  /** Ask for the version list again (a save was refused: someone wrote a newer one). */
  const refreshVersions = useCallback(() => {
    setVersionsFor(docKey);
    void queryClient.invalidateQueries({
      queryKey: canvasVersionsKey(userId, conversationId, messageId, path),
    });
  }, [docKey, queryClient, userId, conversationId, messageId, path]);

  /**
   * Re-read the conversation's documents now, resolving once they are in
   * (Ask agent's run ended: its new version must be loaded before the editor
   * unlocks, or an early keystroke would turn the reload into a banner).
   */
  const refreshLatest = useCallback(
    () => queryClient.invalidateQueries({ queryKey: canvasKey(userId, conversationId) }),
    [queryClient, userId, conversationId],
  );

  return {
    documents: documents.data ?? [],
    /** The latest version with its text: what the editor is based on. */
    latest: latest.data ?? null,
    /** The version on screen: the latest, or the one picked to read. */
    document: (isLatest ? latest.data : older.data) ?? null,
    loading: content.isPending,
    gone: isNotFound(content.error),
    /** Why the document didn't load (not a 404, which is `gone`), or null. */
    errorMessage:
      content.error && !isNotFound(content.error)
        ? content.error instanceof Error && content.error.message
          ? content.error.message
          : "Something went wrong. Try again in a moment."
        : null,
    retry: () => void content.refetch(),
    isLatest,
    pickedVersion: isLatest ? null : pickedVersion,
    versions: versions.data ?? null,
    versionsLoading: versions.isFetching,
    loadVersions,
    refreshVersions,
    refreshLatest,
    pickVersion,
  };
}

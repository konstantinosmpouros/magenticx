import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  getDocumentVersion,
  getLatestDocument,
  listConversationDocuments,
  listDocumentVersions,
} from "@/shared/lib/api";
import { ApiError } from "@/shared/lib/http";

/** Every canvas query of one conversation shares this key prefix. */
const canvasKey = (userId: string, conversationId: string) =>
  ["canvas-documents", userId, conversationId] as const;

/** A 404 is an answer (the document is gone), not a fault worth retrying. */
const isNotFound = (error: unknown): boolean => error instanceof ApiError && error.status === 404;

const retryUnlessGone = (failures: number, error: unknown): boolean =>
  !isNotFound(error) && failures < 2;

/**
 * The data behind the read-only canvas (plan 44, Phase 4.1): the open
 * document's markdown — its latest version, or the version the user picked
 * from the byline — the conversation's other documents (the title's ▾ menu)
 * and, once asked for, the document's version list.
 *
 * `revision` is anything that changes when the conversation may have new
 * versions (the chat passes its message count and whether a run is live): a
 * run that finishes rewrites the agent's file, so the canvas re-reads instead
 * of showing a stale text.
 * Picking another document goes back to its latest version.
 */
export function useCanvasDocument(
  userId: string,
  conversationId: string,
  path: string,
  revision: string,
) {
  const queryClient = useQueryClient();
  // The picked version and "the version menu was opened" belong to one
  // document: held with its key, so opening another one starts fresh on its
  // very first render (no stale request for the old document's version).
  const docKey = `${conversationId}|${path}`;
  const [picked, setPicked] = useState<{ docKey: string; version: number | null } | null>(null);
  const [versionsFor, setVersionsFor] = useState<string | null>(null);
  const pickedVersion = picked?.docKey === docKey ? picked.version : null;
  const versionsWanted = versionsFor === docKey;

  // A new turn may have written a new version: re-read what is cached. Not on
  // mount — the queries below are fetching for the first time already.
  const seenRevision = useRef(revision);
  useEffect(() => {
    if (seenRevision.current === revision) return;
    seenRevision.current = revision;
    void queryClient.invalidateQueries({ queryKey: canvasKey(userId, conversationId) });
  }, [queryClient, userId, conversationId, revision]);

  const documents = useQuery({
    queryKey: [...canvasKey(userId, conversationId), "list"],
    queryFn: ({ signal }) => listConversationDocuments(userId, conversationId, signal),
    retry: retryUnlessGone,
  });

  const content = useQuery({
    queryKey: [...canvasKey(userId, conversationId), "content", path, pickedVersion ?? "latest"],
    queryFn: ({ signal }) =>
      pickedVersion === null
        ? getLatestDocument(userId, conversationId, path, signal)
        : getDocumentVersion(userId, conversationId, path, pickedVersion, signal),
    retry: retryUnlessGone,
    // Switching versions keeps the shown text until the next one arrives.
    placeholderData: (previous) => (previous?.path === path ? previous : undefined),
  });

  const versions = useQuery({
    queryKey: [...canvasKey(userId, conversationId), "versions", path],
    queryFn: ({ signal }) => listDocumentVersions(userId, conversationId, path, signal),
    enabled: versionsWanted,
    retry: retryUnlessGone,
  });

  // The latest version's number, to tell "an earlier version" from "the latest".
  const latestVersion =
    documents.data?.find((doc) => doc.path === path)?.version ??
    versions.data?.[0]?.version ??
    (pickedVersion === null ? content.data?.version : undefined);

  return {
    documents: documents.data ?? [],
    document: content.data ?? null,
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
    isLatest: pickedVersion === null || pickedVersion === latestVersion,
    versions: versions.data ?? null,
    versionsLoading: versions.isFetching,
    loadVersions: () => setVersionsFor(docKey),
    pickVersion: (version: number | null) => setPicked({ docKey, version }),
  };
}

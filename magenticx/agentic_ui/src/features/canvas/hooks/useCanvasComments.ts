import { useCallback, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createDocumentComment,
  deleteDocumentComment,
  listDocumentComments,
  updateDocumentComment,
} from "@/shared/lib/api";
import { useToast } from "@/shared/hooks/use-toast";
import { toastError } from "@/shared/lib/toast";
import type {
  CanvasComment,
  CanvasCommentAnchor,
  CanvasCommentPatch,
  CanvasCommentThread,
} from "@/shared/lib/types";

import { canvasCommentsKey } from "../lib/queryKeys";

/** The id a comment carries until the bridge answers with its own. */
const LOCAL_PREFIX = "local-";
export const isLocalComment = (id: string) => id.startsWith(LOCAL_PREFIX);

/** Threads (oldest first) with their replies, split into open and resolved. */
function toThreads(comments: CanvasComment[]): {
  open: CanvasCommentThread[];
  resolved: CanvasCommentThread[];
} {
  const replies = new Map<string, CanvasComment[]>();
  for (const comment of comments) {
    if (comment.parentId === null) continue;
    replies.set(comment.parentId, [...(replies.get(comment.parentId) ?? []), comment]);
  }
  const threads = comments
    .filter((comment) => comment.parentId === null && comment.anchor !== null)
    .map((comment) => ({ comment, replies: replies.get(comment.id) ?? [] }));
  return {
    open: threads.filter((thread) => thread.comment.status === "open"),
    resolved: threads.filter((thread) => thread.comment.status === "resolved"),
  };
}

/**
 * A document's comment threads (plan 44, Phase 4.4) and the changes the user
 * makes to them: start a thread on a passage, reply, resolve / reopen, edit or
 * delete their own comment.
 *
 * Every change shows at once (optimistic) and is rolled back, with a toast,
 * when the bridge refuses it. The rollback touches only the comment the
 * change was about, so two changes in flight never undo each other. Comments
 * are not part of the document: none of this makes an edit unsaved, and all
 * of it works while reading too.
 */
export function useCanvasComments(userId: string, conversationId: string, path: string) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const key = useMemo(
    () => canvasCommentsKey(userId, conversationId, path),
    [userId, conversationId, path],
  );
  const counter = useRef(0);

  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => listDocumentComments(userId, conversationId, path, signal),
  });

  const comments = query.data;
  const threads = useMemo(() => toThreads(comments ?? []), [comments]);

  /** Change the cached list (a read in flight would overwrite the change: it is cancelled). */
  const edit = useCallback(
    (change: (list: CanvasComment[]) => CanvasComment[]) => {
      void queryClient.cancelQueries({ queryKey: key });
      queryClient.setQueryData<CanvasComment[]>(key, (list) => change(list ?? []));
    },
    [queryClient, key],
  );

  /** The server's copy of a comment, in place of the local one (or added, if a read dropped it). */
  const settle = useCallback(
    (localId: string, saved: CanvasComment) =>
      edit((list) =>
        list.some((item) => item.id === localId)
          ? list.map((item) => (item.id === localId ? saved : item))
          : list.some((item) => item.id === saved.id)
            ? list
            : [...list, saved],
      ),
    [edit],
  );

  const add = useCallback(
    async (
      draft: { version: number; body: string; anchor?: CanvasCommentAnchor; parentId?: string },
      failure: string,
    ): Promise<CanvasComment | null> => {
      counter.current += 1;
      const now = new Date().toISOString();
      const local: CanvasComment = {
        id: `${LOCAL_PREFIX}${counter.current}`,
        path,
        version: draft.version,
        parentId: draft.parentId ?? null,
        anchor: draft.anchor ?? null,
        body: draft.body,
        author: "user",
        status: "open",
        resolvedBy: null,
        resolutionNote: null,
        createdAt: now,
        updatedAt: now,
      };
      edit((list) => [...list, local]);
      try {
        const saved = await createDocumentComment(userId, conversationId, { path, ...draft });
        settle(local.id, saved);
        return saved;
      } catch (error) {
        edit((list) => list.filter((item) => item.id !== local.id));
        toastError(toast, failure, error);
        return null;
      }
    },
    [edit, settle, toast, userId, conversationId, path],
  );

  /** Starts a thread on a passage of `version`; resolves to the saved thread, or null when refused. */
  const createThread = useCallback(
    (version: number, anchor: CanvasCommentAnchor, body: string) =>
      add({ version, anchor, body }, "Couldn't add the comment"),
    [add],
  );

  const reply = useCallback(
    (thread: CanvasComment, body: string) =>
      add({ version: thread.version, parentId: thread.id, body }, "Couldn't send the reply"),
    [add],
  );

  const patch = useCallback(
    async (comment: CanvasComment, change: CanvasCommentPatch, failure: string) => {
      // A comment still on its way has no id the bridge knows yet.
      if (isLocalComment(comment.id)) return;
      const before = comment;
      edit((list) =>
        list.map((item) =>
          item.id === comment.id
            ? {
                ...item,
                ...change,
                resolvedBy:
                  change.status === "resolved" ? "user" : change.status ? null : item.resolvedBy,
                // Reopening clears the resolution (the bridge does the same).
                resolutionNote: change.status === "open" ? null : item.resolutionNote,
              }
            : item,
        ),
      );
      try {
        const saved = await updateDocumentComment(userId, conversationId, comment.id, change);
        edit((list) => list.map((item) => (item.id === saved.id ? saved : item)));
      } catch (error) {
        edit((list) => list.map((item) => (item.id === before.id ? before : item)));
        toastError(toast, failure, error);
      }
    },
    [edit, toast, userId, conversationId],
  );

  const setStatus = useCallback(
    (thread: CanvasComment, status: CanvasComment["status"]) =>
      patch(
        thread,
        { status },
        status === "resolved" ? "Couldn't resolve the thread" : "Couldn't reopen the thread",
      ),
    [patch],
  );

  const editBody = useCallback(
    (comment: CanvasComment, body: string) => patch(comment, { body }, "Couldn't edit the comment"),
    [patch],
  );

  const remove = useCallback(
    async (comment: CanvasComment) => {
      if (isLocalComment(comment.id)) return;
      // A thread goes with its replies; they come back together if refused.
      const gone = (item: CanvasComment) => item.id === comment.id || item.parentId === comment.id;
      const removed = (queryClient.getQueryData<CanvasComment[]>(key) ?? []).filter(gone);
      edit((list) => list.filter((item) => !gone(item)));
      try {
        await deleteDocumentComment(userId, conversationId, comment.id);
      } catch (error) {
        edit((list) =>
          [...list.filter((item) => !gone(item)), ...removed].sort((a, b) =>
            a.createdAt.localeCompare(b.createdAt),
          ),
        );
        toastError(toast, "Couldn't delete the comment", error);
      }
    },
    [edit, queryClient, key, toast, userId, conversationId],
  );

  return {
    open: threads.open,
    resolved: threads.resolved,
    loading: query.isPending,
    errorMessage: query.isError ? (query.error?.message ?? "Failed to load the comments") : null,
    retry: query.refetch,
    createThread,
    reply,
    setStatus,
    editBody,
    remove,
  };
}

export type CanvasCommentsState = ReturnType<typeof useCanvasComments>;

/**
 * Which canvas document and passage a comment thread is on, for the agent's
 * `reply_to_comment` step (plan 44 v2). The tool's arguments carry only the
 * thread's id, which says nothing to a reader; the conversation already knows
 * more:
 *
 * - the user message an `@agent` comment sent (`canvasEdit.commentId` is the
 *   thread, `path` its document, `selection` its passage) — the usual case,
 *   since the agent replies to the thread that asked it;
 * - the comment lists the canvas has read (TanStack Query cache), for a
 *   thread the agent found in the turn's canvas note instead.
 *
 * Pure lookups only; `hooks/useCommentThreadRef.ts` feeds them. Nothing here
 * fetches: a thread that is in neither place is simply not named.
 */
import type { CanvasComment, MessageOut } from "@/shared/lib/types";

export type CommentThreadRef = { path: string; quote: string };

const sameId = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The thread from the user message an `@agent` comment sent, or null. */
export function threadFromMessages(
  threadId: string,
  messages: readonly MessageOut[] | undefined,
): CommentThreadRef | null {
  for (const message of messages ?? []) {
    const edit = message.canvasEdit;
    if (edit?.commentId && sameId(edit.commentId, threadId)) {
      return { path: edit.path, quote: edit.selection };
    }
  }
  return null;
}

/** The thread from comment lists already read (one list per document), or null. */
export function threadFromComments(
  threadId: string,
  lists: readonly (readonly CanvasComment[] | undefined)[],
): CommentThreadRef | null {
  for (const list of lists) {
    const thread = list?.find((comment) => comment.parentId === null && sameId(comment.id, threadId));
    if (thread?.anchor && thread.path) return { path: thread.path, quote: thread.anchor.quote };
  }
  return null;
}

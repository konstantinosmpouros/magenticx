import { useContext } from "react";
import { QueryClientContext } from "@tanstack/react-query";

import { canvasKey } from "@/features/canvas/lib/queryKeys";
import {
  type CommentThreadRef,
  threadFromComments,
  threadFromMessages,
} from "@/features/chat/lib/commentThreads";
import type { CanvasComment } from "@/shared/lib/types";
import { useWorkspaceStore } from "@/shared/stores/workspaceStore";

// The canvas's query keys all start `["canvas-documents", userId,
// conversationId, …]`; a comment list's fourth part is "comments".
const [CANVAS_ROOT] = canvasKey("", "");

/**
 * The document and passage of comment thread `threadId`, for the agent's
 * `reply_to_comment` step — or null when the conversation does not say (the
 * step is then titled without a document). Reads only what the page already
 * holds (see `lib/commentThreads.ts`); never fetches. Pass null to skip.
 *
 * The query client is read through its context rather than `useQueryClient`,
 * which throws where no provider is mounted (a test rendering a step alone).
 */
export function useCommentThreadRef(threadId: string | null): CommentThreadRef | null {
  const conversation = useWorkspaceStore((s) => s.currentConversation);
  const queryClient = useContext(QueryClientContext);
  if (!threadId) return null;
  const fromMessages = threadFromMessages(threadId, conversation?.messages);
  if (fromMessages || !queryClient || !conversation) return fromMessages;
  const lists = queryClient
    .getQueriesData<CanvasComment[]>({
      predicate: (query) =>
        query.queryKey[0] === CANVAS_ROOT &&
        query.queryKey[2] === conversation.id &&
        query.queryKey[3] === "comments",
    })
    .map(([, data]) => data);
  return threadFromComments(threadId, lists);
}

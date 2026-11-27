import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { getDocumentVersion } from "@/shared/lib/api";

import { canvasContentKey } from "../lib/queryKeys";
import { useCanvasBranchMessage } from "../lib/branch";

/**
 * The text of one version of a document, for the compare view (plan 44,
 * Phase 4.2), or null while it loads or when `version` is null. Shares its
 * cache entry with the canvas's own read of that version.
 */
export function useCanvasVersionText(
  userId: string,
  conversationId: string,
  path: string,
  version: number | null,
): string | null {
  const messageId = useCanvasBranchMessage();
  const query = useQuery({
    queryKey: canvasContentKey(userId, conversationId, messageId, path, version ?? 0),
    queryFn: ({ signal }) => getDocumentVersion(userId, conversationId, messageId, path, version ?? 0, signal),
    enabled: version !== null,
  });
  return version === null ? null : (query.data?.content ?? null);
}

/** Read one version's text on demand (Restore), from the cache when it is there. */
export function useFetchCanvasVersionText(userId: string, conversationId: string, path: string) {
  const messageId = useCanvasBranchMessage();
  const queryClient = useQueryClient();
  return useCallback(
    async (version: number): Promise<string> => {
      const data = await queryClient.fetchQuery({
        queryKey: canvasContentKey(userId, conversationId, messageId, path, version),
        queryFn: ({ signal }) => getDocumentVersion(userId, conversationId, messageId, path, version, signal),
      });
      return data.content;
    },
    [queryClient, userId, conversationId, messageId, path],
  );
}

import { useEffect, useState } from "react";

import { onCanvasThread, takeCanvasThread } from "../lib/pendingThread";

/**
 * The comment thread a chat card asked this canvas to open (`pendingThread`,
 * plan 44 v2): taken when the canvas mounts for the path, and heard while it
 * is open. A new request is a new object, so asking for the same thread
 * twice opens it twice. `clear` is called once the canvas has opened it.
 */
export function useRequestedThread(path: string): {
  request: { commentId: string; nonce: number } | null;
  clear: () => void;
} {
  const [request, setRequest] = useState<{ commentId: string; nonce: number } | null>(() => {
    const waiting = takeCanvasThread(path);
    return waiting ? { commentId: waiting.commentId, nonce: Date.now() } : null;
  });

  useEffect(
    () =>
      onCanvasThread((heard) => {
        if (heard.path !== path) return;
        takeCanvasThread(path); // handled here: nobody else takes it
        setRequest({ commentId: heard.commentId, nonce: Date.now() });
      }),
    [path],
  );

  return { request, clear: () => setRequest(null) };
}

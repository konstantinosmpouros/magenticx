import { useEffect, useRef, useState } from "react";

import { listDocumentVersions } from "@/shared/lib/api";
import type { CanvasShineTexts } from "@/shared/lib/types";

import { changedTexts } from "../lib/changeShine";
import { onCanvasShine, takeCanvasShine, type CanvasShineRequest } from "../lib/pendingShine";
import { useCanvasBranchMessage } from "../lib/branch";

/**
 * The texts an Ask agent card asked this canvas to shine (`pendingShine`):
 * what the agent wrote for that request — the blocks that are new in the
 * agent's first version after the request's version. Taken when the canvas
 * mounts for the path, and heard while it is open. Null until worked out, or
 * when there is nothing to show (no agent version after it, a failed read).
 */
export function useRequestedShine(
  userId: string,
  conversationId: string,
  path: string,
  fetchVersionText: (version: number) => Promise<string>,
): CanvasShineTexts | null {
  const messageId = useCanvasBranchMessage();
  const [shine, setShine] = useState<CanvasShineTexts | null>(null);
  const fetchRef = useRef(fetchVersionText);
  fetchRef.current = fetchVersionText;

  useEffect(() => {
    let alive = true;
    const handle = async (request: CanvasShineRequest) => {
      if (request.path !== path) return;
      takeCanvasShine(path); // handled here: nobody else takes it
      try {
        const versions = await listDocumentVersions(userId, conversationId, messageId, path);
        const agentVersion = versions
          .filter((meta) => meta.author === "agent" && meta.version > request.afterVersion)
          .sort((a, b) => a.version - b.version)[0];
        if (!agentVersion) return;
        const [before, after] = await Promise.all([
          fetchRef.current(request.afterVersion),
          fetchRef.current(agentVersion.version),
        ]);
        const texts = changedTexts(before, after);
        if (alive && texts.length > 0) setShine({ id: Date.now(), texts });
      } catch {
        // Nothing to show: the document opens without a shine.
      }
    };
    const waiting = takeCanvasShine(path);
    if (waiting) void handle(waiting);
    const stop = onCanvasShine((request) => void handle(request));
    return () => {
      alive = false;
      stop();
    };
  }, [userId, conversationId, messageId, path]);

  return shine;
}

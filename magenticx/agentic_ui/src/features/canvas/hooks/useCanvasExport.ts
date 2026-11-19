import { useCallback, useRef, useState } from "react";

import { exportDocument } from "@/shared/lib/api";
import { triggerBrowserDownload } from "@/shared/lib/download";
import { useToast } from "@/shared/hooks/use-toast";
import { toastError } from "@/shared/lib/toast";
import type { CanvasExportFormat } from "@/shared/lib/types";

/**
 * Export the open document (plan 44, Phase 4.5): one version as Word, PDF or
 * Markdown, saved to disk with the name the server gave it. One export at a
 * time — the menu shows which one is running. A failure becomes a toast:
 * the sandbox down (503) and a timeout (504) carry their own words
 * (`exportDocument`).
 */
export function useCanvasExport({
  userId,
  conversationId,
  path,
  title,
}: {
  userId: string;
  conversationId: string;
  /** The document's path as the documents API returned it. */
  path: string;
  /** The document's title: the file's name when the server sends none. */
  title: string;
}) {
  const { toast } = useToast();
  const [pending, setPending] = useState<CanvasExportFormat | null>(null);
  const running = useRef(false);

  const run = useCallback(
    async (format: CanvasExportFormat, version: number | null): Promise<boolean> => {
      if (running.current) return false;
      running.current = true;
      setPending(format);
      try {
        const file = await exportDocument(
          userId,
          conversationId,
          { path, format, ...(version === null ? {} : { version }) },
          `${title || "document"}.${format}`,
        );
        triggerBrowserDownload(file.blob, file.filename);
        return true;
      } catch (error) {
        toastError(toast, "Couldn't export the document", error);
        return false;
      } finally {
        running.current = false;
        setPending(null);
      }
    },
    [userId, conversationId, path, title, toast],
  );

  return { pending, run };
}

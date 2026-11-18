/**
 * The generated file behind a canvas document, found in the open
 * conversation's messages: when the document has no versions (404), the
 * canvas offers the file's normal preview instead, and that preview needs the
 * attachment and its message. The presented copy wins over another file of
 * the same path; the newest message wins over older ones.
 */
import { canvasDocumentPath } from "@/shared/lib/canvasDocuments";
import type { AttachmentOut, MessageOut } from "@/shared/lib/types";

export function findCanvasFile(
  messages: readonly MessageOut[],
  path: string,
): { attachment: AttachmentOut; message: MessageOut } | null {
  let found: { attachment: AttachmentOut; message: MessageOut } | null = null;
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      if (attachment.origin !== "generated" || !attachment.blobId) continue;
      const own = canvasDocumentPath({
        fileName: attachment.name,
        sourcePath: attachment.sourcePath,
      });
      if (own !== path) continue;
      if (!found || attachment.presented || !found.attachment.presented)
        found = { attachment, message };
    }
  }
  return found;
}

/**
 * Attachment blob API — download to disk, fetch for in-browser preview, mint
 * the short-lived DOCX preview token, and list the user's files across
 * conversations (the Artifacts page, plan 44).
 */
import type {
  DocxPreviewTokenResponse,
  DownloadAttachmentParams,
  UserFileKind,
  UserFileType,
  UserFilesPage,
} from "../types";
import { requestBlob, requestJson } from "../http";
import { triggerBrowserDownload } from "../download";
import { DocxPreviewTokenSchema, UserFilesPageSchema } from "../schemas";
import { ATTACHMENTS_BASE_PATH } from "./paths";

// Download an attachment blob
export async function downloadAttachment({
  userId,
  conversationId,
  messageId,
  blobId,
  filename,
}: DownloadAttachmentParams): Promise<void> {
  const blob = await fetchAttachmentBlob({
    userId,
    conversationId,
    messageId,
    blobId,
  });
  triggerBrowserDownload(blob, filename);
}

// Fetch for preview an attachment blob from the backend
export async function fetchAttachmentBlob({
  userId,
  conversationId,
  messageId,
  blobId,
}: Omit<DownloadAttachmentParams, "filename">): Promise<Blob> {
  const url = `${ATTACHMENTS_BASE_PATH}/download/${userId}/${conversationId}/${messageId}/${blobId}`;
  return requestBlob(url, {
    accept: null,
    fallbackMessage: "Failed to download attachment",
  });
}

export function getAttachmentPreviewUrl({
  userId,
  conversationId,
  messageId,
  blobId,
}: Omit<DownloadAttachmentParams, "filename">): string {
  const segments = [userId, conversationId, messageId, blobId].map((value) =>
    encodeURIComponent(value),
  );
  return `${ATTACHMENTS_BASE_PATH}/preview/${segments.join("/")}`;
}

// Fetch a blob through the inline preview endpoint for in-browser renderers.
export async function fetchAttachmentPreviewBlob({
  userId,
  conversationId,
  messageId,
  blobId,
}: Omit<DownloadAttachmentParams, "filename">): Promise<Blob> {
  return requestBlob(getAttachmentPreviewUrl({ userId, conversationId, messageId, blobId }), {
    accept: null,
    fallbackMessage: "Failed to preview attachment",
  });
}

export async function fetchDocxPreviewToken({
  userId,
  conversationId,
  messageId,
  blobId,
}: Omit<DownloadAttachmentParams, "filename">): Promise<DocxPreviewTokenResponse> {
  const segments = [userId, conversationId, messageId, blobId].map(encodeURIComponent);
  return requestJson(`${ATTACHMENTS_BASE_PATH}/preview-token/${segments.join("/")}`, {
    schema: DocxPreviewTokenSchema,
    fallbackMessage: "Failed to obtain preview token",
  });
}

export type ListUserFilesParams = {
  kind?: UserFileKind | null;
  type?: UserFileType | null;
  q?: string | null;
  cursor?: string | null;
  limit?: number;
};

/**
 * One keyset page of the user's files, newest first — uploads ("input") and
 * the files agents presented ("output"), across every conversation the user
 * can open. Metadata only: open a file through the download / preview calls
 * above with the ids each row carries.
 */
export async function listUserFiles(
  userId: string,
  params: ListUserFilesParams = {},
  signal?: AbortSignal,
): Promise<UserFilesPage> {
  const query = new URLSearchParams();
  if (params.kind) query.set("kind", params.kind);
  if (params.type) query.set("type", params.type);
  const q = params.q?.trim();
  if (q) query.set("q", q);
  if (params.cursor) query.set("cursor", params.cursor);
  if (params.limit) query.set("limit", String(params.limit));
  const text = query.toString();
  const path = `${ATTACHMENTS_BASE_PATH}/files/${encodeURIComponent(userId)}`;
  return requestJson(text ? `${path}?${text}` : path, {
    schema: UserFilesPageSchema,
    signal,
    fallbackMessage: "Failed to load your files",
  });
}

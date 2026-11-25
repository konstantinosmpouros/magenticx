// ------------------------------------------------------
// Attachment Schemas
// ------------------------------------------------------
// `DocxPreviewTokenResponse` is inferred from its Zod schema (see `../schemas`).
export type { DocxPreviewTokenResponse } from "../schemas";
// The Artifacts page's listing (plan 44), inferred the same way.
export type { UserFile, UserFileKind, UserFileType, UserFilesPage } from "../schemas";

// Backend attachment type from API response
export type AttachmentOut = {
  id: string;
  name: string;
  mime: string;
  size?: number;
  timestamp: Date;
  blobId?: string;
  data?: string; // Base64 encoded data for images and public share downloads
  // Provenance + agent-supplied display metadata. "upload" (default) for
  // user-attached files, "generated" for every file the agent wrote;
  // `presented` marks the ones it showed via present_artifact (they have a
  // card and title/summary).
  origin?: "upload" | "generated";
  title?: string;
  summary?: string;
  presented?: boolean;
  // The virtual path a generated file was presented at (e.g.
  // `/conversation/output/brief.md`); undefined for uploads and older rows.
  sourcePath?: string;
};

/**
 * The files an edited message will carry: the ids of the edited message's
 * uploads the user kept, and the new files they added. An edit is a new
 * message, so anything not kept here stays on the old branch only.
 */
export type EditAttachments = {
  keptIds: string[];
  files: File[];
};

// Attachment input for API requests (base64 format)
export type AttachmentIn = {
  name: string;
  mime: string;
  dataB64: string;
  size?: number;
};

// Parameters required to download an attachment from the backend
export type DownloadAttachmentParams = {
  userId: string;
  conversationId: string;
  messageId: string;
  blobId: string;
  filename?: string;
};

// File upload attachment type for UI
export type FileAttachment = {
  file: File;
  url: string;
  name: string;
  type: string;
};

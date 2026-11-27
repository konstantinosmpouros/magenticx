/**
 * Canvas documents (plan 44, Phase 4.1): the reads behind the read-only canvas.
 * A document is a presented `.md` file under `/conversation/output/`. The
 * routes sit under `/conversations/{userId}/{conversationId}/documents` like
 * the conversation's other reads; the bridge checks the session, that the
 * user is the caller and that the conversation is theirs (404
 * otherwise, never an existence leak) and passes the agents service's answer
 * through. The document's path travels as a query parameter, never in the URL
 * path, so a nested path needs no escaping rules of its own.
 *
 * Documents are kept per branch of the conversation: every call names
 * `messageId`, a message of the branch on screen, and the bridge resolves the
 * branch from it (the browser never names one itself).
 */
import type {
  CanvasComment,
  CanvasCommentDraft,
  CanvasCommentPatch,
  CanvasDocumentSuggestion,
  CanvasDocumentSummary,
  CanvasExportFile,
  CanvasExportFormat,
  CanvasDocumentVersion,
  CanvasDocumentVersionMeta,
  CanvasSaveResult,
} from "../types";
import { getFilenameFromDisposition } from "../download";
import { ApiError, requestJson, requestRaw, requestVoid } from "../http";
import {
  CanvasCommentListSchema,
  CanvasCommentSchema,
  CanvasDocumentListSchema,
  CanvasDocumentSavedSchema,
  CanvasDocumentSuggestionSchema,
  CanvasDocumentVersionSchema,
  CanvasDocumentVersionsSchema,
  CanvasStaleBaseSchema,
} from "../schemas";
import { CONVERSATIONS_BASE_PATH } from "./paths";

const documentsUrl = (
  userId: string,
  conversationId: string,
  messageId: string,
  suffix: string,
  path?: string,
): string => {
  const base = `${CONVERSATIONS_BASE_PATH}/${encodeURIComponent(userId)}/${encodeURIComponent(conversationId)}/documents${suffix}`;
  const query = new URLSearchParams(path === undefined ? { messageId } : { messageId, path });
  return `${base}?${query}`;
};

/** The conversation's canvas documents, latest version each, newest first. */
export async function listConversationDocuments(
  userId: string,
  conversationId: string,
  messageId: string,
  signal?: AbortSignal,
): Promise<CanvasDocumentSummary[]> {
  return requestJson(documentsUrl(userId, conversationId, messageId, ""), {
    schema: CanvasDocumentListSchema,
    fallbackMessage: "Failed to load the conversation's documents",
    signal,
  });
}

/**
 * The latest version of one document, with its markdown. Production fails
 * open on a schema mismatch and hands back the raw body; parsing it again
 * (the transform is idempotent on its own output) turns a version without its
 * markdown into an error the canvas shows, never an empty document.
 */
export async function getLatestDocument(
  userId: string,
  conversationId: string,
  messageId: string,
  path: string,
  signal?: AbortSignal,
): Promise<CanvasDocumentVersion> {
  const data = await requestJson(documentsUrl(userId, conversationId, messageId, "/latest", path), {
    schema: CanvasDocumentVersionSchema,
    fallbackMessage: "Failed to load the document",
    signal,
  });
  return CanvasDocumentVersionSchema.parse(data);
}

/** Every version of one document (author, base, date), newest first. */
export async function listDocumentVersions(
  userId: string,
  conversationId: string,
  messageId: string,
  path: string,
  signal?: AbortSignal,
): Promise<CanvasDocumentVersionMeta[]> {
  const data = await requestJson(documentsUrl(userId, conversationId, messageId, "/versions", path), {
    schema: CanvasDocumentVersionsSchema,
    fallbackMessage: "Failed to load the document's versions",
    signal,
  });
  return data.versions;
}

/**
 * Save the user's text as the document's next version (plan 44, Phase 4.2).
 * `baseVersion` is the version the edit started from: when it is no longer
 * the latest (the agent or another tab saved meanwhile), the bridge answers
 * 409 with the latest version and its text, and this resolves to a
 * `conflict` instead of throwing — never last-write-wins. The save is a
 * state change, so it carries the CSRF token; every other failure (429, 422
 * over the size cap, 5xx) throws an `ApiError`.
 */
export async function saveDocumentVersion(
  userId: string,
  conversationId: string,
  messageId: string,
  save: { path: string; baseVersion: number; content: string },
  signal?: AbortSignal,
): Promise<CanvasSaveResult> {
  try {
    const data = await requestJson(documentsUrl(userId, conversationId, messageId, "/versions"), {
      method: "POST",
      csrf: true,
      body: { path: save.path, base_version: save.baseVersion, content: save.content },
      schema: CanvasDocumentSavedSchema,
      fallbackMessage: "Failed to save the document",
      errorMessages: { 429: "Saving too often. Wait a moment, then try again." },
      signal,
    });
    // Re-parsed like the reads: a fail-open body without a version number
    // must not become the base of the next save.
    return { kind: "saved", ...CanvasDocumentSavedSchema.parse(data) };
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      const stale = CanvasStaleBaseSchema.safeParse(error.detailObject);
      if (stale.success) return { kind: "conflict", ...stale.data };
    }
    throw error;
  }
}

const SUGGESTION_ERRORS = { 429: "Saving too often. Wait a moment, then try again." };

/**
 * The document's pending suggestion set (plan 44, Phase 4.6), or null when
 * it has none (404 `no_suggestion`). Re-parsed like the latest version: a set
 * without its base version or text must never be drawn over the document.
 */
export async function getDocumentSuggestion(
  userId: string,
  conversationId: string,
  messageId: string,
  path: string,
  signal?: AbortSignal,
): Promise<CanvasDocumentSuggestion | null> {
  const res = await requestRaw(documentsUrl(userId, conversationId, messageId, "/suggestion", path), {
    fallbackMessage: "Failed to load the suggestions",
    ignoreStatuses: [404],
    signal,
  });
  if (res.status === 404) return null;
  return CanvasDocumentSuggestionSchema.parse(await res.json());
}

/**
 * Save the user's suggestion set: `content` is the proposed markdown (every
 * suggestion accepted) on `baseVersion`. Resolves to the saved set, or null
 * when the server found nothing suggested (the text equalled the base: 204,
 * the set is gone). CSRF like every state change.
 */
export async function putDocumentSuggestion(
  userId: string,
  conversationId: string,
  messageId: string,
  set: { path: string; baseVersion: number; content: string },
): Promise<CanvasDocumentSuggestion | null> {
  const res = await requestRaw(documentsUrl(userId, conversationId, messageId, "/suggestion"), {
    method: "PUT",
    csrf: true,
    body: { path: set.path, baseVersion: set.baseVersion, content: set.content },
    fallbackMessage: "Failed to save the suggestions",
    errorMessages: SUGGESTION_ERRORS,
  });
  if (res.status === 204) return null;
  return CanvasDocumentSuggestionSchema.parse(await res.json());
}

/** Drop the document's suggestion set (idempotent: 204 whether or not there was one). */
export async function deleteDocumentSuggestion(
  userId: string,
  conversationId: string,
  messageId: string,
  path: string,
): Promise<void> {
  await requestVoid(documentsUrl(userId, conversationId, messageId, "/suggestion", path), {
    method: "DELETE",
    csrf: true,
    fallbackMessage: "Failed to discard the suggestions",
    errorMessages: SUGGESTION_ERRORS,
  });
}

/** Version `version` of one document, with its markdown (re-parsed like the latest). */
export async function getDocumentVersion(
  userId: string,
  conversationId: string,
  messageId: string,
  path: string,
  version: number,
  signal?: AbortSignal,
): Promise<CanvasDocumentVersion> {
  const data = await requestJson(
    documentsUrl(userId, conversationId, messageId, `/versions/${encodeURIComponent(String(version))}`, path),
    {
      schema: CanvasDocumentVersionSchema,
      fallbackMessage: "Failed to load this version of the document",
      signal,
    },
  );
  return CanvasDocumentVersionSchema.parse(data);
}

// ---------------------------------------------------------------------------
// Comments (plan 44, Phase 4.4): the user's threads on passages of a document,
// and their replies. Reads share the documents' read limit; every write
// carries the CSRF token and has its own limit (DOCUMENT_COMMENT, 60/60s).
// ---------------------------------------------------------------------------

/**
 * A refused comment says why: the agents service's 422 carries
 * `{code: invalid_comment | thread_limit | reply_limit, message}` and its
 * `message` becomes the error's (`requestJson` reads it); a 422 without one
 * (FastAPI's shape list) falls back to each call's own words.
 */
const COMMENT_ERRORS = { 429: "Commenting too often. Wait a moment, then try again." };

/** A document's threads and replies, oldest first; resolved ones included (the canvas filters). */
export async function listDocumentComments(
  userId: string,
  conversationId: string,
  messageId: string,
  path: string,
  signal?: AbortSignal,
): Promise<CanvasComment[]> {
  return requestJson(documentsUrl(userId, conversationId, messageId, "/comments", path), {
    schema: CanvasCommentListSchema,
    fallbackMessage: "Failed to load the comments",
    signal,
  });
}

/**
 * Start a thread on a passage (`anchor`, no `parentId`) or reply to one
 * (`parentId`, no `anchor`). Re-parsed like a save: a fail-open body without
 * an id could never be replied to or resolved.
 */
export async function createDocumentComment(
  userId: string,
  conversationId: string,
  messageId: string,
  draft: CanvasCommentDraft,
): Promise<CanvasComment> {
  const data = await requestJson(documentsUrl(userId, conversationId, messageId, "/comments"), {
    method: "POST",
    csrf: true,
    body: {
      path: draft.path,
      version: draft.version,
      body: draft.body,
      ...(draft.anchor ? { anchor: draft.anchor } : {}),
      ...(draft.parentId ? { parentId: draft.parentId } : {}),
    },
    schema: CanvasCommentSchema,
    fallbackMessage: "That comment cannot be saved.",
    errorMessages: COMMENT_ERRORS,
  });
  return CanvasCommentSchema.parse(data);
}

/** Resolve or reopen a thread, or edit one's own comment. */
export async function updateDocumentComment(
  userId: string,
  conversationId: string,
  messageId: string,
  commentId: string,
  patch: CanvasCommentPatch,
): Promise<CanvasComment> {
  const data = await requestJson(
    documentsUrl(userId, conversationId, messageId, `/comments/${encodeURIComponent(commentId)}`),
    {
      method: "PATCH",
      csrf: true,
      body: patch,
      schema: CanvasCommentSchema,
      fallbackMessage: "That comment cannot be saved.",
      errorMessages: COMMENT_ERRORS,
    },
  );
  return CanvasCommentSchema.parse(data);
}

/** Delete one's own comment; a thread goes with its replies. */
export async function deleteDocumentComment(
  userId: string,
  conversationId: string,
  messageId: string,
  commentId: string,
): Promise<void> {
  await requestVoid(
    documentsUrl(userId, conversationId, messageId, `/comments/${encodeURIComponent(commentId)}`),
    {
      method: "DELETE",
      csrf: true,
      fallbackMessage: "Failed to delete the comment",
      errorMessages: COMMENT_ERRORS,
    },
  );
}

// ---------------------------------------------------------------------------
// Export (plan 44, Phase 4.5): a version of the document as Word, PDF or
// Markdown. Word and PDF are converted in the sandbox box by a fixed command,
// so they can be unavailable (503) or slow (504); Markdown is the stored text.
// ---------------------------------------------------------------------------

const EXPORT_ACCEPT: Record<CanvasExportFormat, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  md: "text/markdown",
};

/**
 * Export one version (the latest when `version` is absent) and hand back the
 * file with the server's name for it (`Content-Disposition`), or
 * `fallbackName` when it sent none. A state change only in what it costs (a
 * box run), so it is a POST with the CSRF token.
 */
export async function exportDocument(
  userId: string,
  conversationId: string,
  messageId: string,
  request: { path: string; format: CanvasExportFormat; version?: number },
  fallbackName: string,
): Promise<CanvasExportFile> {
  const res = await requestRaw(documentsUrl(userId, conversationId, messageId, "/export"), {
    method: "POST",
    csrf: true,
    accept: EXPORT_ACCEPT[request.format],
    body: {
      path: request.path,
      format: request.format,
      ...(request.version === undefined ? {} : { version: request.version }),
    },
    fallbackMessage: "The export failed",
    errorMessages: {
      429: "Exporting too often. Wait a moment, then try again.",
      // The box ran the conversion but it made no file.
      502: "The export failed",
      // The box can't run (or is busy), or the agents service is unreachable.
      503: "Export needs the sandbox, which isn't available right now",
      504: "The export took too long. Try again in a moment.",
    },
  });
  const blob = await res.blob();
  return {
    blob,
    filename: getFilenameFromDisposition(res.headers.get("Content-Disposition"), fallbackName),
  };
}

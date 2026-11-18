/**
 * Canvas documents (plan 44, Phase 4.1): the reads behind the read-only canvas.
 * A document is a presented `.md` file under `/conversation/output/`. The
 * routes sit under `/conversations/{userId}/{conversationId}/documents` like
 * the conversation's other reads; the bridge checks the session, that the
 * user is the caller and that the conversation is theirs (404
 * otherwise, never an existence leak) and passes the agents service's answer
 * through. The document's path travels as a query parameter, never in the URL
 * path, so a nested path needs no escaping rules of its own.
 */
import type {
  CanvasDocumentSummary,
  CanvasDocumentVersion,
  CanvasDocumentVersionMeta,
  CanvasSaveResult,
} from "../types";
import { ApiError, requestJson } from "../http";
import {
  CanvasDocumentListSchema,
  CanvasDocumentSavedSchema,
  CanvasDocumentVersionSchema,
  CanvasDocumentVersionsSchema,
  CanvasStaleBaseSchema,
} from "../schemas";
import { CONVERSATIONS_BASE_PATH } from "./paths";

const documentsUrl = (
  userId: string,
  conversationId: string,
  suffix: string,
  path?: string,
): string => {
  const base = `${CONVERSATIONS_BASE_PATH}/${encodeURIComponent(userId)}/${encodeURIComponent(conversationId)}/documents${suffix}`;
  return path === undefined ? base : `${base}?${new URLSearchParams({ path })}`;
};

/** The conversation's canvas documents, latest version each, newest first. */
export async function listConversationDocuments(
  userId: string,
  conversationId: string,
  signal?: AbortSignal,
): Promise<CanvasDocumentSummary[]> {
  return requestJson(documentsUrl(userId, conversationId, ""), {
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
  path: string,
  signal?: AbortSignal,
): Promise<CanvasDocumentVersion> {
  const data = await requestJson(documentsUrl(userId, conversationId, "/latest", path), {
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
  path: string,
  signal?: AbortSignal,
): Promise<CanvasDocumentVersionMeta[]> {
  const data = await requestJson(documentsUrl(userId, conversationId, "/versions", path), {
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
  save: { path: string; baseVersion: number; content: string },
  signal?: AbortSignal,
): Promise<CanvasSaveResult> {
  try {
    const data = await requestJson(documentsUrl(userId, conversationId, "/versions"), {
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

/** Version `version` of one document, with its markdown (re-parsed like the latest). */
export async function getDocumentVersion(
  userId: string,
  conversationId: string,
  path: string,
  version: number,
  signal?: AbortSignal,
): Promise<CanvasDocumentVersion> {
  const data = await requestJson(
    documentsUrl(userId, conversationId, `/versions/${encodeURIComponent(String(version))}`, path),
    {
      schema: CanvasDocumentVersionSchema,
      fallbackMessage: "Failed to load this version of the document",
      signal,
    },
  );
  return CanvasDocumentVersionSchema.parse(data);
}

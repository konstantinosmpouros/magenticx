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
} from "../types";
import { requestJson } from "../http";
import {
  CanvasDocumentListSchema,
  CanvasDocumentVersionSchema,
  CanvasDocumentVersionsSchema,
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

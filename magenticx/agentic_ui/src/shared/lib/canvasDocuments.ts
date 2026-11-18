/**
 * Which files are canvas documents, and the URL that opens one (plan 44,
 * Phase 4.1). Shared because three features ask: the chat's artifact card,
 * the Artifacts page and the canvas itself.
 *
 * A canvas document is a `.md` file the agent presented under
 * `/conversation/output/`; Office files and PDFs never are (they are
 * previewed). The open document rides in the conversation's URL as
 * `?doc=<path>`, so a reload or a shared tab reopens it.
 */

/** Where the agent's deliverables live in its filesystem. */
export const CANVAS_OUTPUT_DIR = "/conversation/output/";

/** The search parameter that holds the open document's path. */
export const CANVAS_DOC_PARAM = "doc";

/**
 * Whether `path` can name a canvas document: absolute under the output
 * folder, ending `.md`, with no empty, `.` or `..` segment. The agents service
 * validates the same rule; checking it here keeps a hand-edited URL from
 * sending junk to the bridge at all.
 */
export function isCanvasDocumentPath(path: string): boolean {
  if (!path.startsWith(CANVAS_OUTPUT_DIR) || !path.endsWith(".md")) return false;
  const rest = path.slice(CANVAS_OUTPUT_DIR.length).split("/");
  return rest.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * The canvas document a generated file is, or null: its presented path when
 * the bridge recorded one, else the output folder plus its name (files stored
 * before the path was recorded) — and only for `.md`.
 */
export function canvasDocumentPath(file: {
  fileName: string;
  sourcePath?: string | null;
}): string | null {
  const path = file.sourcePath ?? `${CANVAS_OUTPUT_DIR}${file.fileName}`;
  return isCanvasDocumentPath(path) ? path : null;
}

/** The URL of conversation `conversationId` with canvas document `path` open. */
export function canvasDocumentHref(conversationId: string, path: string): string {
  const query = new URLSearchParams({ [CANVAS_DOC_PARAM]: path });
  return `/c/${encodeURIComponent(conversationId)}?${query}`;
}

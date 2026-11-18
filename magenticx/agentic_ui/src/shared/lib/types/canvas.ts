/**
 * Contracts of the document canvas (plan 44, Phase 4). The wire shapes — a
 * conversation's documents, a document's versions, one version with its
 * markdown — are inferred from their Zod schemas in `../schemas`; the rest are
 * the canvas's own view types.
 */
export type {
  CanvasDocumentAuthor,
  CanvasDocumentSummary,
  CanvasDocumentVersion,
  CanvasDocumentVersionMeta,
} from "../schemas";

import type { CanvasDocumentAuthor, CanvasDocumentVersionMeta } from "../schemas";

/** A heading in the document's outline. */
export interface CanvasOutlineItem {
  /** Index of the heading among the document's top-level blocks. */
  index: number;
  level: number;
  text: string;
}

/**
 * The byline under the document's title: the shown version, who wrote it and
 * when, and the document's version history to switch between (read-only).
 */
export interface CanvasBylineValue {
  version: number;
  author: CanvasDocumentAuthor;
  /** ISO timestamp of the shown version. */
  createdAt: string;
  /** Whether the shown version is the document's latest. */
  isLatest: boolean;
  /** The document's versions, newest first, once loaded (null while not). */
  versions: CanvasDocumentVersionMeta[] | null;
  versionsLoading: boolean;
  /** Asks for the version list (the menu opened). */
  onLoadVersions: () => void;
  /** Shows version `n`, or the latest for `null`. */
  onPickVersion: (version: number | null) => void;
}

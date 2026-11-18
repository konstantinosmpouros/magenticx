/**
 * Contracts of the document canvas (plan 44, Phase 4). The wire shapes — a
 * conversation's documents, a document's versions, one version with its
 * markdown — are inferred from their Zod schemas in `../schemas`; the rest are
 * the canvas's own view types.
 */
export type {
  CanvasDocumentAuthor,
  CanvasDocumentSaved,
  CanvasDocumentSummary,
  CanvasDocumentVersion,
  CanvasDocumentVersionMeta,
  CanvasStaleBase,
} from "../schemas";

import type { CanvasDocumentSaved, CanvasStaleBase } from "../schemas";

/**
 * What a save from the canvas came to: the new version, or — when the
 * version it was based on is no longer the latest — the latest version and
 * its text, for the conflict dialog. Any other failure is thrown.
 */
export type CanvasSaveResult =
  | ({ kind: "saved" } & CanvasDocumentSaved)
  | ({ kind: "conflict" } & CanvasStaleBase);

import type { CanvasDocumentAuthor, CanvasDocumentVersionMeta } from "../schemas";

/** The canvas's mode (plan 44 §3): edit the text, or read it. Suggesting is Phase 4.6. */
export type CanvasMode = "editing" | "viewing";

/**
 * Where the open document's edits stand (the header's status, Phase 4.2):
 * every edit saved; edited and not saved yet; a save on its way; the last
 * save failed (Retry); or refused because someone saved first (the dialog).
 */
export type CanvasSaveStatus = "saved" | "unsaved" | "saving" | "failed" | "conflict";

/** A save refused because the version it was based on is no longer the latest. */
export interface CanvasSaveConflict {
  /** The latest version, saved by the agent or another tab. */
  currentVersion: number;
  currentContent: string;
  /** The user's text that was refused. */
  mine: string;
}

/** The version the editor's text is based on: what the byline shows while editing. */
export interface CanvasEditHead {
  version: number;
  author: CanvasDocumentAuthor;
  createdAt: string;
}

/** Everything the canvas shows about saving. */
export interface CanvasSaveState {
  status: CanvasSaveStatus;
  head: CanvasEditHead;
  conflict: CanvasSaveConflict | null;
  /** Why the last save failed, when `status` is `failed`. */
  errorMessage: string | null;
}

/**
 * What the compare view shows: two versions of the document, or — from the
 * conflict dialog — the version that won against the user's unsaved text.
 */
export type CanvasCompareState =
  | { kind: "versions"; from: number; to: number }
  | { kind: "conflict"; version: number; theirs: string; mine: string };

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

// The compare view's diff (features/canvas/lib/documentDiff.ts).

/** One run of text inside a line: kept, inserted or deleted. */
export interface CanvasDiffPiece {
  kind: "same" | "added" | "removed";
  text: string;
}

/** A line of the compare view (it may hold both inserted and deleted words). */
export interface CanvasDiffRow {
  kind: "same" | "changed";
  pieces: CanvasDiffPiece[];
}

/** A row to show, or a fold of unchanged rows. */
export type CanvasDiffItem = { type: "row"; row: CanvasDiffRow } | { type: "fold"; rows: CanvasDiffRow[] };

export interface CanvasDocumentDiff {
  items: CanvasDiffItem[];
  added: number;
  removed: number;
}

/** The text the canvas editor (re)mounts with; a new `key` remounts it. */
export interface CanvasEditorSource {
  key: number;
  markdown: string;
}

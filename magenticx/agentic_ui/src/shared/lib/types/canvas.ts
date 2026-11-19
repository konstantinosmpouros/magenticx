/**
 * Contracts of the document canvas (plan 44, Phase 4). The wire shapes — a
 * conversation's documents, a document's versions, one version with its
 * markdown — are inferred from their Zod schemas in `../schemas`; the rest are
 * the canvas's own view types.
 */
export type {
  CanvasComment,
  CanvasCommentAnchor,
  CanvasDocumentAuthor,
  CanvasDocumentSaved,
  CanvasDocumentSummary,
  CanvasDocumentVersion,
  CanvasDocumentVersionMeta,
  CanvasEditPreset,
  CanvasEditRef,
  CanvasStaleBase,
} from "../schemas";

import type { TRange } from "platejs";

import type { CanvasDocumentSaved, CanvasEditPreset, CanvasStaleBase } from "../schemas";

/**
 * What a save from the canvas came to: the new version, or — when the
 * version it was based on is no longer the latest — the latest version and
 * its text, for the conflict dialog. Any other failure is thrown.
 */
export type CanvasSaveResult =
  ({ kind: "saved" } & CanvasDocumentSaved) | ({ kind: "conflict" } & CanvasStaleBase);

import type { CanvasDocumentAuthor } from "../schemas";

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
 * when. Its version chip is the way into the document's history panel.
 */
export interface CanvasBylineValue {
  version: number;
  author: CanvasDocumentAuthor;
  /** ISO timestamp of the shown version. */
  createdAt: string;
  /** Whether the shown version is the document's latest. */
  isLatest: boolean;
  /** Whether the history panel is open (the chip shows it pressed). */
  historyOpen: boolean;
  /** Opens (or closes) the history panel: versions, compare, restore. */
  onToggleHistory: () => void;
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
export type CanvasDiffItem =
  { type: "row"; row: CanvasDiffRow } | { type: "fold"; rows: CanvasDiffRow[] };

export interface CanvasDocumentDiff {
  items: CanvasDiffItem[];
  added: number;
  removed: number;
}

/** The text the canvas editor (re)mounts with; a new `key` remounts it. */
/** What the open editor should shine, by block text (an Ask agent card's change); a new id shines again. */
export interface CanvasShineTexts {
  id: number;
  texts: string[];
}

export interface CanvasEditorSource {
  key: number;
  markdown: string;
  /** The text before an agent's version was loaded: what changed shines once. */
  previous?: string;
}

/** Ask agent (Phase 4.3): the passage the user picked — its text, where it sits, its range (the highlight). */
export interface CanvasAskPassage {
  text: string;
  /** The headings above it, outermost first. */
  headingPath: string[];
  range: TRange;
}

/** What the canvas asks with: the passage and the instruction (the path and version are the canvas's). */
export interface CanvasAskDraft {
  passage: CanvasAskPassage;
  instruction: string;
  preset?: CanvasEditPreset;
}

/** Ask agent's state in the open document: sending the request, or the agent's run going. */
export interface CanvasAgentEdit {
  phase: "sending" | "running";
  range: TRange;
}

/** What the editor needs to offer Ask agent: whether it can now, and where a request goes. */
export interface CanvasAskControl {
  /** Why Ask agent can't be used now (a reply is streaming), or null. */
  disabledReason: string | null;
  onAsk: (draft: CanvasAskDraft) => void;
}

import type { CanvasComment, CanvasCommentAnchor } from "../schemas";

/** A comment thread (Phase 4.4): its first comment and its replies, oldest first. */
export interface CanvasCommentThread {
  comment: CanvasComment;
  replies: CanvasComment[];
}

/** A new thread or a reply, as the canvas sends it (`POST …/documents/comments`). */
export interface CanvasCommentDraft {
  path: string;
  /** The version the comment was made on. */
  version: number;
  body: string;
  /** A thread's passage; absent on a reply. */
  anchor?: CanvasCommentAnchor;
  /** The thread a reply belongs to; absent on a thread. */
  parentId?: string;
}

/** A change to a comment (`PATCH`): reopen or resolve a thread, or edit one's own body. */
export interface CanvasCommentPatch {
  status?: CanvasComment["status"];
  body?: string;
}

/**
 * Where a thread's passage sits in the shown text: its character offsets in
 * the editor's plain text (`lib/commentAnchors.ts`), or detached — the quote
 * is no longer there.
 */
export type CanvasAnchorPlacement = { start: number; end: number } | null;

/** What the editor needs to offer Comment on a selection. */
export interface CanvasCommentControl {
  /** Starts a thread on the passage with this body (shown at once, rolled back if refused). */
  onCreate: (anchor: CanvasCommentAnchor, body: string) => void;
}

/** The comments the shown text paints, and how a click on a passage reaches its thread. */
export interface CanvasCommentMarks {
  /** The open threads, with their anchors. */
  threads: CanvasCommentThread[];
  /** The thread the user is looking at (its passage is painted stronger). */
  activeId: string | null;
  /** Bumped to scroll the active thread's passage into view. */
  focusNonce: number;
  /** A click landed on a thread's passage. */
  onActivate: (id: string) => void;
  /** Where each thread's passage was found in the shown text (null: detached). */
  onPlaced: (placements: Record<string, CanvasAnchorPlacement>) => void;
}

/** The formats a canvas document exports to (Phase 4.5). */
export type CanvasExportFormat = "docx" | "pdf" | "md";

/** An exported document: its bytes and the name the server gave it. */
export interface CanvasExportFile {
  blob: Blob;
  filename: string;
}

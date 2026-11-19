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
  CanvasDocumentSuggestion,
  CanvasDocumentSummary,
  CanvasDocumentVersion,
  CanvasDocumentVersionMeta,
  CanvasEditPreset,
  CanvasEditRef,
  CanvasStaleBase,
} from "../schemas";

import type { ReactNode } from "react";
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

/**
 * The canvas's mode (plan 44 §3): edit the text; type suggestions — the
 * user's own edits tracked as changes that do not alter the document until
 * accepted (Phase 4.6); or read it. It only changes how the user's typing
 * behaves: the agent's versions always apply directly.
 */
export type CanvasMode = "editing" | "suggesting" | "viewing";

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

// Suggesting mode (Phase 4.6, features/canvas/lib/suggestions.ts).

/**
 * One suggestion in the open document, as the bar and its ✓ / ✕ name it:
 * text the user added, text they deleted, text they replaced (a deletion and
 * an insertion made together), or a formatting change.
 */
export interface CanvasSuggestion {
  id: string;
  kind: "insert" | "remove" | "replace" | "format";
  /** The start of its text, for the controls' accessible names. */
  summary: string;
}

/** How a top-level block shows a block-level suggestion (`CanvasBlockFrame`). */
export interface CanvasBlockSuggestion {
  id: string;
  kind: "insert" | "remove";
  /** Only the line break after the block is suggested (added, or joined away). */
  lineBreak: boolean;
}

/**
 * The document's pending suggestions as the canvas opens it: still being
 * read; ready (the proposed text to draw over the latest version, or null
 * for none, and what the server holds); or stale — the latest version moved
 * past the set's base and the user's changes could not be carried onto it,
 * so they show read-only over their own base until discarded.
 */
export type CanvasSuggestionStart =
  | { status: "loading" }
  | {
      status: "ready";
      proposed: string | null;
      /** The base version of the set the server holds; null: it holds none. */
      savedBase: number | null;
    }
  | ({ status: "stale" } & CanvasStaleSuggestions);

/** Suggestions shown read-only over their base, because the document changed since. */
export interface CanvasStaleSuggestions {
  base: string;
  proposed: string;
  baseVersion: number;
}

/** What the editor's live text stands for: the document (every suggestion rejected) and the proposal (all accepted). */
export interface CanvasEditorTexts {
  text: string;
  /** Null when nothing is suggested. */
  proposed: string | null;
}

/** Where the suggestion set stands (beside the version saves): saved, edited, being saved, or failed. */
export interface CanvasSuggestionSaveState {
  status: "saved" | "unsaved" | "saving" | "failed";
  errorMessage: string | null;
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
  /** Suggesting mode: the proposed text, drawn over `markdown` as suggestions. */
  proposed?: string;
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
  /** The passage; from a detached comment it has no range (nothing to tint). */
  passage: Omit<CanvasAskPassage, "range"> & { range: TRange | null };
  instruction: string;
  preset?: CanvasEditPreset;
  /** Plan 44 v2: the comment thread an `@agent` comment asked from (the thread's id). */
  commentId?: string;
}

/** Ask agent's state in the open document: sending the request, or the agent's run going. */
export interface CanvasAgentEdit {
  phase: "sending" | "running";
  /** The passage to tint; null when it is not in the shown text (a detached comment). */
  range: TRange | null;
  /** Asked from a comment thread (`@agent`): that thread's card says the agent works on it. */
  commentId?: string;
}

/**
 * The agent is writing the open document right now (plan 44 v2): an
 * `edit_file` / `write_file` call on its path that has not answered yet, read
 * from the live run's timeline. `passage` is the plain-text line to find in
 * the document (from `edit_file`'s `old_string`), null when there is none
 * (`write_file`, or nothing usable) — the marker then sits at the top.
 */
export interface CanvasAgentWriting {
  tool: "edit_file" | "write_file";
  passage: string | null;
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
  /** `@agent` in a comment asks the agent (plan 44 v2): the composer offers the mention. */
  mentions: boolean;
}

/**
 * What a comment card needs to know about the agent (plan 44 v2), through
 * `CanvasCommentAgentContext`: whether `@agent` is offered, the thread the
 * agent is working on now, and the ask a saved `@agent` comment makes.
 */
export interface CanvasCommentAgent {
  mentions: boolean;
  /** The thread an `@agent` request is running for; null: none. */
  workingThreadId: string | null;
  /** A saved comment with `@agent` in it, on `thread`: ask the agent. */
  ask: (thread: CanvasComment, body: string) => void;
}

/** The comments the shown text paints, and how a click on a passage reaches its thread. */
export interface CanvasCommentMarks {
  /** The open threads, with their anchors. */
  threads: CanvasCommentThread[];
  /** The thread whose card is open (its passage is painted stronger); null: none. */
  activeId: string | null;
  /** Bumped to scroll the active thread's passage into view. */
  focusNonce: number;
  /** A margin mark was clicked: open the card of its line. */
  onOpen: (id: string) => void;
  /** The open card was dismissed. */
  onClose: () => void;
  /** A card's content for a line's threads. */
  renderThreads: (ids: string[]) => ReactNode;
  /** The document row's button: threads with no line (detached, resolved); null: none. */
  others: CanvasOtherCommentsMark | null;
  /** Where each thread's passage was found in the shown text (null: detached). */
  onPlaced: (placements: Record<string, CanvasAnchorPlacement>) => void;
}

/** The document row's comments button (no line to sit on): how many, its card, open or not. */
export interface CanvasOtherCommentsMark {
  count: number;
  render: () => ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** A comment mark in the margin: the line's top in the column (px), its height, its threads in reading order. */
export interface CanvasCommentMarker {
  top: number;
  height: number;
  ids: string[];
}

/** The formats a canvas document exports to (Phase 4.5). */
export type CanvasExportFormat = "docx" | "pdf" | "md";

/** An exported document: its bytes and the name the server gave it. */
export interface CanvasExportFile {
  blob: Blob;
  filename: string;
}

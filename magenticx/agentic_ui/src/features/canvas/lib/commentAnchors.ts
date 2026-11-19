/**
 * Comment anchors (plan 44, Phase 4.4): where a thread's passage sits in the
 * document. A thread stores its passage as text — the quote, with up to 200
 * characters before and after it — never as a position: the document is
 * markdown, rewritten by the agent and the user between versions, and a
 * position would point at the wrong words after the first edit.
 *
 * Both directions read the editor's text the same way (`buildTextIndex`):
 * every text of the document in order, with a newline between two blocks.
 * Capturing slices that text at the selection; locating finds the quote in
 * it again, and when the quote occurs more than once, picks the occurrence
 * whose surroundings best match the stored prefix and suffix. A quote that is
 * gone is "detached": the thread stays, shown with its quote, unpainted.
 */
import { RangeApi, TextApi, type Path, type Point, type SlateEditor, type TRange } from "platejs";

import { CANVAS_COMMENT_LIMITS } from "@/shared/lib/schemas";
import type { CanvasAnchorPlacement, CanvasCommentAnchor } from "@/shared/lib/types";

/** How much context a new thread keeps on each side of its quote. */
const CONTEXT_CHARS = 120;

interface TextSegment {
  path: Path;
  /** Offsets of this text node in the index's text. */
  start: number;
  end: number;
}

/** The document's text as one string, and where each text node sits in it. */
export interface CanvasTextIndex {
  text: string;
  segments: TextSegment[];
}

const samePath = (a: Path, b: Path) => a.length === b.length && a.every((step, i) => step === b[i]);

/** The editor's text in reading order, a newline between blocks. */
export function buildTextIndex(editor: SlateEditor): CanvasTextIndex {
  let text = "";
  const segments: TextSegment[] = [];
  let previousBlock: Path | null = null;
  for (const [node, path] of editor.api.nodes({ at: [], match: (n) => TextApi.isText(n) })) {
    const block = editor.api.block({ at: path })?.[1] ?? path.slice(0, 1);
    if (previousBlock && !samePath(previousBlock, block)) text += "\n";
    previousBlock = block;
    const value = (node as { text: string }).text;
    segments.push({ path, start: text.length, end: text.length + value.length });
    text += value;
  }
  return { text, segments };
}

/** A point's offset in the index's text; null when its text node is not indexed. */
function offsetOf(index: CanvasTextIndex, point: Point): number | null {
  const segment = index.segments.find((item) => samePath(item.path, point.path));
  return segment ? segment.start + Math.min(point.offset, segment.end - segment.start) : null;
}

/**
 * The editor point at an offset of the index's text. An offset on a block
 * break belongs to the end of the text before it (`atStart`: the start of
 * the text after it), so a range never starts at the end of a block.
 */
function pointAt(index: CanvasTextIndex, offset: number, atStart: boolean): Point | null {
  const { segments } = index;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (offset < segment.start) continue;
    const inside = atStart ? offset < segment.end : offset <= segment.end;
    if (inside || (offset === segment.end && i === segments.length - 1)) {
      return { path: segment.path, offset: offset - segment.start };
    }
  }
  // Between two blocks (on the newline): the start of the next text.
  const next = segments.find((segment) => segment.start >= offset);
  return next ? { path: next.path, offset: 0 } : null;
}

/** What capturing a selection came to: the anchor, or why it can't be one. */
export type CanvasAnchorCapture =
  { kind: "anchor"; anchor: CanvasCommentAnchor } | { kind: "problem"; message: string };

/**
 * The anchor of a selection: its text, and the text around it. Null when
 * there is nothing to comment on (a caret, or only spaces).
 */
export function captureAnchor(editor: SlateEditor, range: TRange): CanvasAnchorCapture | null {
  if (!RangeApi.isExpanded(range)) return null;
  const index = buildTextIndex(editor);
  const [startPoint, endPoint] = RangeApi.edges(range);
  const from = offsetOf(index, startPoint);
  const to = offsetOf(index, endPoint);
  if (from === null || to === null || to <= from) return null;
  // The quote is the selection without the spaces at its edges.
  const raw = index.text.slice(from, to);
  const lead = raw.length - raw.trimStart().length;
  const quote = raw.trim();
  if (!quote) return null;
  if (quote.length > CANVAS_COMMENT_LIMITS.quote) {
    return {
      kind: "problem",
      message: "That is too much text for one comment. Select less, up to 2,000 characters.",
    };
  }
  const start = from + lead;
  const end = start + quote.length;
  return {
    kind: "anchor",
    anchor: {
      quote,
      prefix: index.text.slice(Math.max(0, start - CONTEXT_CHARS), start),
      suffix: index.text.slice(end, end + CONTEXT_CHARS),
    },
  };
}

/** How many characters two strings share at their ends (`fromEnd`) or starts. */
function sharedLength(a: string, b: string, fromEnd: boolean): number {
  const limit = Math.min(a.length, b.length);
  let n = 0;
  while (n < limit) {
    const x = fromEnd ? a[a.length - 1 - n] : a[n];
    const y = fromEnd ? b[b.length - 1 - n] : b[n];
    if (x !== y) break;
    n += 1;
  }
  return n;
}

/**
 * Where an anchor's quote is in `text`: the occurrence whose surroundings
 * share the most with the stored prefix and suffix (the first one on a tie).
 * When the quote itself is gone — the passage was rewritten, typically by the
 * agent answering the comment — the thread follows the rewrite: the text now
 * between the same surroundings (`locateByContext`). Null (detached) only
 * when neither finds it.
 */
export function locateAnchor(text: string, anchor: CanvasCommentAnchor): CanvasAnchorPlacement {
  const { quote } = anchor;
  if (!quote) return null;
  let best: { start: number; score: number } | null = null;
  for (let at = text.indexOf(quote); at !== -1; at = text.indexOf(quote, at + 1)) {
    const before = text.slice(Math.max(0, at - anchor.prefix.length), at);
    const after = text.slice(at + quote.length, at + quote.length + anchor.suffix.length);
    const score =
      sharedLength(before, anchor.prefix, true) + sharedLength(after, anchor.suffix, false);
    if (!best || score > best.score) best = { start: at, score };
  }
  return best ? { start: best.start, end: best.start + quote.length } : locateByContext(text, anchor);
}

/** The ends of the stored context tried, longest first: long enough to be unique, short enough to survive an edit nearby. */
const CONTEXT_PROBES = [48, 24, 12];
/** A side of the context shorter than this is too common to anchor on (unless it is the document's edge). */
const MIN_CONTEXT_CHARS = 6;

/**
 * The rewritten passage: the text between the end of the stored prefix and
 * the start of the stored suffix, both found again in `text`. A side that was
 * empty when the comment was made is the document's edge. The span must stay
 * plausible for a rewrite of the quote (at most three times as long, plus a
 * paragraph's worth), and the whitespace at its edges (block breaks) is left
 * out, so the passage starts and ends on words.
 */
function locateByContext(text: string, anchor: CanvasCommentAnchor): CanvasAnchorPlacement {
  // With no context at all there is nothing to follow the rewrite by.
  if (!anchor.prefix.trim() && !anchor.suffix.trim()) return null;
  const maxSpan = anchor.quote.length * 3 + 600;
  const startsAt = (): number[] => {
    if (!anchor.prefix) return [0];
    for (const size of CONTEXT_PROBES) {
      const tail = anchor.prefix.slice(-size);
      if (tail.trim().length < MIN_CONTEXT_CHARS) continue;
      const found: number[] = [];
      for (let at = text.indexOf(tail); at !== -1; at = text.indexOf(tail, at + 1)) {
        found.push(at + tail.length);
      }
      if (found.length > 0) return found;
    }
    return [];
  };
  const endBefore = (from: number): number | null => {
    if (!anchor.suffix) return text.length - from <= maxSpan ? text.length : null;
    for (const size of CONTEXT_PROBES) {
      const head = anchor.suffix.slice(0, size);
      if (head.trim().length < MIN_CONTEXT_CHARS) continue;
      const at = text.indexOf(head, from);
      if (at !== -1 && at - from <= maxSpan) return at;
    }
    return null;
  };

  let best: { start: number; end: number } | null = null;
  for (const from of startsAt()) {
    const to = endBefore(from);
    if (to === null) continue;
    // Words only: the block breaks and spaces at the edges stay outside.
    const slice = text.slice(from, to);
    const start = from + (slice.length - slice.trimStart().length);
    const end = to - (slice.length - slice.trimEnd().length);
    if (end <= start) continue;
    // The tightest span wins: the surroundings closest together.
    if (!best || end - start < best.end - best.start) best = { start, end };
  }
  return best;
}

/** The editor range of a placement found in `index`; null when it no longer maps. */
export function placementRange(
  index: CanvasTextIndex,
  placement: NonNullable<CanvasAnchorPlacement>,
): TRange | null {
  const anchor = pointAt(index, placement.start, true);
  const focus = pointAt(index, placement.end, false);
  return anchor && focus ? { anchor, focus } : null;
}

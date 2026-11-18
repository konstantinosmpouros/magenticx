/**
 * What changed between two versions of a document, for the canvas's compare
 * view (plan 44, Phase 4.2): a line diff of the markdown, refined inside each
 * changed stretch to words, so a one-word edit in a long paragraph marks one
 * word, not the paragraph. Built on `diff` (jsdiff, BSD-3-Clause).
 *
 * Long runs of unchanged lines fold into a "N unchanged lines" row the view
 * can expand, keeping `DIFF_CONTEXT` lines either side of each change.
 */
import { diffLines, diffWordsWithSpace } from "diff";

import type {
  CanvasDiffItem as DiffItem,
  CanvasDiffPiece as DiffPiece,
  CanvasDiffRow as DiffRow,
  CanvasDocumentDiff as DocumentDiff,
} from "@/shared/lib/types";

/** Unchanged lines kept on each side of a change when the rest folds. */
export const DIFF_CONTEXT = 2;

/** Above this many characters per side, word refinement is skipped (lines only). */
const WORD_DIFF_MAX_CHARS = 20_000;

const splitKeep = (text: string): string[] => {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
};

/** Split word-level pieces back into rows at their newlines. */
function piecesToRows(pieces: DiffPiece[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let current: DiffPiece[] = [];
  const close = () => {
    const changed = current.some((piece) => piece.kind !== "same");
    rows.push({ kind: changed ? "changed" : "same", pieces: current.length ? current : [] });
    current = [];
  };
  for (const piece of pieces) {
    const parts = piece.text.split("\n");
    parts.forEach((part, index) => {
      if (index > 0) close();
      if (part) current.push({ kind: piece.kind, text: part });
    });
  }
  if (current.length) close();
  return rows;
}

/** Diff `before` → `after` into rows with inline insert/delete marks. */
export function diffDocuments(before: string, after: string): DocumentDiff {
  const rows: DiffRow[] = [];
  let added = 0;
  let removed = 0;
  const changes = diffLines(before.replace(/\r\n?/g, "\n"), after.replace(/\r\n?/g, "\n"));

  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index];
    if (!change.added && !change.removed) {
      for (const line of splitKeep(change.value))
        rows.push({ kind: "same", pieces: [{ kind: "same", text: line }] });
      continue;
    }
    // A removal followed by an addition is one edit: refine it to words.
    const next = changes[index + 1];
    if (change.removed && next?.added) {
      removed += change.count ?? splitKeep(change.value).length;
      added += next.count ?? splitKeep(next.value).length;
      index += 1;
      if (change.value.length + next.value.length > WORD_DIFF_MAX_CHARS) {
        for (const line of splitKeep(change.value))
          rows.push({ kind: "changed", pieces: [{ kind: "removed", text: line }] });
        for (const line of splitKeep(next.value))
          rows.push({ kind: "changed", pieces: [{ kind: "added", text: line }] });
        continue;
      }
      const words = diffWordsWithSpace(
        change.value.replace(/\n$/, ""),
        next.value.replace(/\n$/, ""),
      );
      rows.push(
        ...piecesToRows(
          words.map((word) => ({
            kind: word.added ? "added" : word.removed ? "removed" : "same",
            text: word.value,
          })),
        ),
      );
      continue;
    }
    const kind = change.added ? "added" : "removed";
    const lines = splitKeep(change.value);
    if (change.added) added += lines.length;
    else removed += lines.length;
    for (const line of lines) rows.push({ kind: "changed", pieces: [{ kind, text: line }] });
  }

  return { items: foldUnchanged(rows), added, removed };
}

/** Fold runs of unchanged rows longer than the context either side of a change. */
function foldUnchanged(rows: DiffRow[], context = DIFF_CONTEXT): DiffItem[] {
  const items: DiffItem[] = [];
  let k = 0;
  while (k < rows.length) {
    if (rows[k].kind !== "same") {
      items.push({ type: "row", row: rows[k] });
      k += 1;
      continue;
    }
    let end = k;
    while (end < rows.length && rows[end].kind === "same") end += 1;
    const keepHead = k === 0 ? 0 : context;
    const keepTail = end === rows.length ? 0 : context;
    const hidden = end - k - keepHead - keepTail;
    if (hidden >= 2) {
      for (let x = k; x < k + keepHead; x += 1) items.push({ type: "row", row: rows[x] });
      items.push({ type: "fold", rows: rows.slice(k + keepHead, end - keepTail) });
      for (let x = end - keepTail; x < end; x += 1) items.push({ type: "row", row: rows[x] });
    } else {
      for (let x = k; x < end; x += 1) items.push({ type: "row", row: rows[x] });
    }
    k = end;
  }
  return items;
}

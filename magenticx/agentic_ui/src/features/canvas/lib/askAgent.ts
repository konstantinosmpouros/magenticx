/**
 * Ask agent on a selection (plan 44 §3, Phase 4.3): what the canvas sends
 * when the user asks the agent to change a passage — the passage as plain
 * text, the headings it sits under, and the instruction (typed, or a
 * preset's). The agent changes only that passage; the canvas builds the
 * request, the chat sends it as a normal user message (`canvasEdit`).
 *
 * Kept out of the components so it is pinned on the editor the user types
 * into (`createCanvasEditor`).
 */
import { NodeApi, RangeApi, TextApi, type Path, type SlateEditor, type TRange } from "platejs";

import { CANVAS_EDIT_LIMITS } from "@/shared/lib/schemas";
import type {
  CanvasAskDraft,
  CanvasAskPassage,
  CanvasEditPreset,
  CanvasEditRef,
} from "@/shared/lib/types";

import { isSelectingBlocks, targetBlocks } from "./blockCommands";
import { headingLevel } from "./outline";

/** The one-tap presets, in the menu's order, with the instruction each one sends. */
export const CANVAS_ASK_PRESETS: readonly {
  preset: CanvasEditPreset;
  label: string;
  instruction: string;
}[] = [
  { preset: "shorter", label: "Shorter", instruction: "Make it shorter" },
  { preset: "longer", label: "Longer", instruction: "Make it longer" },
  { preset: "formal", label: "Formal", instruction: "Make it more formal" },
  { preset: "simpler", label: "Simpler", instruction: "Make it simpler" },
  { preset: "polish", label: "Polish", instruction: "Polish the wording" },
];

/** Why a selection cannot be sent, said to the user; null when it can. */
export function passageProblem(passage: CanvasAskPassage | null): string | null {
  if (!passage) return "Select some text first";
  if (passage.text.length > CANVAS_EDIT_LIMITS.selection)
    return "That is too much text for one request. Select less, up to about 8,000 characters.";
  return null;
}

/** The lowest block above a text: a paragraph, a heading, a table cell's paragraph, a code line. */
function blockPathOf(editor: SlateEditor, path: Path): Path {
  return editor.api.block({ at: path })?.[1] ?? path.slice(0, 1);
}

/**
 * The text of a range as the reader sees it: blocks on lines of their own
 * (a blank line between top-level blocks, one newline between a table's
 * cells or a code block's lines), marks and links as their plain text.
 */
export function rangeText(editor: SlateEditor, range: TRange): string {
  const [start, end] = RangeApi.edges(range);
  let text = "";
  let previous: Path | null = null;
  for (const [node, path] of editor.api.nodes({ at: range, match: (n) => TextApi.isText(n) })) {
    const value = (node as { text: string }).text;
    const from = path.join() === start.path.join() ? start.offset : 0;
    const to = path.join() === end.path.join() ? end.offset : value.length;
    const block = blockPathOf(editor, path);
    if (previous && previous.join() !== block.join()) {
      text += previous[0] === block[0] ? "\n" : "\n\n";
    }
    previous = block;
    text += value.slice(from, to);
  }
  return text.trim();
}

/**
 * The headings above top-level block `index`, outermost first: each heading
 * closes the ones of its level and deeper, like the outline. At most six,
 * each cut to 200 characters (the bridge's bounds).
 */
export function headingPathAt(editor: SlateEditor, index: number): string[] {
  const stack: { level: number; text: string }[] = [];
  editor.children.slice(0, index).forEach((node) => {
    const level = headingLevel(node.type as string);
    if (level === null) return;
    const text = NodeApi.string(node).trim();
    if (!text) return;
    while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, text });
  });
  return stack
    .slice(0, CANVAS_EDIT_LIMITS.headings)
    .map((heading) => heading.text.slice(0, CANVAS_EDIT_LIMITS.heading));
}

/**
 * The passage to ask about: the selected blocks (block selection), else the
 * text selection; null when nothing with text is selected.
 */
export function selectedPassage(editor: SlateEditor): CanvasAskPassage | null {
  let range: TRange | null = null;
  if (isSelectingBlocks(editor)) {
    const blocks = targetBlocks(editor);
    if (blocks.length === 0) return null;
    const first = blocks[0][1];
    const last = blocks[blocks.length - 1][1];
    range = { anchor: editor.api.start(first)!, focus: editor.api.end(last)! };
  } else if (editor.selection && RangeApi.isExpanded(editor.selection)) {
    range = editor.selection;
  }
  if (!range || !range.anchor || !range.focus) return null;
  const text = rangeText(editor, range);
  if (!text) return null;
  const [start] = RangeApi.edges(range);
  return { text, headingPath: headingPathAt(editor, start.path[0]), range: structuredClone(range) };
}

/** The request a user message carries (`MessageIn.canvasEdit`). */
export function buildCanvasEdit({
  path,
  version,
  draft,
}: {
  /** The document's path exactly as the documents API returned it (the bridge wants the canonical one). */
  path: string;
  /** The saved latest version the editor's text is (the selection was made on it). */
  version: number;
  draft: CanvasAskDraft;
}): CanvasEditRef {
  // The bridge refuses a NUL anywhere; a paste can carry one.
  const clean = (text: string) => text.split("\u0000").join("");
  return {
    path,
    version,
    selection: clean(draft.passage.text),
    headingPath: draft.passage.headingPath.map(clean).filter(Boolean),
    instruction: clean(draft.instruction).trim().slice(0, CANVAS_EDIT_LIMITS.instruction),
    ...(draft.preset ? { preset: draft.preset } : {}),
  };
}

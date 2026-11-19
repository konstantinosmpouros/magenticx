/**
 * The editing commands behind the canvas toolbar (plan 44, Phase 4.2),
 * adapted from Plate's registry (`link-toolbar-button`): quote a block, add
 * or remove a link. Block styles, block actions and tables are in
 * `blockCommands.ts`. Kept out of the component so the
 * toolbar only renders, and so the rules (which URLs a link may take) are
 * testable on a headless editor.
 */
import { KEYS, PathApi, TextApi, type Point, type SlateEditor, type TElement } from "platejs";
import { unwrapLink, upsertLink } from "@platejs/link";

import { turnInto } from "./blockCommands";

/** Whether the selection is inside a quote. */
export function inQuote(editor: SlateEditor): boolean {
  return (
    Boolean(editor.api.above({ match: { type: KEYS.blockquote } })) ||
    (editor.api.block()?.[0] as TElement | undefined)?.type === KEYS.blockquote
  );
}

/** A point as (top-level block, characters from that block's start): it survives a re-wrap. */
function blockOffset(editor: SlateEditor, point: Point): { index: number; offset: number } {
  const index = point.path[0];
  let offset = 0;
  for (const [node, path] of editor.api.nodes({ at: [index], match: (n) => TextApi.isText(n) })) {
    if (PathApi.equals(path, point.path)) return { index, offset: offset + point.offset };
    offset += (node as { text: string }).text.length;
  }
  return { index, offset };
}

/** The point `offset` characters into top-level block `index`, if the block is there. */
function pointAt(
  editor: SlateEditor,
  { index, offset }: { index: number; offset: number },
): Point | null {
  if (!editor.children[index]) return null;
  let left = offset;
  let last: Point | null = null;
  for (const [node, path] of editor.api.nodes({ at: [index], match: (n) => TextApi.isText(n) })) {
    const length = (node as { text: string }).text.length;
    if (left <= length) return { path, offset: left };
    left -= length;
    last = { path, offset: length };
  }
  return last;
}

/**
 * Quote the selected blocks, or unquote them. The block is re-rendered as
 * another element, and the browser's caret, lost with the old one, would
 * otherwise drag the editor's selection elsewhere as focus returns (to the
 * end of a later heading): the selection is put back on the same text —
 * by block and character, since the wrap changes the paths — before the
 * editor is focused.
 */
export function toggleQuote(editor: SlateEditor): void {
  const selection = editor.selection;
  const before = selection
    ? { anchor: blockOffset(editor, selection.anchor), focus: blockOffset(editor, selection.focus) }
    : null;
  // Plate's toggle quotes but does not unquote a quote it made: back to text by turn-into.
  if (inQuote(editor)) turnInto(editor, KEYS.p);
  else editor.tf.toggleBlock(KEYS.blockquote);
  if (before) {
    const anchor = pointAt(editor, before.anchor);
    const focus = pointAt(editor, before.focus);
    if (anchor && focus) editor.tf.select({ anchor, focus });
  }
  editor.tf.focus();
}

/**
 * Only web and mail links: a document is read by the agent and opened in a
 * browser, so `javascript:`, `data:` and the like are refused here and never
 * reach the text. A bare host ("example.com") reads as https.
 */
export function normalizeLinkUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol === "mailto:") return url.href;
  if ((url.protocol === "http:" || url.protocol === "https:") && url.hostname.includes(".")) {
    return url.href;
  }
  return null;
}

/** The link around the selection, if any. */
export function selectedLinkUrl(editor: SlateEditor): string | null {
  const entry = editor.api.above({ match: { type: KEYS.link } });
  const url = (entry?.[0] as { url?: unknown } | undefined)?.url;
  return typeof url === "string" ? url : null;
}

/** Link the selection (or insert the URL as its own text when nothing is selected). */
export function applyLink(editor: SlateEditor, url: string): void {
  editor.tf.focus();
  upsertLink(editor, { url, skipValidation: true });
}

export function removeLink(editor: SlateEditor): void {
  editor.tf.focus();
  unwrapLink(editor);
}

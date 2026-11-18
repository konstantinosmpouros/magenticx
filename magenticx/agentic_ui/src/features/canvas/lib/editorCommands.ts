/**
 * The editing commands behind the canvas toolbar (plan 44, Phase 4.2),
 * adapted from Plate's registry (`link-toolbar-button`): quote a block, add
 * or remove a link. Block styles, block actions and tables are in
 * `blockCommands.ts`. Kept out of the component so the
 * toolbar only renders, and so the rules (which URLs a link may take) are
 * testable on a headless editor.
 */
import { KEYS, type SlateEditor, type TElement } from "platejs";
import { unwrapLink, upsertLink } from "@platejs/link";

/** Whether the selection is inside a quote. */
export function inQuote(editor: SlateEditor): boolean {
  return (
    Boolean(editor.api.above({ match: { type: KEYS.blockquote } })) ||
    (editor.api.block()?.[0] as TElement | undefined)?.type === KEYS.blockquote
  );
}

/** Quote the selected blocks, or unquote them. */
export function toggleQuote(editor: SlateEditor): void {
  editor.tf.toggleBlock(KEYS.blockquote);
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

/**
 * Pasting from Word or the web into the canvas (plan 44, Phase 4.2).
 *
 * Plate turns pasted HTML into the canvas's own nodes, and anything it has
 * no node for becomes text — so no raw HTML ever enters a document. Left
 * alone, though, a paste also carries what is noise in markdown: a script's
 * or a stylesheet's source as visible text, Word's list bullets typed into
 * the paragraph ("· Item one") instead of a list, and images that point at
 * the copier's disk (`file:`), a blob or an inline `data:` payload. This
 * plugin cleans the HTML before Plate reads it:
 *
 * - drops script, style, iframe, object, embed, template, noscript, svg,
 *   meta and link elements, and comments (Word's conditional ones included);
 * - unwraps Office's namespaced tags (`<o:p>`), keeping their text;
 * - turns Word's list paragraphs (`mso-list`) into real `<ul>`/`<ol>` items,
 *   without their typed bullet;
 * - keeps an image only when its address is `http(s):`.
 *
 * Written for the canvas: Plate's own Word cleaner is `@platejs/docx`, a
 * much larger package aimed at round-tripping Word layout, which a markdown
 * document cannot keep anyway.
 */
import { createPlatePlugin } from "platejs/react";

const DROP = "script, style, iframe, object, embed, template, noscript, svg, meta, link, title";
/** A typed list marker at the start of a Word list paragraph. */
const MARKER = /^[\s\u00a0]*(?:[·•▪◦o§\-–]|\d+[.)]|[a-z][.)])[\s\u00a0]+/i;
const isWordListItem = (el: Element) =>
  /MsoListParagraph/i.test(el.className) || /mso-list:\s*l\d/i.test(el.getAttribute("style") ?? "");

/** Remove a leading match of `pattern` from an element's text, across its text nodes. */
function stripLeading(el: Element, pattern: RegExp): void {
  const text = el.textContent ?? "";
  const match = pattern.exec(text);
  if (!match) return;
  let remaining = match[0].length;
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  while (remaining > 0 && walker.nextNode()) {
    const node = walker.currentNode as Text;
    const cut = Math.min(remaining, node.data.length);
    node.data = node.data.slice(cut);
    remaining -= cut;
  }
}

/** The cleaned HTML of a paste (see the module comment). */
export function cleanPastedHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const body = doc.body;

  body.querySelectorAll(DROP).forEach((el) => el.remove());
  const comments = doc.createTreeWalker(body, NodeFilter.SHOW_COMMENT);
  const dead: Node[] = [];
  while (comments.nextNode()) dead.push(comments.currentNode);
  dead.forEach((node) => node.parentNode?.removeChild(node));

  // Office's namespaced tags (`<o:p>`, `<w:sdt>`): keep their text, drop the tag.
  Array.from(body.querySelectorAll("*"))
    .filter((el) => el.tagName.includes(":"))
    .forEach((el) => el.replaceWith(...Array.from(el.childNodes)));

  body.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src") ?? "";
    if (!/^https?:\/\//i.test(src)) img.remove();
  });

  // Word's list paragraphs → one <ul>/<ol> per run of them, without the
  // marker Word typed into each one (its own span, or plain text).
  let list: HTMLElement | null = null;
  for (const el of Array.from(body.querySelectorAll("p"))) {
    if (!isWordListItem(el)) {
      list = null;
      continue;
    }
    const ordered = /^[\s\u00a0]*(?:\d+|[a-z])[.)]/i.test(el.textContent ?? "");
    el.querySelectorAll('[style*="mso-list:" i]').forEach((marker) => {
      if (/mso-list:\s*Ignore/i.test(marker.getAttribute("style") ?? "")) marker.remove();
    });
    stripLeading(el, MARKER);
    if (!list || el.previousElementSibling !== list) {
      list = doc.createElement(ordered ? "ol" : "ul");
      el.before(list);
    }
    const item = doc.createElement("li");
    item.innerHTML = el.innerHTML;
    list.append(item);
    el.remove();
  }

  return body.innerHTML;
}

/** Wraps the paste's data so Plate reads the cleaned HTML. */
function withCleanHtml(data: DataTransfer): DataTransfer {
  const html = data.getData("text/html");
  if (!html) return data;
  const cleaned = cleanPastedHtml(html);
  return new Proxy(data, {
    get(target, key) {
      if (key === "getData") {
        return (format: string) => (format === "text/html" ? cleaned : target.getData(format));
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export const canvasPastePlugin = createPlatePlugin({ key: "canvasPaste" }).overrideEditor(
  ({ tf: { insertData } }) => ({
    transforms: {
      insertData(data) {
        insertData(withCleanHtml(data));
      },
    },
  }),
);

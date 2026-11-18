/**
 * A short shine over what the agent changed (plan 44, Phase 4.3), so the
 * user sees where the document changed:
 *
 * - when the canvas reloads with a version the agent wrote, the blocks whose
 *   text is new (`shineChanges`);
 * - when the user opens a document from an Ask agent card in the chat, the
 *   blocks that request's run wrote (`changedTexts` between the version the
 *   request was made on and the agent's next one, found in the latest text by
 *   `shineTexts`).
 *
 * Each block shines once (`[data-canvas-shine]`, ~2.2 s: a bar at the left,
 * the text coming in from a slight blur, a band of light sweeping across;
 * blocks cascade 90 ms apart; the bar and a fading tint under reduced motion) and the first one is scrolled into view if it is
 * off screen. A data attribute, not a class: Plate re-renders a block's
 * `className` (selection, hover) and would wipe a class straight away, while
 * an attribute React does not own survives those renders.
 *
 * "Changed" is by block text; formatting-only changes do not shine.
 */
import { NodeApi, type SlateEditor, type Value } from "platejs";

import { markdownToValue } from "./markdown";

const SHINE_ATTR = "data-canvas-shine";
/** Each further block starts this much later (a cascade), up to STAGGER_MAX blocks. */
const STAGGER_MS = 90;
const STAGGER_MAX = 6;
/** The CSS animation (2.2 s) plus the longest stagger, so it is never cut short. */
const SHINE_MS = 2200 + STAGGER_MS * STAGGER_MAX + 100;
const DELAY_VAR = "--canvas-shine-delay";
/** The floating pill toolbar's band at the bottom of the canvas. */
const BOTTOM_CLEARANCE_PX = 120;

const textOf = (node: unknown): string =>
  NodeApi.string(node as Parameters<typeof NodeApi.string>[0])
    .replace(/\s+/g, " ")
    .trim();

const blockTexts = (markdown: string): string[] => (markdownToValue(markdown) as Value).map(textOf);

/** The texts of `next`'s blocks that were not in `previous` (both markdown). */
export function changedTexts(previous: string, next: string): string[] {
  const before = new Set(blockTexts(previous));
  return blockTexts(next).filter((text) => text !== "" && !before.has(text));
}

/** The editor's top-level blocks whose text was not in `previous` (markdown). */
export function changedBlocks(editor: SlateEditor, previous: string): Value {
  const before = new Set(blockTexts(previous));
  return (editor.children as Value).filter((node) => {
    const text = textOf(node);
    return text !== "" && !before.has(text);
  });
}

function shine(editor: SlateEditor, nodes: Value): () => void {
  const elements: HTMLElement[] = [];
  for (const node of nodes) {
    try {
      const dom = editor.api.toDOMNode(node);
      if (dom) elements.push(dom);
    } catch {
      // Not rendered (a folded section): nothing to light up.
    }
  }
  if (elements.length === 0) return () => undefined;

  elements.forEach((el, index) => {
    el.style.setProperty(DELAY_VAR, `${Math.min(index, STAGGER_MAX) * STAGGER_MS}ms`);
    el.setAttribute(SHINE_ATTR, "");
  });
  const first = elements[0];
  const box = first.getBoundingClientRect();
  // Off screen, or under the floating pill at the bottom: bring it to the middle.
  if (box.top < 0 || box.bottom > window.innerHeight - BOTTOM_CLEARANCE_PX) {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    first.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
  }
  const clear = () => {
    for (const el of elements) {
      el.removeAttribute(SHINE_ATTR);
      el.style.removeProperty(DELAY_VAR);
    }
  };
  const timer = window.setTimeout(clear, SHINE_MS);
  return () => {
    window.clearTimeout(timer);
    clear();
  };
}

/** Shine the blocks whose text is new since `previous`; returns a cleanup. */
export function shineChanges(editor: SlateEditor, previous: string): () => void {
  return shine(editor, changedBlocks(editor, previous));
}

/** Shine the editor's blocks whose text is one of `texts`; returns a cleanup. */
export function shineTexts(editor: SlateEditor, texts: string[]): () => void {
  const wanted = new Set(texts);
  return shine(
    editor,
    (editor.children as Value).filter((node) => wanted.has(textOf(node))),
  );
}

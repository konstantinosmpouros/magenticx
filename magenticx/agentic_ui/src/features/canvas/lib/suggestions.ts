/**
 * Suggesting mode (plan 44, Phase 4.6): the user's own edits as suggestions —
 * tracked changes that leave the document as it is until they are accepted.
 *
 * Live tracking is Plate's `@platejs/suggestion` (MIT, `SuggestionPlugin` in
 * `editorKit.ts`): with the mode on Suggesting, what the user types is
 * inserted as marked text and what they delete stays, marked for removal;
 * its `acceptSuggestion` / `rejectSuggestion` transforms decide one. This
 * module holds what is ours around it, in Plate's own node format (leaves
 * `suggestion: true` + `suggestion_<id>: {id, type, userId, createdAt}`,
 * blocks `suggestion: {id, type, isLineBreak?}`):
 *
 * - **the two texts a value stands for** — the document with every
 *   suggestion rejected (it equals the base version's markdown) and with
 *   every one accepted (the proposed text the set is saved as), worked out
 *   from the value without touching the editor;
 * - **loading a saved set**: base markdown + proposed markdown → a value with
 *   the suggestions marked. Plate's `diffToSuggestions` diffs characters
 *   (`analy[sis][tics]`); here both texts are parsed into blocks, the block
 *   lists diffed (jsdiff's `diffArrays`), a changed block paired with the one
 *   most like it and merged **word by word**, one suggestion per stretch of
 *   changed words; unpaired blocks are added or removed whole. A merge that
 *   would not give back both texts exactly falls back to whole blocks;
 * - **the list** the bar and the ✓ / ✕ controls show;
 * - **rebasing** the proposed text onto a newer latest version (the agent
 *   edited meanwhile): jsdiff's patch of base → proposed applied to the
 *   latest with a little fuzz; null when it does not fit.
 */
import { applyPatch, diffArrays, structuredPatch } from "diff";
import {
  ElementApi,
  NodeApi,
  TextApi,
  type Descendant,
  type SlateEditor,
  type TElement,
  type TText,
  type Value,
} from "platejs";
import {
  acceptSuggestion,
  BaseSuggestionPlugin,
  getSuggestionKey,
  rejectSuggestion,
  type TResolvedSuggestion,
} from "@platejs/suggestion";

import type {
  CanvasBlockSuggestion,
  CanvasEditorTexts,
  CanvasSuggestion,
} from "@/shared/lib/types";

import { markdownToValue, normalizeMarkdown, valueToMarkdown } from "./markdown";

/**
 * Who a suggestion is from. The canvas has one author of suggestions — the
 * viewer — so one id serves (Plate's plugin needs one: it extends and deletes
 * outright only the current user's own insertions).
 */
export const SUGGESTION_USER = "user";

/** Plate's key for suggestion data on a leaf and on a block. */
const SUGGESTION = "suggestion";
const KEY_PREFIX = `${SUGGESTION}_`;
const TRANSIENT = `${SUGGESTION}Transient`;

/** Two blocks pair as one edited block when at least this share of their words is common. */
const PAIR_SIMILARITY = 0.3;

/** How much of a suggestion's text its controls name. */
const SUMMARY_CHARS = 60;

type InlineData = { id: string; type: "insert" | "remove" | "update"; [key: string]: unknown };
type BlockData = { id: string; type: "insert" | "remove"; isLineBreak?: boolean };

const isSuggestionKey = (key: string) => key.startsWith(KEY_PREFIX);

/** A leaf's (or inline element's) suggestion data, in the order Plate wrote it. */
function inlineData(node: object): InlineData[] {
  const record = node as Record<string, unknown>;
  return Object.keys(record)
    .filter(isSuggestionKey)
    .map((key) => record[key])
    .filter((data): data is InlineData => Boolean(data) && typeof data === "object");
}

/** A top-level (or nested) block's suggestion, if it has one. */
function blockData(node: TElement): BlockData | null {
  const data = (node as Record<string, unknown>)[SUGGESTION];
  return data && typeof data === "object" ? (data as BlockData) : null;
}

const isInline = (node: Descendant): boolean => ElementApi.isElement(node) && node.type === "a";

/** The node without any suggestion property. */
function strip<T extends object>(node: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === SUGGESTION || key === TRANSIENT || key === "suggestionData" || isSuggestionKey(key))
      continue;
    out[key] = value;
  }
  return out as T;
}

// -- The two texts a value stands for -------------------------------------------

type Side = "accept" | "reject";

/** A leaf or inline element with the decision applied; null when it goes. */
function resolveInline(node: Descendant, side: Side): Descendant | null {
  const data = inlineData(node);
  const types = new Set(data.map((item) => item.type));
  if (side === "accept" && types.has("remove")) return null;
  if (side === "reject" && types.has("insert")) return null;
  let out: Record<string, unknown> = strip(node);
  if (side === "reject") {
    // A formatting suggestion put back: what it set goes, what it unset returns.
    for (const item of data) {
      if (item.type !== "update") continue;
      const added = (item.newProperties ?? {}) as Record<string, unknown>;
      const removed = (item.properties ?? {}) as Record<string, unknown>;
      for (const key of Object.keys(added)) if (added[key]) delete out[key];
      for (const key of Object.keys(removed)) if (!removed[key]) out[key] = true;
    }
  }
  if (ElementApi.isElement(node)) {
    out = { ...out, children: resolveChildren(node.children, side) };
  }
  return out as Descendant;
}

/** A block's children (blocks or inlines) with the decision applied. */
function resolveChildren(children: Descendant[], side: Side): Descendant[] {
  const blocks = children.some((child) => ElementApi.isElement(child) && !isInline(child));
  if (!blocks) {
    const out: Descendant[] = [];
    for (const child of children) {
      const next = resolveInline(child, side);
      if (next === null) continue;
      // Leaves left side by side with the same marks are one leaf again, as
      // the editor's own normalizing would make them (`**a** **b**` stays bold once).
      const previous = out[out.length - 1];
      if (previous && TextApi.isText(previous) && TextApi.isText(next)) {
        const { text: _a, ...left } = previous;
        const { text: _b, ...right } = next;
        if (JSON.stringify(left) === JSON.stringify(right)) {
          out[out.length - 1] = { ...previous, text: previous.text + next.text };
          continue;
        }
      }
      out.push(next);
    }
    return out.length > 0 ? out : [{ text: "" }];
  }
  return resolveBlocks(children as TElement[], side);
}

/**
 * Blocks with the decision applied, in the order Plate's own transforms take
 * them: line breaks first (a joined line break merges the block with the next
 * one), then whole blocks dropped or kept, then their content.
 */
function resolveBlocks(blocks: TElement[], side: Side): TElement[] {
  const merged = [...blocks];
  for (let index = merged.length - 2; index >= 0; index -= 1) {
    const data = blockData(merged[index]);
    if (!data?.isLineBreak) continue;
    // Accepting a removed line break joins; rejecting an added one does too.
    const join = side === "accept" ? data.type === "remove" : data.type === "insert";
    if (!join) continue;
    merged[index] = {
      ...merged[index],
      children: [...merged[index].children, ...merged[index + 1].children],
    };
    merged.splice(index + 1, 1);
  }
  const out: TElement[] = [];
  for (const block of merged) {
    const data = blockData(block);
    if (data && !data.isLineBreak) {
      if (side === "accept" && data.type === "remove") continue;
      if (side === "reject" && data.type === "insert") continue;
    }
    out.push({ ...strip(block), children: resolveChildren(block.children, side) });
  }
  return out;
}

const EMPTY: Value = [{ type: "p", children: [{ text: "" }] }];

/** The value with every suggestion accepted, or every one rejected. */
export function resolveValue(value: Value, side: Side): Value {
  const out = resolveBlocks(value as TElement[], side);
  return out.length > 0 ? out : structuredClone(EMPTY);
}

/** Whether any node of the value carries a suggestion. */
export function hasSuggestions(value: Value): boolean {
  const walk = (nodes: Descendant[]): boolean =>
    nodes.some(
      (node) =>
        (node as Record<string, unknown>)[SUGGESTION] !== undefined ||
        (ElementApi.isElement(node) && walk(node.children)),
    );
  return walk(value as Descendant[]);
}

/**
 * The editor's text as the document (every suggestion rejected — what a
 * version save writes) and as the proposal (every one accepted — what the
 * suggestion set is saved as); `proposed` is null when nothing is suggested.
 */
export function editorTexts(value: Value): CanvasEditorTexts {
  if (!hasSuggestions(value)) return { text: valueToMarkdown(value), proposed: null };
  const text = valueToMarkdown(resolveValue(value, "reject"));
  const proposed = valueToMarkdown(resolveValue(value, "accept"));
  return { text, proposed: proposed === text ? null : proposed };
}

// -- The list the bar and the controls show --------------------------------------

/** Every suggestion in the value, in document order. */
export function listSuggestions(value: Value): CanvasSuggestion[] {
  const found = new Map<string, { types: Set<string>; inserted: string[]; removed: string[] }>();
  const entry = (id: string) => {
    let item = found.get(id);
    if (!item) {
      item = { types: new Set(), inserted: [], removed: [] };
      found.set(id, item);
    }
    return item;
  };
  const walk = (nodes: Descendant[]) => {
    for (const node of nodes) {
      if (ElementApi.isElement(node) && !isInline(node)) {
        const data = blockData(node);
        if (data?.id) {
          const item = entry(data.id);
          item.types.add(data.type);
          if (!data.isLineBreak)
            (data.type === "insert" ? item.inserted : item.removed).push(NodeApi.string(node));
        }
        walk(node.children);
        continue;
      }
      for (const data of inlineData(node)) {
        if (!data.id) continue;
        const item = entry(data.id);
        item.types.add(data.type);
        const text = NodeApi.string(node);
        if (data.type === "insert") item.inserted.push(text);
        if (data.type === "remove") item.removed.push(text);
      }
      if (ElementApi.isElement(node)) walk(node.children);
    }
  };
  walk(value as Descendant[]);
  return [...found.entries()].map(([id, item]) => {
    const kind: CanvasSuggestion["kind"] = item.types.has("update")
      ? "format"
      : item.types.has("insert") && item.types.has("remove")
        ? "replace"
        : item.types.has("remove")
          ? "remove"
          : "insert";
    const text = (item.inserted.length > 0 ? item.inserted : item.removed)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return {
      id,
      kind,
      summary: text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS - 1)}…` : text,
    };
  });
}

/** The block-level suggestion a top-level block shows, if any. */
export function blockSuggestion(element: TElement): CanvasBlockSuggestion | null {
  const data = blockData(element);
  if (!data?.id || (data.type !== "insert" && data.type !== "remove")) return null;
  return { id: data.id, kind: data.type, lineBreak: Boolean(data.isLineBreak) };
}

/** The suggestion a leaf shows: its id and whether it adds, removes or formats. */
export function leafSuggestion(
  leaf: object,
): { id: string; kind: "insert" | "remove" | "update" } | null {
  const data = inlineData(leaf);
  const last = data[data.length - 1];
  return last?.id ? { id: last.id, kind: last.type } : null;
}

// -- Deciding in the live editor ---------------------------------------------------

/** Turn tracking of the user's typing on (Suggesting mode) or off. */
export function setSuggesting(editor: SlateEditor, on: boolean): void {
  editor.setOption(BaseSuggestionPlugin, "isSuggesting", on);
}

/**
 * Accept or reject suggestions in the live editor with Plate's transforms
 * (undoable, like any edit). Run with tracking off: in Suggesting mode the
 * plugin would otherwise turn the transforms' own removals into suggestions.
 */
export function decideSuggestions(
  editor: SlateEditor,
  ids: string[],
  decision: "accept" | "reject",
): void {
  const api = editor.getApi(BaseSuggestionPlugin).suggestion;
  api.withoutSuggestions(() => {
    editor.tf.withoutNormalizing(() => {
      for (const id of ids) {
        const description: TResolvedSuggestion = {
          suggestionId: id,
          keyId: getSuggestionKey(id),
          type: "insert",
          userId: SUGGESTION_USER,
          createdAt: new Date(0),
        };
        if (decision === "accept") acceptSuggestion(editor, description);
        else rejectSuggestion(editor, description);
      }
    });
  });
}

// -- Loading a saved set: two texts → a value with the suggestions marked --------

/** Properties that say nothing about the text (node ids, a numbered item's start). */
const IGNORED = new Set(["id", "listStart"]);

const nodeKey = (node: Descendant): string =>
  JSON.stringify(node, (key, value: unknown) => (IGNORED.has(key) ? undefined : value));

const propsKey = (node: TElement): string =>
  JSON.stringify(
    Object.keys(node)
      .filter((key) => key !== "children" && !IGNORED.has(key))
      .sort()
      .map((key) => [key, node[key]]),
  );

const isTextBlock = (node: TElement): boolean =>
  node.children.every(
    (child) =>
      TextApi.isText(child) ||
      (isInline(child) && (child as TElement).children.every(TextApi.isText)),
  );

const wordSet = (node: Descendant): Set<string> =>
  new Set(
    NodeApi.string(node)
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [],
  );

/** The share of words two blocks have in common (Jaccard). Two empty blocks are alike. */
function similarity(a: TElement, b: TElement): number {
  const left = wordSet(a);
  const right = wordSet(b);
  if (left.size === 0 && right.size === 0) return 1;
  let common = 0;
  for (const word of left) if (right.has(word)) common += 1;
  return common / (left.size + right.size - common);
}

interface Token {
  text: string;
  /** The leaf's marks (bold, italic, …) without its text. */
  props: Record<string, unknown>;
  propsKey: string;
  /** The link the word is in, or null. */
  link: TElement | null;
  linkKey: string;
}

type Status = "same" | "insert" | "remove";

/** Words, runs of space and single punctuation marks: what a change is made of. */
const WORD = /\s+|[\p{L}\p{N}_'’]+|[^\s\p{L}\p{N}_'’]/gu;

function leafTokens(leaf: TText, link: TElement | null): Token[] {
  const props: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(leaf)) {
    if (key !== "text" && !IGNORED.has(key)) props[key] = value;
  }
  const marks = JSON.stringify(Object.entries(props).sort(([a], [b]) => a.localeCompare(b)));
  const linkKey = link ? propsKey(link) : "";
  return (leaf.text.match(WORD) ?? []).map((text) => ({
    text,
    props,
    propsKey: marks,
    link,
    linkKey,
  }));
}

function blockTokens(block: TElement): Token[] {
  return block.children.flatMap((child) => {
    if (TextApi.isText(child)) return leafTokens(child, null);
    if (isInline(child))
      return (child as TElement).children.flatMap((leaf) => leafTokens(leaf as TText, child));
    return [];
  });
}

const sameToken = (a: Token, b: Token): boolean =>
  a.text === b.text && a.propsKey === b.propsKey && a.linkKey === b.linkKey;

const isSpace = (token: Token): boolean => /^\s+$/.test(token.text);

/**
 * The two blocks' words in reading order, each kept, inserted or deleted,
 * with one suggestion id per stretch of changes. A run of mere space between
 * two changes joins them, and a stretch reads as its deleted words, then its
 * inserted ones (one replacement).
 */
function mergeTokens(
  base: Token[],
  proposed: Token[],
  nextId: () => string,
): { token: Token; status: Status; id: string }[] {
  const chunks = diffArrays(base, proposed, { comparator: sameToken }).map((chunk) => ({
    tokens: chunk.value,
    status: (chunk.added ? "insert" : chunk.removed ? "remove" : "same") as Status,
  }));
  const out: { token: Token; status: Status; id: string }[] = [];
  let removed: Token[] = [];
  let inserted: Token[] = [];
  const flush = () => {
    if (removed.length === 0 && inserted.length === 0) return;
    const id = nextId();
    for (const token of removed) out.push({ token, status: "remove", id });
    for (const token of inserted) out.push({ token, status: "insert", id });
    removed = [];
    inserted = [];
  };
  chunks.forEach((chunk, index) => {
    if (chunk.status === "remove") removed.push(...chunk.tokens);
    else if (chunk.status === "insert") inserted.push(...chunk.tokens);
    else {
      const between =
        index > 0 &&
        index < chunks.length - 1 &&
        chunks[index - 1].status !== "same" &&
        chunks[index + 1].status !== "same" &&
        chunk.tokens.every(isSpace);
      if (between) {
        removed.push(...chunk.tokens);
        inserted.push(...chunk.tokens);
        return;
      }
      flush();
      for (const token of chunk.tokens) out.push({ token, status: "same", id: "" });
    }
  });
  flush();
  return out;
}

const inlineMark = (id: string, type: "insert" | "remove") => ({
  [SUGGESTION]: true,
  [`${KEY_PREFIX}${id}`]: { id, createdAt: 0, type, userId: SUGGESTION_USER },
});

const blockMark = (id: string, type: "insert" | "remove") => ({
  [SUGGESTION]: { id, createdAt: 0, type, userId: SUGGESTION_USER },
});

/** Leaves from consecutive words with the same marks, status and suggestion. */
function toLeaves(items: { token: Token; status: Status; id: string }[]): TText[] {
  const leaves: TText[] = [];
  let last: { propsKey: string; id: string; status: Status } | null = null;
  for (const { token, status, id } of items) {
    const previous = leaves[leaves.length - 1];
    if (
      previous &&
      last &&
      last.propsKey === token.propsKey &&
      last.status === status &&
      last.id === id
    ) {
      previous.text += token.text;
      continue;
    }
    leaves.push({
      ...token.props,
      text: token.text,
      ...(status === "same" ? {} : inlineMark(id, status)),
    });
    last = { propsKey: token.propsKey, id, status };
  }
  return leaves;
}

/** Slate wants a text node at both ends of a block and between two links. */
function padInlines(children: Descendant[]): Descendant[] {
  const out: Descendant[] = [];
  for (const child of children) {
    if (
      ElementApi.isElement(child) &&
      (out.length === 0 || ElementApi.isElement(out[out.length - 1]))
    )
      out.push({ text: "" });
    out.push(child);
  }
  if (out.length === 0 || ElementApi.isElement(out[out.length - 1])) out.push({ text: "" });
  return out;
}

function mergeInline(base: TElement, proposed: TElement, nextId: () => string): Descendant[] {
  const items = mergeTokens(blockTokens(base), blockTokens(proposed), nextId);
  const children: Descendant[] = [];
  let index = 0;
  while (index < items.length) {
    const link = items[index].token.link;
    let end = index + 1;
    while (
      end < items.length &&
      (link ? items[end].token.linkKey === items[index].token.linkKey : !items[end].token.link)
    )
      end += 1;
    const leaves = toLeaves(items.slice(index, end));
    if (link) {
      const { children: _children, ...props } = link;
      children.push({ ...props, children: leaves } as TElement);
    } else children.push(...leaves);
    index = end;
  }
  return padInlines(children);
}

/**
 * One block edited in place, word by word; null when the two cannot be shown
 * that way (another kind of block, other properties, another shape). A table
 * or a code block of the same shape merges cell by cell, line by line.
 */
function mergeBlock(base: TElement, proposed: TElement, nextId: () => string): TElement | null {
  if (base.type !== proposed.type || propsKey(base) !== propsKey(proposed)) return null;
  if (isTextBlock(base) && isTextBlock(proposed))
    return { ...proposed, children: mergeInline(base, proposed, nextId) };
  if (base.children.length !== proposed.children.length) return null;
  const children: TElement[] = [];
  for (let index = 0; index < base.children.length; index += 1) {
    const left = base.children[index];
    const right = proposed.children[index];
    if (!ElementApi.isElement(left) || !ElementApi.isElement(right)) return null;
    const merged = nodeKey(left) === nodeKey(right) ? right : mergeBlock(left, right, nextId);
    if (!merged) return null;
    children.push(merged);
  }
  return { ...proposed, children };
}

const canMerge = (base: TElement, proposed: TElement) =>
  mergeBlock(base, proposed, () => "") !== null;

type Op =
  | { kind: "remove"; block: TElement }
  | { kind: "add"; block: TElement }
  | { kind: "pair"; base: TElement; proposed: TElement };

/**
 * Pair the blocks of a changed stretch. As many blocks on both sides, each
 * mergeable with the one at its place: edited in place. Otherwise each base
 * block pairs with the proposed block most like it, in order; the rest are
 * added or removed.
 */
function align(base: TElement[], proposed: TElement[]): Op[] {
  if (
    base.length > 0 &&
    base.length === proposed.length &&
    base.every((block, index) => canMerge(block, proposed[index]))
  )
    return base.map((block, index) => ({ kind: "pair", base: block, proposed: proposed[index] }));
  const ops: Op[] = [];
  let next = 0;
  for (const block of base) {
    let best = -1;
    let bestScore = 0;
    for (let k = next; k < proposed.length; k += 1) {
      const score = similarity(block, proposed[k]);
      if (score >= PAIR_SIMILARITY && score > bestScore && canMerge(block, proposed[k])) {
        best = k;
        bestScore = score;
      }
    }
    if (best === -1) {
      ops.push({ kind: "remove", block });
      continue;
    }
    for (let k = next; k < best; k += 1) ops.push({ kind: "add", block: proposed[k] });
    ops.push({ kind: "pair", base: block, proposed: proposed[best] });
    next = best + 1;
  }
  for (let k = next; k < proposed.length; k += 1) ops.push({ kind: "add", block: proposed[k] });
  return ops;
}

const blocksOf = (markdown: string): TElement[] => markdownToValue(markdown) as TElement[];

/** The value: base blocks kept, changed stretches marked (word by word, or whole blocks). */
function buildValue(baseMarkdown: string, proposedMarkdown: string, words: boolean): Value {
  const base = blocksOf(baseMarkdown);
  const proposed = blocksOf(proposedMarkdown);
  const value: TElement[] = [];
  let counter = 0;
  const nextId = () => `s${(counter += 1)}`;

  const group = (removed: TElement[], added: TElement[]) => {
    if (removed.length === 0 && added.length === 0) return;
    const id = nextId();
    for (const block of removed) value.push({ ...block, ...blockMark(id, "remove") });
    for (const block of added) value.push({ ...block, ...blockMark(id, "insert") });
  };

  const stretch = (removedRun: TElement[], addedRun: TElement[]) => {
    if (!words) return group(removedRun, addedRun);
    let removed: TElement[] = [];
    let added: TElement[] = [];
    for (const op of align(removedRun, addedRun)) {
      if (op.kind === "remove") removed.push(op.block);
      else if (op.kind === "add") added.push(op.block);
      else {
        group(removed, added);
        removed = [];
        added = [];
        value.push(mergeBlock(op.base, op.proposed, nextId)!);
      }
    }
    group(removed, added);
  };

  let removedRun: TElement[] = [];
  let addedRun: TElement[] = [];
  for (const chunk of diffArrays(base.map(nodeKey), proposed.map(nodeKey))) {
    const count = chunk.value.length;
    if (chunk.removed) {
      removedRun.push(...base.splice(0, count));
      continue;
    }
    if (chunk.added) {
      addedRun.push(...proposed.splice(0, count));
      continue;
    }
    stretch(removedRun, addedRun);
    removedRun = [];
    addedRun = [];
    // The base's own blocks: rejecting everything must give the base back exactly.
    value.push(...base.splice(0, count));
    proposed.splice(0, count);
  }
  stretch(removedRun, addedRun);
  return value.length > 0 ? value : structuredClone(EMPTY);
}

/**
 * The base version with the proposed text's differences marked as
 * suggestions (a saved set, opened). Word by word where it reads that way;
 * if that would not give back both texts exactly (a merge the markdown does
 * not round-trip), whole blocks instead — which always does.
 */
export function suggestionValue(baseMarkdown: string, proposedMarkdown: string): Value {
  const value = buildValue(baseMarkdown, proposedMarkdown, true);
  const texts = editorTexts(value);
  if (
    texts.text === normalizeMarkdown(baseMarkdown) &&
    (texts.proposed ?? texts.text) === normalizeMarkdown(proposedMarkdown)
  )
    return value;
  return buildValue(baseMarkdown, proposedMarkdown, false);
}

/** The proposed text as the editor would save it, once drawn over `baseMarkdown`. */
export const normalizeProposed = (baseMarkdown: string, proposedMarkdown: string): string | null =>
  editorTexts(suggestionValue(baseMarkdown, proposedMarkdown)).proposed;

// -- Rebasing onto a newer version -------------------------------------------------

/**
 * Carry the user's changes (base → proposed) onto `latest`, a newer version
 * written meanwhile: jsdiff's line patch, applied with one line of fuzz in
 * its context. The proposed text on `latest`, or null when the changes no
 * longer fit (the agent changed the same lines).
 */
export function rebaseProposed(base: string, proposed: string, latest: string): string | null {
  const from = normalizeMarkdown(base);
  const to = normalizeMarkdown(proposed);
  const onto = normalizeMarkdown(latest);
  if (from === onto) return to;
  const patch = structuredPatch("base", "proposed", from, to, undefined, undefined, {
    context: 2,
  });
  const result = applyPatch(onto, patch, { fuzzFactor: 1 });
  return result === false ? null : normalizeMarkdown(result);
}

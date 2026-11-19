/**
 * Suggesting mode (plan 44, Phase 4.6): the agent's changes since the base
 * version, as suggestions the user accepts or rejects one by one.
 *
 * Written for the canvas, not taken from Plate's `@platejs/suggestion` (MIT,
 * evaluated at 53.2.3 on 2026-11-19), because its model does not fit ours:
 *
 * - its `diffToSuggestions` diffs characters (diff-match-patch with semantic
 *   clean-up, via `@platejs/diff`), so "analysis" → "analytics" shows as
 *   "analy[sis][tics]"; the canvas marks whole words;
 * - its suggestions are marks that live in the editor's value, accepted or
 *   rejected by editor transforms, and its registry pieces (`suggestion-kit`,
 *   `block-suggestion`) are wired to Plate's discussion plugin and its user
 *   model. Here nothing about a suggestion is stored: a document is versions
 *   of markdown, the suggestions are worked out from two of them, and the
 *   text a decision leaves is built from those two versions' blocks — a pure
 *   function, pinned by tests, that can never mix a half-applied transform
 *   into a saved version.
 *
 * Plate still draws the review: `suggestionDisplay` is a Plate value with the
 * suggestions marked (`canvasSuggestion` on leaves and blocks, drawn by
 * `CanvasSuggestionLeaf` and `CanvasBlockFrame`), shown read-only in the same
 * editor and components as the document itself.
 *
 * The rule: both versions are parsed into blocks (the editor's top-level
 * nodes) and the two block lists are diffed (jsdiff's `diffArrays`, as the
 * compare view uses jsdiff). Inside a stretch of changed blocks, a base block
 * is paired with an agent block (the one at its place when both sides have
 * as many blocks, else the one most like it: same kind and shape, ≥ 30% of
 * its words shared) and that pair becomes ONE suggestion shown word by
 * word; the unpaired blocks around it become one suggestion of added /
 * removed blocks. Accepting keeps the agent's blocks, rejecting puts the
 * base's back; accepting everything gives exactly the agent's version.
 */
import { diffArrays } from "diff";
import {
  ElementApi,
  NodeApi,
  TextApi,
  type Descendant,
  type TElement,
  type TText,
  type Value,
} from "platejs";

import type {
  CanvasSuggestion,
  CanvasSuggestionDecision,
  CanvasSuggestionMark,
  CanvasSuggestionSegment,
  CanvasSuggestionSet,
} from "@/shared/lib/types";

import { markdownToValue, valueToMarkdown } from "./markdown";

/** The node property a suggestion is marked with (never written to markdown). */
export const SUGGESTION_KEY = "canvasSuggestion";

/** Two blocks pair as one edited block when at least this share of their words is common. */
const PAIR_SIMILARITY = 0.3;

/** How much of a suggestion's text its controls name. */
const SUMMARY_CHARS = 60;

/**
 * Properties that say nothing about the text: node ids, and a numbered
 * item's `listStart` (inserting an item renumbers every one after it, which
 * the markdown recomputes anyway).
 */
const IGNORED = new Set(["id", "listStart", SUGGESTION_KEY]);

/** A node as compared: its whole content without the ignored properties. */
const nodeKey = (node: Descendant): string =>
  JSON.stringify(node, (key, value: unknown) => (IGNORED.has(key) ? undefined : value));

/** An element's own properties (not its children), as compared. */
const propsKey = (node: TElement): string =>
  JSON.stringify(
    Object.keys(node)
      .filter((key) => key !== "children" && !IGNORED.has(key))
      .sort()
      .map((key) => [key, node[key]]),
  );

const isLink = (node: Descendant): node is TElement =>
  ElementApi.isElement(node) && node.type === "a";

/** A block whose children are text (and links): its words can be diffed. */
const isTextBlock = (node: TElement): boolean =>
  node.children.every(
    (child) => TextApi.isText(child) || (isLink(child) && child.children.every(TextApi.isText)),
  );

const plainText = (node: Descendant): string => NodeApi.string(node).replace(/\s+/g, " ").trim();

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

// -- Word-level merge of one edited block --------------------------------------

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
    if (isLink(child)) return child.children.flatMap((leaf) => leafTokens(leaf as TText, child));
    return [];
  });
}

const sameToken = (a: Token, b: Token): boolean =>
  a.text === b.text && a.propsKey === b.propsKey && a.linkKey === b.linkKey;

const isSpace = (token: Token): boolean => /^\s+$/.test(token.text);

/**
 * The two blocks' words in reading order, each kept, inserted or deleted.
 * A run of mere space between two changes joins them, and each stretch of
 * changes reads as its deleted words, then its inserted ones.
 */
function mergeTokens(base: Token[], agent: Token[]): { token: Token; status: Status }[] {
  const chunks = diffArrays(base, agent, { comparator: sameToken }).map((chunk) => ({
    tokens: chunk.value,
    status: (chunk.added ? "insert" : chunk.removed ? "remove" : "same") as Status,
  }));
  const out: { token: Token; status: Status }[] = [];
  let removed: Token[] = [];
  let inserted: Token[] = [];
  const flush = () => {
    for (const token of removed) out.push({ token, status: "remove" });
    for (const token of inserted) out.push({ token, status: "insert" });
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
      for (const token of chunk.tokens) out.push({ token, status: "same" });
    }
  });
  flush();
  return out;
}

/** Leaves from consecutive words with the same marks and status. */
function toLeaves(items: { token: Token; status: Status }[], id: string): TText[] {
  const leaves: TText[] = [];
  let last: { propsKey: string; status: Status } | null = null;
  for (const { token, status } of items) {
    const previous = leaves[leaves.length - 1];
    if (previous && last && last.propsKey === token.propsKey && last.status === status) {
      previous.text += token.text;
      continue;
    }
    const mark: CanvasSuggestionMark | null =
      status === "same" ? null : { id, kind: status === "insert" ? "insert" : "remove" };
    leaves.push({ ...token.props, text: token.text, ...(mark ? { [SUGGESTION_KEY]: mark } : {}) });
    last = { propsKey: token.propsKey, status };
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

function mergeInline(base: TElement, agent: TElement, id: string): Descendant[] {
  const items = mergeTokens(blockTokens(base), blockTokens(agent));
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
    const leaves = toLeaves(items.slice(index, end), id);
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
 * that way (another kind of block, other properties, another shape).
 * A table or a code block of the same shape merges cell by cell, line by line.
 */
function mergeBlock(base: TElement, agent: TElement, id: string): TElement | null {
  if (base.type !== agent.type || propsKey(base) !== propsKey(agent)) return null;
  if (isTextBlock(base) && isTextBlock(agent))
    return { ...agent, children: mergeInline(base, agent, id) };
  if (base.children.length !== agent.children.length) return null;
  const children: TElement[] = [];
  for (let index = 0; index < base.children.length; index += 1) {
    const left = base.children[index];
    const right = agent.children[index];
    if (!ElementApi.isElement(left) || !ElementApi.isElement(right)) return null;
    const merged = nodeKey(left) === nodeKey(right) ? right : mergeBlock(left, right, id);
    if (!merged) return null;
    children.push(merged);
  }
  return { ...agent, children };
}

// -- The set of suggestions ------------------------------------------------------

type Op =
  | { kind: "remove"; block: TElement }
  | { kind: "add"; block: TElement }
  | { kind: "pair"; base: TElement; agent: TElement };

/**
 * Pair the blocks of a changed stretch. As many blocks on both sides, each
 * mergeable with the one at its place: edited in place, paired in order
 * however much the words changed. Otherwise each base block pairs with the
 * agent block most like it, in order; the rest are added or removed.
 */
function align(base: TElement[], agent: TElement[]): Op[] {
  if (
    base.length > 0 &&
    base.length === agent.length &&
    base.every((block, index) => mergeBlock(block, agent[index], ""))
  )
    return base.map((block, index) => ({ kind: "pair", base: block, agent: agent[index] }));
  const ops: Op[] = [];
  let next = 0;
  for (const block of base) {
    let best = -1;
    let bestScore = 0;
    for (let k = next; k < agent.length; k += 1) {
      const score = similarity(block, agent[k]);
      if (score >= PAIR_SIMILARITY && score > bestScore && mergeBlock(block, agent[k], "")) {
        best = k;
        bestScore = score;
      }
    }
    if (best === -1) {
      ops.push({ kind: "remove", block });
      continue;
    }
    for (let k = next; k < best; k += 1) ops.push({ kind: "add", block: agent[k] });
    ops.push({ kind: "pair", base: block, agent: agent[best] });
    next = best + 1;
  }
  for (let k = next; k < agent.length; k += 1) ops.push({ kind: "add", block: agent[k] });
  return ops;
}

const summaryOf = (blocks: TElement[]): string => {
  const text = blocks.map(plainText).filter(Boolean).join(" ");
  return text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS - 1)}…` : text;
};

const blocksOf = (markdown: string): TElement[] => markdownToValue(markdown) as TElement[];

/** The suggestions that turn `baseMarkdown` into `agentMarkdown`, in document order. */
export function buildSuggestions(baseMarkdown: string, agentMarkdown: string): CanvasSuggestionSet {
  const base = blocksOf(baseMarkdown);
  const agent = blocksOf(agentMarkdown);
  const segments: CanvasSuggestionSegment[] = [];
  const suggestions: CanvasSuggestion[] = [];
  let counter = 0;
  const nextId = () => `s${(counter += 1)}`;

  const addGroup = (removed: TElement[], added: TElement[]) => {
    if (removed.length === 0 && added.length === 0) return;
    const id = nextId();
    segments.push({ kind: "change", id, base: removed, agent: added, merged: null });
    suggestions.push({
      id,
      kind: removed.length === 0 ? "insert" : added.length === 0 ? "remove" : "replace",
      summary: summaryOf(added.length > 0 ? added : removed),
    });
  };

  const flushStretch = (removedRun: TElement[], addedRun: TElement[]) => {
    let removed: TElement[] = [];
    let added: TElement[] = [];
    for (const op of align(removedRun, addedRun)) {
      if (op.kind === "remove") removed.push(op.block);
      else if (op.kind === "add") added.push(op.block);
      else {
        addGroup(removed, added);
        removed = [];
        added = [];
        const id = nextId();
        segments.push({
          kind: "change",
          id,
          base: [op.base],
          agent: [op.agent],
          merged: mergeBlock(op.base, op.agent, id),
        });
        suggestions.push({ id, kind: "replace", summary: summaryOf([op.agent]) });
      }
    }
    addGroup(removed, added);
  };

  let removedRun: TElement[] = [];
  let addedRun: TElement[] = [];
  for (const chunk of diffArrays(base.map(nodeKey), agent.map(nodeKey))) {
    const count = chunk.value.length;
    if (chunk.removed) {
      removedRun.push(...base.splice(0, count));
      continue;
    }
    if (chunk.added) {
      addedRun.push(...agent.splice(0, count));
      continue;
    }
    flushStretch(removedRun, addedRun);
    removedRun = [];
    addedRun = [];
    base.splice(0, count);
    for (const block of agent.splice(0, count)) segments.push({ kind: "same", block });
  }
  flushStretch(removedRun, addedRun);
  return { segments, suggestions };
}

const withMark = (block: TElement, mark: CanvasSuggestionMark): TElement => ({
  ...structuredClone(block),
  [SUGGESTION_KEY]: mark,
});

/**
 * The document as the review shows it: decided suggestions as they were
 * decided (the agent's blocks, or the base's back), undecided ones marked —
 * an edited block word by word, added and removed blocks whole.
 */
export function suggestionDisplay(
  set: CanvasSuggestionSet,
  decisions: Record<string, CanvasSuggestionDecision>,
): Value {
  const value: TElement[] = [];
  for (const segment of set.segments) {
    if (segment.kind === "same") {
      value.push(structuredClone(segment.block));
      continue;
    }
    const decision = decisions[segment.id];
    if (decision === "accept") value.push(...structuredClone(segment.agent));
    else if (decision === "reject") value.push(...structuredClone(segment.base));
    else if (segment.merged)
      value.push(withMark(segment.merged, { id: segment.id, kind: "change" }));
    else {
      for (const block of segment.base)
        value.push(withMark(block, { id: segment.id, kind: "remove" }));
      for (const block of segment.agent)
        value.push(withMark(block, { id: segment.id, kind: "insert" }));
    }
  }
  return value.length > 0 ? value : [{ type: "p", children: [{ text: "" }] }];
}

/**
 * The text the decisions leave: the agent's version with every rejected
 * suggestion put back to the base, as the editor writes markdown. With
 * nothing rejected it is the agent's version itself.
 */
export function resolveSuggestions(
  set: CanvasSuggestionSet,
  rejected: ReadonlySet<string>,
): string {
  const value: TElement[] = [];
  for (const segment of set.segments) {
    if (segment.kind === "same") value.push(segment.block);
    else value.push(...(rejected.has(segment.id) ? segment.base : segment.agent));
  }
  return valueToMarkdown(value);
}

/** The suggestion a node is marked with, if any. */
export const suggestionMark = (node: object): CanvasSuggestionMark | null => {
  const mark = (node as Record<string, unknown>)[SUGGESTION_KEY];
  return mark && typeof mark === "object" ? (mark as CanvasSuggestionMark) : null;
};

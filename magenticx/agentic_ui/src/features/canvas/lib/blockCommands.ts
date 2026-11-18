/**
 * Whole-block commands for the canvas (plan 44, Phase 4.2): the block menu
 * (⋮⋮ handle, the toolbar's Block button), turn-into, and the table
 * toolbar. Adapted from Plate's registry (`block-context-menu`'s Delete /
 * Duplicate / Turn into, `transforms.ts`'s `setBlockType`, `table-node`'s
 * floating toolbar), kept out of the components so they are testable on a
 * headless editor.
 *
 * Every command works on the **target blocks**: the blocks picked by block
 * selection when there are any, else the top-level blocks the text selection
 * touches. Blocks are top-level only: a markdown document has no nested
 * blocks besides list indents, quotes, code lines and table cells, and each
 * of those is handled as its parent.
 */
import {
  ElementApi,
  KEYS,
  NodeApi,
  type Descendant,
  type Path,
  type SlateEditor,
  type TElement,
  type TNode,
} from "platejs";
import { insertTable } from "@platejs/table";
import { BlockSelectionPlugin } from "@platejs/selection/react";
import { TablePlugin } from "@platejs/table/react";

/** What a block can be turned into, in the menus' order. */
export const CANVAS_BLOCK_KINDS = [
  { kind: KEYS.p, label: "Text" },
  { kind: KEYS.h1, label: "Title" },
  { kind: KEYS.h2, label: "Heading" },
  { kind: KEYS.h3, label: "Subheading" },
  { kind: KEYS.ul, label: "Bulleted list" },
  { kind: KEYS.ol, label: "Numbered list" },
  { kind: KEYS.listTodo, label: "Checklist" },
  { kind: KEYS.blockquote, label: "Quote" },
  { kind: KEYS.codeBlock, label: "Code" },
] as const;

export type CanvasBlockKind = (typeof CANVAS_BLOCK_KINDS)[number]["kind"];

type Entry = [TElement, Path];

/** Block types no turn-into applies to (a table stays a table, a rule a rule). */
const FIXED_TYPES: string[] = [KEYS.table, KEYS.hr, KEYS.img];
const TEXT_TYPES: string[] = [KEYS.p, KEYS.h1, KEYS.h2, KEYS.h3, KEYS.h4];
const LIST_STYLE: Partial<Record<CanvasBlockKind, string>> = {
  [KEYS.ul]: "disc",
  [KEYS.ol]: "decimal",
  [KEYS.listTodo]: KEYS.listTodo,
};

const blockSelection = (editor: SlateEditor) => editor.getApi(BlockSelectionPlugin).blockSelection;

/** Whether block selection holds any block (Esc, drag over the margin, the ⋮⋮ handle). */
export function isSelectingBlocks(editor: SlateEditor): boolean {
  const ids = editor.getOption(BlockSelectionPlugin, "selectedIds");
  return Boolean(ids && ids.size > 0);
}

/** The blocks a command applies to, top-level and in document order. */
export function targetBlocks(editor: SlateEditor): Entry[] {
  if (isSelectingBlocks(editor)) {
    const ids = editor.getOption(BlockSelectionPlugin, "selectedIds")!;
    return editor.children
      .map((node, index): Entry => [node as TElement, [index]])
      .filter(([node]) => typeof node.id === "string" && ids.has(node.id));
  }
  const selection = editor.selection;
  if (!selection) return [];
  const [start, end] = [selection.anchor.path[0], selection.focus.path[0]].sort((a, b) => a - b);
  const entries: Entry[] = [];
  for (let index = start; index <= end; index += 1) {
    const node = editor.children[index] as TElement | undefined;
    if (node) entries.push([node, [index]]);
  }
  return entries;
}

/**
 * The top-level blocks with these ids, in document order. A menu takes its
 * targets when it opens and acts on them by id: while it is open the focus
 * moves into it, and the editor may drop its block selection on the way.
 */
export function blocksById(editor: SlateEditor, ids: readonly string[]): Entry[] {
  const wanted = new Set(ids);
  return editor.children
    .map((node, index): Entry => [node as TElement, [index]])
    .filter(([node]) => typeof node.id === "string" && wanted.has(node.id));
}

/** The ids of entries (blocks without an id are skipped). */
export const idsOf = (entries: Entry[]): string[] =>
  entries.map(([node]) => node.id).filter((id): id is string => typeof id === "string");

/** Select these top-level blocks as a block selection (by their ids). */
export function selectBlocks(editor: SlateEditor, indexes: number[]): void {
  const ids = indexes
    .map((index) => (editor.children[index] as TElement | undefined)?.id)
    .filter((id): id is string => typeof id === "string");
  if (ids.length === 0) return;
  editor.tf.deselect();
  blockSelection(editor).set(ids);
}

/** A document is never empty: the editor needs one block to type into. */
function ensureBlock(editor: SlateEditor): void {
  if (editor.children.length === 0) {
    editor.tf.insertNodes({ type: KEYS.p, children: [{ text: "" }] }, { at: [0] });
  }
}

/** The caret at the start of the block now at `index` (or the end of the last one). */
function caretNear(editor: SlateEditor, index: number): void {
  const last = editor.children.length - 1;
  if (index <= last) editor.tf.select(editor.api.start([index])!);
  else editor.tf.select(editor.api.end([last])!);
}

/** Delete the target blocks; the caret lands where they were. */
export function deleteBlocks(editor: SlateEditor, entries = targetBlocks(editor)): void {
  if (entries.length === 0) return;
  const first = entries[0][1][0];
  blockSelection(editor).clear();
  editor.tf.withoutNormalizing(() => {
    for (const [, path] of [...entries].reverse()) editor.tf.removeNodes({ at: path });
    ensureBlock(editor);
  });
  caretNear(editor, first);
}

/** A copy of a node with no ids, so the copy gets fresh ones. */
function withoutIds(node: TNode): TNode {
  const { id: _id, ...rest } = node as TNode & { id?: unknown; children?: TNode[] };
  if (Array.isArray(rest.children)) rest.children = rest.children.map(withoutIds);
  return rest as TNode;
}

/** Duplicate the target blocks right after the last of them; the copies are selected. */
export function duplicateBlocks(
  editor: SlateEditor,
  entries = targetBlocks(editor),
  selectAsBlocks = isSelectingBlocks(editor),
): void {
  if (entries.length === 0) return;
  const at = entries[entries.length - 1][1][0] + 1;
  const copies = entries.map(([node]) => withoutIds(node) as TElement);
  editor.tf.insertNodes(copies, { at: [at] });
  const indexes = copies.map((_, offset) => at + offset);
  if (selectAsBlocks) selectBlocks(editor, indexes);
  else editor.tf.select(editor.api.start([at])!);
}

/**
 * Move the target blocks one place up or down. They move as one stretch,
 * from the first to the last of them, so the order inside is kept.
 */
export function moveBlocks(
  editor: SlateEditor,
  direction: "up" | "down",
  entries = targetBlocks(editor),
  selectAsBlocks = isSelectingBlocks(editor),
): void {
  if (entries.length === 0) return;
  const first = entries[0][1][0];
  const last = entries[entries.length - 1][1][0];
  if (direction === "up") {
    if (first === 0) return;
    editor.tf.moveNodes({ at: [first - 1], to: [last] });
  } else {
    if (last >= editor.children.length - 1) return;
    editor.tf.moveNodes({ at: [last + 1], to: [first] });
  }
  if (selectAsBlocks) {
    const ids = idsOf(entries);
    editor.tf.deselect();
    blockSelection(editor).set(ids);
  }
}

/** Whether the targets can move that way at all (for the menu's disabled state). */
export function canMoveBlocks(
  editor: SlateEditor,
  direction: "up" | "down",
  entries = targetBlocks(editor),
): boolean {
  if (entries.length === 0) return false;
  return direction === "up"
    ? entries[0][1][0] > 0
    : entries[entries.length - 1][1][0] < editor.children.length - 1;
}

/** Inline elements (links) never stand for a block. */
const isInlineElement = (node: TElement) => node.type === KEYS.link;

/** A plain text block: a type and its inline children, no list or quote around it. */
type Plain = { type: string; children: Descendant[] };

/** A target as the plain blocks inside it: a quote's paragraphs, a code block's lines. */
function plainBlocks(node: TElement): Plain[] {
  if (node.type === KEYS.blockquote) {
    return (node.children as TElement[]).flatMap((child) =>
      ElementApi.isElement(child) && !isInlineElement(child)
        ? plainBlocks(child)
        : [{ type: KEYS.p, children: [child as Descendant] }],
    );
  }
  if (node.type === KEYS.codeBlock) {
    return (node.children as TElement[]).map((line) => ({
      type: KEYS.p,
      children: [{ text: NodeApi.string(line) }],
    }));
  }
  return [{ type: TEXT_TYPES.includes(node.type) ? node.type : KEYS.p, children: node.children }];
}

/** The blocks a stretch of plain blocks becomes as `kind`. */
function build(kind: CanvasBlockKind, plains: Plain[]): TElement[] {
  if (kind === KEYS.blockquote) {
    return [
      {
        type: KEYS.blockquote,
        children: plains.map((plain) => ({ type: KEYS.p, children: plain.children })),
      },
    ];
  }
  if (kind === KEYS.codeBlock) {
    return [
      {
        type: KEYS.codeBlock,
        children: plains.map((plain) => ({
          type: KEYS.codeLine,
          children: [{ text: plain.children.map((child) => NodeApi.string(child)).join("") }],
        })),
      },
    ];
  }
  const style = LIST_STYLE[kind];
  if (style) {
    // A markdown list item is a paragraph: a heading in a list cannot be written.
    return plains.map((plain) => ({
      type: KEYS.p,
      children: plain.children,
      indent: 1,
      listStyleType: style,
      ...(style === KEYS.listTodo ? { checked: false } : {}),
    }));
  }
  return plains.map((plain) => ({ type: kind, children: plain.children }));
}

/** Consecutive runs of entries (by top-level index). */
function runs(entries: Entry[]): Entry[][] {
  const out: Entry[][] = [];
  for (const entry of entries) {
    const run = out[out.length - 1];
    if (run && run[run.length - 1][1][0] + 1 === entry[1][0]) run.push(entry);
    else out.push([entry]);
  }
  return out;
}

/**
 * Turn the target blocks into `kind`. Text blocks and list items change in
 * place (the caret and the undo step stay small); quotes and code blocks are
 * rebuilt from their lines, and a run of blocks turned into a quote or code
 * becomes one quote or one code block. Tables, rules and images are left as
 * they are. Block selection, if any, is kept on the result.
 */
export function turnInto(
  editor: SlateEditor,
  kind: CanvasBlockKind,
  entries = targetBlocks(editor),
  selectAsBlocks = isSelectingBlocks(editor),
): void {
  const movable = entries.filter(([node]) => !FIXED_TYPES.includes(node.type));
  if (movable.length === 0) return;
  const selecting = selectAsBlocks;
  const style = LIST_STYLE[kind];
  const inPlace =
    !(kind === KEYS.blockquote || kind === KEYS.codeBlock) &&
    movable.every(([node]) => node.type !== KEYS.blockquote && node.type !== KEYS.codeBlock);

  if (inPlace) {
    editor.tf.withoutNormalizing(() => {
      for (const [node, path] of movable) {
        if (style) {
          editor.tf.setNodes(
            {
              type: KEYS.p,
              indent: (node[KEYS.indent] as number | undefined) || 1,
              listStyleType: style,
              ...(style === KEYS.listTodo ? { checked: Boolean(node.checked) } : {}),
            },
            { at: path },
          );
          if (style !== KEYS.listTodo) editor.tf.unsetNodes(KEYS.listChecked, { at: path });
        } else {
          editor.tf.unsetNodes([KEYS.listType, KEYS.indent, KEYS.listChecked, KEYS.listStart], {
            at: path,
          });
          editor.tf.setNodes({ type: kind }, { at: path });
        }
      }
    });
    if (selecting) selectBlocks(editor, movable.map(([, path]) => path[0]));
    return;
  }

  // Rebuild, last run first so earlier indexes stay valid.
  const placed: number[][] = [];
  editor.tf.withoutNormalizing(() => {
    for (const run of runs(movable).reverse()) {
      const at = run[0][1][0];
      const next = build(
        kind,
        run.flatMap(([node]) => plainBlocks(node)),
      );
      for (const [, path] of [...run].reverse()) editor.tf.removeNodes({ at: path });
      editor.tf.insertNodes(next, { at: [at] });
      // Indexes after this run shift by the size change; later runs are done.
      placed.unshift(next.map((_, offset) => at + offset));
      const shift = next.length - run.length;
      for (let i = 1; i < placed.length; i += 1) placed[i] = placed[i].map((n) => n + shift);
    }
  });
  const indexes = placed.flat();
  if (selecting) selectBlocks(editor, indexes);
  else {
    const last = indexes[indexes.length - 1];
    editor.tf.select(editor.api.end([last])!);
  }
}

/** The kind of a block, for the menus' checkmark and the style label. */
export function blockKind(node: TElement | undefined): CanvasBlockKind {
  if (!node) return KEYS.p;
  if (node.type === KEYS.blockquote) return KEYS.blockquote;
  if (node.type === KEYS.codeBlock) return KEYS.codeBlock;
  const style = node[KEYS.listType];
  if (style === "disc") return KEYS.ul;
  if (style === "decimal") return KEYS.ol;
  if (style === KEYS.listTodo) return KEYS.listTodo;
  return CANVAS_BLOCK_KINDS.some((item) => item.kind === node.type)
    ? (node.type as CanvasBlockKind)
    : KEYS.p;
}

/** The kind of the block holding the caret (or the first selected block). */
export function currentBlockKind(editor: SlateEditor): CanvasBlockKind {
  return blockKind(targetBlocks(editor)[0]?.[0]);
}

// ── Tables ────────────────────────────────────────────────────────────────

/**
 * Insert a `rows` × `cols` table with a header row and put the caret in its
 * first cell. An empty paragraph at the caret is replaced, not pushed down,
 * so inserting never leaves stray empty lines.
 */
export function insertCanvasTable(editor: SlateEditor, rows = 3, cols = 3): void {
  const index = editor.selection?.focus.path[0];
  const current = index === undefined ? undefined : (editor.children[index] as TElement);
  const emptyParagraph =
    current !== undefined &&
    current.type === KEYS.p &&
    !current[KEYS.listType] &&
    NodeApi.string(current) === "";
  editor.tf.withoutNormalizing(() => {
    insertTable(editor, { rowCount: rows, colCount: cols, header: true }, { select: true });
    if (emptyParagraph && index !== undefined) {
      const after = editor.children[index] as TElement | undefined;
      if (after && after.type === KEYS.p && NodeApi.string(after) === "") {
        editor.tf.removeNodes({ at: [index] });
      }
    }
  });
  // The caret into the first cell of the new table.
  const tableIndex = editor.children.findIndex(
    (node, i) => (node as TElement).type === KEYS.table && i >= (index ?? 0),
  );
  if (tableIndex >= 0) editor.tf.select(editor.api.start([tableIndex])!);
  editor.tf.focus();
}

/** The top-level index of the table holding the caret, if any. */
export function tableAtSelection(editor: SlateEditor): number | null {
  const entry = editor.api.above({ match: { type: KEYS.table } });
  return entry ? entry[1][0] : null;
}

export type CanvasTableAction =
  | "rowAbove"
  | "rowBelow"
  | "deleteRow"
  | "colLeft"
  | "colRight"
  | "deleteCol"
  | "deleteTable";

/**
 * Run one table-toolbar action at the caret (Plate's table transforms). An
 * insert leaves the caret in the cell the user picked, so "insert row below,
 * then delete row" never deletes a row they did not point at.
 */
export function tableAction(editor: SlateEditor, action: CanvasTableAction): void {
  const index = tableAtSelection(editor);
  if (index === null) return;
  const tf = editor.getTransforms(TablePlugin);
  const table = editor.children[index] as TElement;
  const rowCount = table.children.length;
  const colCount = (table.children[0] as TElement | undefined)?.children.length ?? 0;
  switch (action) {
    case "rowAbove":
      tf.insert.tableRow({ before: true });
      break;
    case "rowBelow":
      tf.insert.tableRow();
      break;
    case "colLeft":
      tf.insert.tableColumn({ before: true });
      break;
    case "colRight":
      tf.insert.tableColumn();
      break;
    case "deleteRow":
      // The last row, or the last column, is the whole table.
      if (rowCount <= 1) deleteTableAt(editor, index);
      else tf.remove.tableRow();
      break;
    case "deleteCol":
      if (colCount <= 1) deleteTableAt(editor, index);
      else tf.remove.tableColumn();
      break;
    case "deleteTable":
      deleteTableAt(editor, index);
      break;
  }
  editor.tf.focus();
}

function deleteTableAt(editor: SlateEditor, index: number): void {
  editor.tf.withoutNormalizing(() => {
    editor.tf.removeNodes({ at: [index] });
    ensureBlock(editor);
  });
  caretNear(editor, index);
}

/**
 * The canvas editor's plugins: Plate's React plugins wired to the document
 * components in `shared/ui/plate`, plus find-in-document, the markdown
 * pipeline and the canvas view frame. It mirrors `canvasBasePlugins` in `markdown.ts` node for node — a type
 * in one list and not the other would parse but not render, or the reverse.
 *
 * Adapted from Plate's registry kits (`basic-blocks-kit`, `list-kit`,
 * `table-kit`, `link-kit`), without their AI, mention, emoji and date
 * coupling. Phase 4.2 edits with the same kit (the toolbar in
 * `CanvasToolbar` drives these plugins), plus block selection
 * (`block-selection-kit`: drag over the margin, Esc, Ctrl/Cmd+A, the ⋮⋮
 * handle) and the canvas's Backspace / Delete rules (`editorDelete.ts`).
 * Comments are painted over the text (Highlight API), not plugins. Suggesting
 * mode (4.6) is Plate's `SuggestionPlugin` (`@platejs/suggestion`): with its
 * `isSuggesting` option on, the user's typing and deleting become suggestion
 * marks (`CanvasSuggestionLeaf`, and block marks in `CanvasBlockFrame`). It
 * comes last, so in Suggesting it sees every key before the delete, list and
 * table rules (which would change the text directly); with the option off it
 * passes everything through to them. Its marks are never serialized as
 * such: `lib/suggestions.ts` resolves them to the document's two texts
 * first, so the plugin has no counterpart in `canvasBasePlugins`.
 */
import { createElement } from "react";
import { isHotkey, KEYS, type TElement, type Value } from "platejs";
import {
  createPlateEditor,
  createPlatePlugin,
  ParagraphPlugin,
  type RenderNodeWrapper,
} from "platejs/react";
import {
  BlockquotePlugin,
  BoldPlugin,
  CodePlugin,
  H1Plugin,
  H2Plugin,
  H3Plugin,
  H4Plugin,
  HorizontalRulePlugin,
  ItalicPlugin,
  StrikethroughPlugin,
} from "@platejs/basic-nodes/react";
import { CodeBlockPlugin, CodeLinePlugin } from "@platejs/code-block/react";
import { FindReplacePlugin } from "@platejs/find-replace";
import { IndentPlugin } from "@platejs/indent/react";
import { LinkPlugin } from "@platejs/link/react";
import { isOrderedList } from "@platejs/list";
import { ListPlugin } from "@platejs/list/react";
import { ImagePlugin } from "@platejs/media/react";
import { BlockSelectionPlugin } from "@platejs/selection/react";
import { findSuggestionProps } from "@platejs/suggestion";
import { SuggestionPlugin } from "@platejs/suggestion/react";
import {
  TableCellHeaderPlugin,
  TableCellPlugin,
  TablePlugin,
  TableRowPlugin,
} from "@platejs/table/react";

import {
  BlockquoteElement,
  CodeBlockElement,
  CodeLineElement,
  HrElement,
  ImageElement,
  ParagraphElement,
} from "@/shared/ui/plate/block-nodes";
import { BlockList } from "@/shared/ui/plate/block-list";
import { H1Element, H2Element, H3Element, H4Element } from "@/shared/ui/plate/heading-node";
import { CodeLeaf, LinkElement, SearchHighlightLeaf } from "@/shared/ui/plate/inline-nodes";
import {
  TableCellElement,
  TableCellHeaderElement,
  TableRowElement,
} from "@/shared/ui/plate/table-node";

import { CanvasBlockFrame } from "../components/canvas_parts/CanvasBlockFrame";
import { CanvasSuggestionLeaf } from "../components/canvas_parts/CanvasSuggestionLeaf";
import { CanvasTableElement } from "../components/canvas_parts/CanvasTableElement";
import { canvasViewPlugin } from "./canvasView";
import { canvasDeletePlugin } from "./editorDelete";
import { canvasMarkdownPlugin } from "./markdown";
import { canvasPastePlugin } from "./pasteCleanup";
import { blockSuggestion, SUGGESTION_USER } from "./suggestions";

export const findPlugin = FindReplacePlugin.configure({
  options: { search: "" },
  render: { node: SearchHighlightLeaf },
});

/** Blocks a list item (or an indent) can be. */
const LIST_TARGETS = [...KEYS.heading, KEYS.p, KEYS.blockquote, KEYS.codeBlock];

/**
 * Wraps every top-level block in the canvas frame (fold chevron, byline). Nested blocks — list paragraphs inside a table cell, code
 * lines — are left alone.
 */
const canvasBlockFrame: RenderNodeWrapper = ({ path, element }) => {
  if (path.length !== 1) return;
  const index = path[0];
  const id = typeof element.id === "string" ? element.id : undefined;
  const suggestion = blockSuggestion(element as TElement);
  return ({ children }) =>
    createElement(CanvasBlockFrame, { index, id, type: element.type, suggestion, children });
};

/** Top-level blocks Enter splits as a suggested line break, as Plate's plugin does a paragraph. */
const SPLIT_TYPES: string[] = [...KEYS.heading];

/**
 * Enter in Suggesting mode, in a heading: Plate's plugin tracks a new line
 * only in a plain paragraph and puts a "
" character into any other block
 * (a heading with a line break inside is not markdown). Here a heading splits
 * like a paragraph does, the split marked as a suggested line break, so
 * rejecting it joins the two halves back. Everything else is the plugin's.
 */
const suggestingBreakPlugin = createPlatePlugin({ key: "canvasSuggestingBreak" }).overrideEditor(
  ({ editor, tf: { insertBreak } }) => ({
    transforms: {
      insertBreak() {
        const entry = editor.api.block();
        const selection = editor.selection;
        if (
          !editor.getOption(SuggestionPlugin, "isSuggesting") ||
          !entry ||
          !selection ||
          entry[1].length !== 1 ||
          !SPLIT_TYPES.includes(entry[0].type)
        )
          return insertBreak();
        const [, path] = entry;
        const { id, createdAt } = findSuggestionProps(editor, { at: selection, type: "insert" });
        editor.getApi(SuggestionPlugin).suggestion.withoutSuggestions(() => insertBreak());
        editor.tf.withoutMerging(() => {
          editor.tf.setNodes(
            {
              [KEYS.suggestion]: {
                id,
                createdAt,
                isLineBreak: true,
                type: "insert",
                userId: SUGGESTION_USER,
              },
            },
            { at: path },
          );
        });
      },
    },
  }),
);

export const canvasEditorPlugins = [
  ParagraphPlugin.withComponent(ParagraphElement),
  H1Plugin.configure({ node: { component: H1Element }, rules: { break: { empty: "reset" } } }),
  H2Plugin.configure({ node: { component: H2Element }, rules: { break: { empty: "reset" } } }),
  H3Plugin.configure({ node: { component: H3Element }, rules: { break: { empty: "reset" } } }),
  H4Plugin.configure({ node: { component: H4Element }, rules: { break: { empty: "reset" } } }),
  BlockquotePlugin.withComponent(BlockquoteElement),
  HorizontalRulePlugin.withComponent(HrElement),
  BoldPlugin,
  ItalicPlugin,
  // Bold (mod+b) and italic (mod+i) bring their shortcuts; these two take
  // the ones Plate's registry kit gives them.
  StrikethroughPlugin.configure({ shortcuts: { toggle: { keys: "mod+shift+x" } } }),
  CodePlugin.configure({
    node: { component: CodeLeaf },
    shortcuts: { toggle: { keys: "mod+e" } },
  }),
  LinkPlugin.withComponent(LinkElement),
  CodeBlockPlugin.withComponent(CodeBlockElement),
  CodeLinePlugin.withComponent(CodeLineElement),
  ImagePlugin.withComponent(ImageElement),
  IndentPlugin.configure({ inject: { targetPlugins: LIST_TARGETS } }),
  ListPlugin.configure({
    inject: {
      // Bullets are the block itself as a list item (Plate's indent-list model).
      nodeProps: {
        nodeKey: KEYS.listType,
        query: ({ nodeProps }) => {
          const element = nodeProps.element;
          return Boolean(element?.listStyleType) && !isOrderedList(element!);
        },
        transformProps: ({ props }) => ({
          ...props,
          role: "listitem",
          style: { ...props.style, display: "list-item" },
        }),
      },
      targetPlugins: LIST_TARGETS,
    },
    render: { belowNodes: BlockList },
  }),
  TablePlugin.withComponent(CanvasTableElement),
  TableRowPlugin.withComponent(TableRowElement),
  TableCellPlugin.withComponent(TableCellElement),
  TableCellHeaderPlugin.withComponent(TableCellHeaderElement),
  // Block selection works on top-level blocks only: a markdown document's
  // nested blocks (cell paragraphs, code lines, quoted paragraphs) move with
  // their parent. Dragging a selection starts in the margin beside the text;
  // on a touch screen that drag would fight scrolling, so touch is off there
  // (the toolbar's Block button is the phone's way in).
  BlockSelectionPlugin.configure({
    options: {
      isSelectable: (_element, path) => path.length === 1,
      areaOptions: { features: { singleTap: { allow: false }, touch: false } },
      // With blocks selected the keys go to the plugin's hidden input, which
      // runs undo / redo itself; the browser's own undo would then reach the
      // editor as well and undo a second step. Ctrl+Y (Windows redo) is
      // not handled by the plugin, so it is here.
      onKeyDownSelecting: (editor, event) => {
        if (isHotkey(["mod+z", "mod+shift+z"])(event)) event.preventDefault();
        if (isHotkey("mod+y")(event)) {
          event.preventDefault();
          editor.redo();
        }
      },
    },
  }),
  findPlugin,
  canvasMarkdownPlugin,
  canvasViewPlugin.configure({ render: { aboveNodes: canvasBlockFrame } }),
  canvasPastePlugin,
  // After the table and list plugins, so its Backspace / Delete rules run before theirs.
  canvasDeletePlugin,
  // Last: in Suggesting mode the user's typing is tracked before any rule above changes the text.
  SuggestionPlugin.configure({
    node: { component: CanvasSuggestionLeaf },
    options: { currentUserId: SUGGESTION_USER, isSuggesting: false },
  }),
  suggestingBreakPlugin,
];

/** Node ids on every block: block selection finds blocks by id (they never reach the markdown). */
export const CANVAS_NODE_ID = true;

/**
 * A canvas editor outside React (the same plugins the view mounts): what the
 * tests drive, so a command is pinned on the editor the user types into.
 */
export const createCanvasEditor = (value: Value) =>
  createPlateEditor({ plugins: canvasEditorPlugins, value, nodeId: CANVAS_NODE_ID });

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
 * Comments are painted over the text (Highlight API), not plugins; Suggesting
 * mode (4.6) adds one leaf plugin, `canvasSuggestion`, which only draws the
 * marks of a review's value (`lib/suggestions.ts`) — no such value is ever
 * serialized, so it has no counterpart in `canvasBasePlugins`.
 */
import { createElement } from "react";
import { isHotkey, KEYS, type Value } from "platejs";
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
import { SUGGESTION_KEY, suggestionMark } from "./suggestions";

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
  const suggestion = suggestionMark(element);
  return ({ children }) =>
    createElement(CanvasBlockFrame, { index, id, type: element.type, suggestion, children });
};

/** Inserted / deleted words of a review (Suggesting mode); whole blocks are the frame's. */
const suggestionPlugin = createPlatePlugin({
  key: SUGGESTION_KEY,
  node: { isLeaf: true, component: CanvasSuggestionLeaf },
});

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
  suggestionPlugin,
  canvasMarkdownPlugin,
  canvasViewPlugin.configure({ render: { aboveNodes: canvasBlockFrame } }),
  canvasPastePlugin,
  // Last, so its Backspace / Delete rules run before the table and list ones.
  canvasDeletePlugin,
];

/** Node ids on every block: block selection finds blocks by id (they never reach the markdown). */
export const CANVAS_NODE_ID = true;

/**
 * A canvas editor outside React (the same plugins the view mounts): what the
 * tests drive, so a command is pinned on the editor the user types into.
 */
export const createCanvasEditor = (value: Value) =>
  createPlateEditor({ plugins: canvasEditorPlugins, value, nodeId: CANVAS_NODE_ID });

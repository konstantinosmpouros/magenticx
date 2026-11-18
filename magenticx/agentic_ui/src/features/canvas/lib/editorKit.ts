/**
 * The canvas editor's plugins: Plate's React plugins wired to the document
 * components in `shared/ui/plate`, plus find-in-document, the markdown
 * pipeline and the canvas view frame. It mirrors `canvasBasePlugins` in `markdown.ts` node for node — a type
 * in one list and not the other would parse but not render, or the reverse.
 *
 * Adapted from Plate's registry kits (`basic-blocks-kit`, `list-kit`,
 * `table-kit`, `link-kit`), without their AI, mention, emoji and date
 * coupling. Phase 4.1 renders documents read-only; the review plugins
 * (comments, suggestions) arrive with their phases (4.4, 4.6).
 */
import { createElement } from "react";
import { KEYS } from "platejs";
import { ParagraphPlugin, type RenderNodeWrapper } from "platejs/react";
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
  TableElement,
  TableRowElement,
} from "@/shared/ui/plate/table-node";

import { CanvasBlockFrame } from "../components/canvas_parts/CanvasBlockFrame";
import { canvasViewPlugin } from "./canvasView";
import { canvasMarkdownPlugin } from "./markdown";

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
  return ({ children }) => createElement(CanvasBlockFrame, { index, type: element.type, children });
};

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
  StrikethroughPlugin,
  CodePlugin.withComponent(CodeLeaf),
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
  TablePlugin.withComponent(TableElement),
  TableRowPlugin.withComponent(TableRowElement),
  TableCellPlugin.withComponent(TableCellElement),
  TableCellHeaderPlugin.withComponent(TableCellHeaderElement),
  findPlugin,
  canvasMarkdownPlugin,
  canvasViewPlugin.configure({ render: { aboveNodes: canvasBlockFrame } }),
];

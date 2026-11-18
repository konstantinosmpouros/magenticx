/**
 * Markdown <-> Plate value for the canvas (plan 44, Phase 4).
 *
 * A canvas document is stored as markdown; the editor works on a Plate value.
 * These two functions are the only bridge between them, and they run on a
 * headless Slate editor built from the *base* (non-React) plugins, so the same
 * code serves the editor and the tests now, and the save path in Phase 4.2
 * (`valueToMarkdown`, pinned by the round-trip test so a saved version diffs
 * cleanly against the agent's).
 *
 * Deliberately NOT enabled:
 * - `remark-mdx`: raw HTML/JSX in a document from the model must never become
 *   live nodes (plan 44 §9: "rendered without raw HTML"). Without it, an HTML
 *   block stays text.
 */
import { createSlateEditor, KEYS, type Value } from "platejs";
import {
  BaseBlockquotePlugin,
  BaseBoldPlugin,
  BaseCodePlugin,
  BaseH1Plugin,
  BaseH2Plugin,
  BaseH3Plugin,
  BaseH4Plugin,
  BaseHorizontalRulePlugin,
  BaseItalicPlugin,
  BaseStrikethroughPlugin,
} from "@platejs/basic-nodes";
import { BaseCodeBlockPlugin, BaseCodeLinePlugin } from "@platejs/code-block";
import { BaseImagePlugin } from "@platejs/media";
import { BaseIndentPlugin } from "@platejs/indent";
import { BaseListPlugin } from "@platejs/list";
import { BaseLinkPlugin } from "@platejs/link";
import {
  BaseTableCellHeaderPlugin,
  BaseTableCellPlugin,
  BaseTablePlugin,
  BaseTableRowPlugin,
} from "@platejs/table";
import { MarkdownPlugin } from "@platejs/markdown";
import remarkGfm from "remark-gfm";

/**
 * GFM without column padding: remark-gfm pads every table cell to the widest
 * one by default, which rewrites every row of a table on any one-cell edit and
 * makes version diffs noisy.
 */
function remarkGfmCompact(this: ThisParameterType<typeof remarkGfm>) {
  return remarkGfm.call(this, { tablePipeAlign: false });
}

/** The markdown plugin as the canvas configures it: GFM, no MDX. */
export const canvasMarkdownPlugin = MarkdownPlugin.configure({
  options: {
    remarkPlugins: [remarkGfmCompact],
    // The markers the agent writes (and the test fixture uses), so an untouched
    // document serializes back to the text it came from.
    remarkStringifyOptions: { bullet: "-", emphasis: "*", strong: "*", rule: "-" },
  },
});

/** Indent-based lists (Plate's default list model) need the indent plugin on the same blocks. */
const LIST_TARGETS = [...KEYS.heading, KEYS.p, KEYS.blockquote];

/**
 * The node types a canvas document may contain, as headless plugins. The React
 * editor (`editorKit.ts`) mirrors this list with components; keep them in step.
 */
const canvasBasePlugins = [
  BaseH1Plugin,
  BaseH2Plugin,
  BaseH3Plugin,
  BaseH4Plugin,
  BaseBlockquotePlugin,
  BaseHorizontalRulePlugin,
  BaseBoldPlugin,
  BaseItalicPlugin,
  BaseStrikethroughPlugin,
  BaseCodePlugin,
  BaseLinkPlugin,
  BaseCodeBlockPlugin,
  BaseCodeLinePlugin,
  BaseImagePlugin,
  BaseIndentPlugin.configure({ inject: { targetPlugins: LIST_TARGETS } }),
  BaseListPlugin.configure({ inject: { targetPlugins: LIST_TARGETS } }),
  BaseTablePlugin,
  BaseTableRowPlugin,
  BaseTableCellPlugin,
  BaseTableCellHeaderPlugin,
  canvasMarkdownPlugin,
];

/** A headless editor over the canvas node types. */
const headlessEditor = () => createSlateEditor({ plugins: canvasBasePlugins });

/** Parse a markdown document into a Plate value. */
export function markdownToValue(markdown: string): Value {
  const editor = headlessEditor();
  return editor.getApi(MarkdownPlugin).markdown.deserialize(markdown);
}

/** Serialize a Plate value back to markdown (comment and suggestion marks dropped to text). */
export function valueToMarkdown(value: Value): string {
  const editor = headlessEditor();
  return editor.getApi(MarkdownPlugin).markdown.serialize({ value });
}

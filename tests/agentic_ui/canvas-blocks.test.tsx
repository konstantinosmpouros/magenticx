// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Canvas block editing (plan 44, Phase 4.2, second pass): what the user
 * found missing in the real app.
 *
 * Pinned, on the editor the canvas mounts (`createCanvasEditor`): tables —
 * insert a picked size with the caret in it, insert / delete rows and
 * columns, delete the table, and Backspace in an emptied table removing it;
 * Backspace / Delete around rules, images and tables; deleting, turning into
 * and moving blocks picked by block selection; a toolbar mark landing on the
 * selection a phone tap collapsed; a paste from Word / the web reaching the
 * document as clean markdown. And, through the panel, that a structural edit
 * (a table from the picker, then deleted from the table toolbar) marks the
 * document unsaved, like typing.
 */

const { api } = vi.hoisted(() => ({
  api: {
    listConversationDocuments: vi.fn(),
    getLatestDocument: vi.fn(),
    listDocumentVersions: vi.fn(),
    getDocumentVersion: vi.fn(),
    saveDocumentVersion: vi.fn(),
    listDocumentComments: vi.fn(),
  },
}));
vi.mock("@/shared/lib/api", () => api);

import DocumentCanvas from "@/features/canvas/components/DocumentCanvas";
import {
  deleteBlocks,
  duplicateBlocks,
  insertCanvasTable,
  moveBlocks,
  selectBlocks,
  tableAction,
  turnInto,
} from "@/features/canvas/lib/blockCommands";
import { createCanvasEditor } from "@/features/canvas/lib/editorKit";
import { markdownToValue, valueToMarkdown } from "@/features/canvas/lib/markdown";
import { cleanPastedHtml } from "@/features/canvas/lib/pasteCleanup";
import { rememberSelection, restoreSelection } from "@/features/canvas/lib/selectionMemory";
import type { CanvasDocumentVersion } from "@/shared/lib/types";
import { TooltipProvider } from "@/shared/ui/tooltip";

const editorOf = (markdown: string) => createCanvasEditor(markdownToValue(markdown));
const md = (editor: ReturnType<typeof editorOf>) => valueToMarkdown(editor.children as never);
const at = (path: number[], offset = 0) => ({ path, offset });
// Plate's block keys: a bulleted list is its list style, "disc".
const KEYS = { ul: "disc", blockquote: "blockquote", code: "code_block" } as const;

const TABLE = "a\n\n| x | y |\n| - | - |\n| 1 | 2 |\n\nb\n";

describe("tables", () => {
  it("inserts the picked size in place of an empty line, caret in the first cell", () => {
    const editor = editorOf("intro\n");
    editor.tf.insertNodes({ type: "p", children: [{ text: "" }] }, { at: [1] });
    editor.tf.select(at([1, 0]));
    insertCanvasTable(editor, 2, 4);

    expect(editor.children.map((node) => node.type)).toEqual(["p", "table"]);
    const table = editor.children[1] as { children: Array<{ children: unknown[] }> };
    expect(table.children).toHaveLength(2);
    expect(table.children[0].children).toHaveLength(4);
    expect(editor.selection?.anchor.path.slice(0, 3)).toEqual([1, 0, 0]);
    // Empty cells are plain `|  |` cells, no zero-width spaces.
    expect(md(editor)).toBe("intro\n\n|  |  |  |  |\n| - | - | - | - |\n|  |  |  |  |\n");
  });

  it("inserts and deletes rows and columns at the caret, then the table", () => {
    const editor = editorOf(TABLE);
    editor.tf.select(at([1, 1, 0, 0, 0], 1)); // the "1" cell
    tableAction(editor, "rowBelow");
    tableAction(editor, "colRight");
    let table = editor.children[1] as { children: Array<{ children: unknown[] }> };
    expect(table.children).toHaveLength(3);
    expect(table.children[0].children).toHaveLength(3);
    // The caret stayed in its cell: deleting the row and column removes "1".
    tableAction(editor, "deleteRow");
    tableAction(editor, "deleteCol");
    expect(md(editor)).toBe("a\n\n|  | y |\n| - | - |\n|  |  |\n\nb\n");

    tableAction(editor, "deleteTable");
    expect(md(editor)).toBe("a\n\nb\n");
    expect(editor.selection?.anchor.path).toEqual([1, 0]);
    // Undo brings it back.
    editor.undo();
    expect(editor.children.some((node) => node.type === "table")).toBe(true);
  });

  it("removes an emptied table with Backspace, and never merges text into a cell", () => {
    const empty = editorOf("a\n");
    insertCanvasTable(empty, 2, 2);
    expect(empty.children.some((node) => node.type === "table")).toBe(true);
    empty.tf.deleteBackward("character");
    expect(md(empty)).toBe("a\n");

    const after = editorOf(TABLE);
    after.tf.select(at([2, 0]));
    after.tf.deleteBackward("character");
    expect(md(after)).toBe(TABLE); // "b" is not pulled into the "2" cell
    expect(after.selection?.anchor.path.slice(0, 2)).toEqual([1, 1]);
  });
});

describe("Backspace and Delete around blocks", () => {
  it("remove a rule or an image next to the caret", () => {
    const rule = editorOf("a\n\n---\n\nb\n");
    rule.tf.select(at([2, 0]));
    rule.tf.deleteBackward("character");
    expect(md(rule)).toBe("a\n\nb\n");

    const before = editorOf("a\n\n---\n\nb\n");
    before.tf.select(at([0, 0], 1));
    before.tf.deleteForward("character");
    expect(md(before)).toBe("a\n\nb\n");

    const image = editorOf("a\n\n![alt](https://example.org/i.png)\n\nb\n");
    image.tf.select(at([2, 0]));
    image.tf.deleteBackward("character");
    expect(md(image)).toBe("a\n\nb\n");
  });

  it("keeps one block when everything is deleted", () => {
    const editor = editorOf(TABLE);
    editor.tf.select([]);
    editor.tf.deleteFragment();
    expect(editor.children).toHaveLength(1);
    expect(md(editor)).toBe("\n");
  });

  it("exits a quote and a list with Enter on an empty line, and unlists at a list start", () => {
    const quote = editorOf("> q\n");
    quote.tf.select(at([0, 0, 0], 1));
    quote.tf.insertBreak();
    quote.tf.insertBreak();
    expect(quote.children.map((node) => node.type)).toEqual(["blockquote", "p"]);

    const list = editorOf("- one\n- two\n");
    list.tf.select(at([1, 0]));
    list.tf.deleteBackward("character");
    expect(md(list)).toBe("- one\n\ntwo\n");
  });
});

describe("block selection", () => {
  const DOC = "# T\n\none\n\ntwo\n\nthree\n\nfour\n";

  it("deletes the selected blocks, caret where they were", () => {
    const editor = editorOf(DOC);
    selectBlocks(editor, [1, 2, 3]);
    deleteBlocks(editor);
    expect(md(editor)).toBe("# T\n\nfour\n");
    expect(editor.selection?.anchor.path).toEqual([1, 0]);
    editor.undo();
    expect(md(editor)).toBe(DOC);
  });

  it("turns several blocks into a list, a quote, code — and back to text", () => {
    const editor = editorOf(DOC);
    selectBlocks(editor, [1, 3]);
    turnInto(editor, KEYS.ul);
    expect(md(editor)).toBe("# T\n\n- one\n\ntwo\n\n- three\n\nfour\n");

    const quote = editorOf(DOC);
    selectBlocks(quote, [1, 2]);
    turnInto(quote, KEYS.blockquote);
    expect(md(quote)).toBe("# T\n\n> one\n>\n> two\n\nthree\n\nfour\n");
    // The new quote is the selected block now; back to text it is two paragraphs.
    turnInto(quote, "p");
    expect(md(quote)).toBe(DOC);

    const code = editorOf(DOC);
    selectBlocks(code, [2, 3]);
    turnInto(code, KEYS.code);
    expect(md(code)).toBe("# T\n\none\n\n```\ntwo\nthree\n```\n\nfour\n");
  });

  it("applies a toolbar mark to every selected block", () => {
    const editor = editorOf(DOC);
    selectBlocks(editor, [1, 2]);
    editor.tf.toggleMark("bold");
    expect(md(editor)).toBe("# T\n\n**one**\n\n**two**\n\nthree\n\nfour\n");
  });

  it("duplicates and moves the selected blocks", () => {
    const editor = editorOf(DOC);
    selectBlocks(editor, [2]);
    duplicateBlocks(editor);
    expect(md(editor)).toBe("# T\n\none\n\ntwo\n\ntwo\n\nthree\n\nfour\n");

    const moved = editorOf(DOC);
    selectBlocks(moved, [2, 3]);
    moveBlocks(moved, "up");
    expect(md(moved)).toBe("# T\n\ntwo\n\nthree\n\none\n\nfour\n");
    moveBlocks(moved, "down");
    expect(md(moved)).toBe(DOC);
  });
});

describe("toolbar selection on a phone", () => {
  it("puts back the selection a tap collapsed, so Bold lands on the word", () => {
    const editor = editorOf("This brief describes how.\n");
    editor.tf.select({ anchor: at([0, 0], 11), focus: at([0, 0], 20) }); // "describes"
    rememberSelection(editor); // pointerdown on Bold
    editor.tf.select(at([0, 0], 20)); // the browser collapses it
    restoreSelection(editor); // the click
    editor.tf.toggleMark("bold");
    expect(md(editor)).toBe("This brief **describes** how.\n");
  });

  it("does not undo a newer selection the user made", () => {
    const editor = editorOf("one two three\n");
    editor.tf.select({ anchor: at([0, 0], 0), focus: at([0, 0], 3) });
    rememberSelection(editor);
    editor.tf.select({ anchor: at([0, 0], 8), focus: at([0, 0], 13) });
    restoreSelection(editor);
    expect(editor.selection).toEqual({ anchor: at([0, 0], 8), focus: at([0, 0], 13) });
  });
});

describe("paste", () => {
  it("cleans Word and web HTML: no scripts, real lists, web images only", () => {
    const word = `<p class=MsoListParagraphCxSpFirst style='mso-list:l0 level1 lfo1'><![if !supportLists]><span style='mso-list:Ignore'>1.<span>&nbsp;</span></span><![endif]>First<o:p></o:p></p><p class=MsoListParagraphCxSpLast style='mso-list:l0 level1 lfo1'><span style='mso-list:Ignore'>2.<span>&nbsp;</span></span>Second</p><script>alert(1)</script><style>p{}</style><p>x<img src="file:///C:/a.png"><img src="https://example.org/b.png"></p>`;
    const html = cleanPastedHtml(word);
    expect(html).not.toMatch(/script|style|alert|file:|mso-list:Ignore/i);
    expect(html).toMatch(/^<ol><li>First<\/li><li>Second<\/li><\/ol>/);
    expect(html).toContain('src="https://example.org/b.png"');
  });

  it("pastes into the document as markdown", () => {
    const editor = editorOf("start\n");
    editor.tf.select(at([0, 0], 5));
    const html = `<p><b>Bold</b> and <a href="javascript:alert(1)">bad</a> <a href="https://ok.org">good</a></p><ul><li>a</li></ul><iframe title="evil"></iframe>`;
    editor.tf.insertData({
      types: ["text/html", "text/plain"],
      files: [],
      items: [],
      getData: (format: string) =>
        format === "text/html" ? html : format === "text/plain" ? "plain" : "",
    } as unknown as DataTransfer);
    const out = md(editor);
    expect(out).toContain("**Bold**");
    expect(out).toContain("[good](https://ok.org)");
    expect(out).not.toMatch(/javascript:|<iframe|evil/);
    expect(out).toContain("- a");
  });
});

describe("markdown spelling", () => {
  it("drops a trailing space left by Enter, but not inside code", () => {
    const editor = editorOf("one two\n\n```\nx \n```\n");
    editor.tf.select(at([0, 0], 4)); // after "one "
    editor.tf.insertBreak();
    expect(md(editor)).toBe("one\n\ntwo\n\n```\nx \n```\n");
  });
});

// ── Through the panel: a structural edit is an edit ─────────────────────────

const PATH = "/conversation/output/brief.md";
const latest = (): CanvasDocumentVersion => ({
  path: PATH,
  name: "brief.md",
  version: 2,
  author: "agent",
  baseVersion: 1,
  createdAt: "2026-11-18T09:40:00Z",
  sizeBytes: 40,
  content: "# The brief\n\nIntro text.\n",
});

describe("structural edits mark the document unsaved, like typing", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    api.listDocumentComments.mockResolvedValue([]);
    api.listConversationDocuments.mockResolvedValue([]);
    api.listDocumentVersions.mockResolvedValue([]);
    api.getLatestDocument.mockResolvedValue(latest());
    let next = 3;
    api.saveDocumentVersion.mockImplementation(async () => ({
      kind: "saved",
      version: next++,
      createdAt: "2026-11-18T10:00:00Z",
    }));
  });

  it("a table from the picker, then deleted from the table toolbar, is unsaved until the user saves", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <DocumentCanvas
            userId="user-1"
            conversationId="conv-1"
            path={PATH}
            revision="0"
            compact={false}
            canToggleFullscreen
            fullscreen={false}
            onPreviewFile={null}
            onSelectPath={vi.fn()}
            onClose={vi.fn()}
            onToggleFullscreen={vi.fn()}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    await screen.findByRole("heading", { level: 1, name: "The brief" });

    const trigger = screen.getByRole("button", { name: "Table" });
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("button", { name: "Insert a table, 2 by 3" }));

    expect(await screen.findByText("Unsaved changes")).toBeInTheDocument();
    // Nothing is sent until the user saves; the Save button shows only now.
    expect(api.saveDocumentVersion).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^Save \(/ }));
    await waitFor(() => expect(api.saveDocumentVersion).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /^Save \(/ })).not.toBeInTheDocument(),
    );
    const first = api.saveDocumentVersion.mock.calls[0][2] as {
      content: string;
      baseVersion: number;
    };
    expect(first.baseVersion).toBe(2);
    expect(first.content).toContain("|  |  |  |\n| - | - | - |");

    fireEvent.click(await screen.findByRole("button", { name: "Delete table" }));
    expect(await screen.findByText("Unsaved changes")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() => expect(api.saveDocumentVersion).toHaveBeenCalledTimes(2));
    const second = api.saveDocumentVersion.mock.calls[1][2] as {
      content: string;
      baseVersion: number;
    };
    expect(second.baseVersion).toBe(3);
    expect(second.content).not.toContain("|");
  }, 15000);

  it("closing with unsaved edits asks first: Cancel stays, Discard closes without saving", async () => {
    const onClose = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <DocumentCanvas
            userId="user-1"
            conversationId="conv-1"
            path={PATH}
            revision="0"
            compact={false}
            canToggleFullscreen
            fullscreen={false}
            onPreviewFile={null}
            onSelectPath={vi.fn()}
            onClose={onClose}
            onToggleFullscreen={vi.fn()}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    await screen.findByRole("heading", { level: 1, name: "The brief" });

    // Closing with nothing unsaved asks nothing.
    fireEvent.click(screen.getByRole("button", { name: "Close document" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Save your changes?")).not.toBeInTheDocument();

    const trigger = screen.getByRole("button", { name: "Table" });
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("button", { name: "Insert a table, 2 by 3" }));
    expect(await screen.findByText("Unsaved changes")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close document" }));
    expect(await screen.findByText("Save your changes?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Save your changes?")).not.toBeInTheDocument());
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Close document" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(api.saveDocumentVersion).not.toHaveBeenCalled();
  }, 15000);
});

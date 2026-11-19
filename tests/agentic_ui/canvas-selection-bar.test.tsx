// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NodeApi, type TElement } from "platejs";
import { Plate, PlateContent } from "platejs/react";
import { useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The selection bar, the pill and the orb at the caret (plan 44 §3, the
 * Claude Docs comparison).
 *
 * Pinned on a real canvas editor (Plate, the canvas plugins) with a real
 * Slate selection: the bar is icon-only (every button named, no text label);
 * its Bold, text style, list and link apply to the selection and show their
 * active state; Comment opens the composer; Ask agent opens the panel with the
 * presets inside it (none in the bar itself); while reading the bar is
 * Comment alone. The pill: block tools only with a mouse (no marks), the
 * marks and link on touch while text is selected, the ⋯ menu's lists, code
 * block and block actions, and Ask agent on the caret's whole block. The orb: which block a caret offers (none for a selection,
 * selected blocks or an empty line), the block's passage, and through the
 * component — it shows after the idle wait with a caret, hides on typing and
 * on a selection, and its click asks about the whole block, the request built
 * like a selection's (`buildCanvasEdit`).
 *
 * happy-dom lays nothing out: floating-ui's `hide` reports the selection off
 * screen, so the bar is `visibility: hidden` (no accessible names) — its
 * buttons are found by their labels. The caret's line has no box either, so the orb's measuring
 * is pinned to a fixed spot.
 */

const { lineCenter, coarse } = vi.hoisted(() => ({
  lineCenter: { current: 12 as number | null },
  coarse: { current: false },
}));
vi.mock("@/features/canvas/hooks/useCoarsePointer", () => ({
  useCoarsePointer: () => coarse.current,
}));
vi.mock("@/features/canvas/lib/caretOrb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/canvas/lib/caretOrb")>();
  return { ...actual, caretLineCenter: () => lineCenter.current };
});

import { CanvasCaretOrb } from "@/features/canvas/components/canvas_parts/CanvasCaretOrb";
import { CanvasSelectionMenu } from "@/features/canvas/components/canvas_parts/CanvasSelectionMenu";
import { CanvasToolbar } from "@/features/canvas/components/canvas_parts/CanvasToolbar";
import {
  blockPassage,
  buildCanvasEdit,
  caretBlockIndex,
  caretPassage,
} from "@/features/canvas/lib/askAgent";
import { selectBlocks } from "@/features/canvas/lib/blockCommands";
import { createCanvasEditor } from "@/features/canvas/lib/editorKit";
import { markdownToValue } from "@/features/canvas/lib/markdown";
import type { CanvasAskControl, CanvasCommentControl } from "@/shared/lib/types";
import { TooltipProvider } from "@/shared/ui/tooltip";

const DOC = ["# The brief", "", "Intro text here.", "", "## Scope", "", "Ship it soon.", ""].join(
  "\n",
);
const at = (path: number[], offset = 0) => ({ path, offset });

type Editor = ReturnType<typeof createCanvasEditor>;

function makeAsk(): CanvasAskControl {
  return { onAsk: vi.fn(), disabledReason: null };
}
function makeComment(): CanvasCommentControl {
  return { onCreate: vi.fn() } as unknown as CanvasCommentControl;
}

function Doc({
  editor,
  readOnly = false,
  ask,
  comment,
  orb = false,
  pill = false,
}: {
  editor: Editor;
  readOnly?: boolean;
  ask: CanvasAskControl | null;
  comment: CanvasCommentControl | null;
  orb?: boolean;
  pill?: boolean;
}) {
  const column = useRef<HTMLDivElement>(null);
  return (
    <TooltipProvider>
      <Plate editor={editor} readOnly={readOnly}>
        <div ref={column} className="relative">
          <PlateContent aria-label="doc" />
          {orb && ask ? <CanvasCaretOrb ask={ask} columnRef={column} /> : null}
        </div>
        <CanvasSelectionMenu ask={readOnly ? null : ask} comment={comment} />
        {pill ? <CanvasToolbar ask={ask} comment={comment} /> : null}
      </Plate>
    </TooltipProvider>
  );
}

const bar = () => {
  const found = document.querySelector<HTMLElement>("[data-canvas-selection-menu]");
  if (!found) throw new Error("no selection bar");
  return found;
};
/** A bar button by its label or text (its accessible name is empty while the bar is hidden). */
function barButton(name: string): HTMLElement {
  const found = [...bar().querySelectorAll<HTMLElement>("button")].find(
    (button) => (button.getAttribute("aria-label") ?? button.textContent?.trim()) === name,
  );
  if (!found) throw new Error(`no "${name}" in the bar`);
  return found;
}

/** Press a bar control the way a mouse does (pointerdown remembers the selection). */
function press(button: HTMLElement) {
  fireEvent.pointerDown(button, { button: 0, pointerType: "mouse" });
  fireEvent.mouseDown(button);
  fireEvent.click(button);
}

/** Open a bar menu (Radix opens a menu trigger from the keyboard too). */
function openMenu(button: HTMLElement) {
  fireEvent.keyDown(button, { key: "Enter" });
}

describe("the selection bar", () => {
  let editor: Editor;
  let ask: CanvasAskControl;
  let comment: CanvasCommentControl;

  beforeEach(() => {
    editor = createCanvasEditor(markdownToValue(DOC));
    ask = makeAsk();
    comment = makeComment();
    coarse.current = false;
  });

  const selectIntro = () =>
    act(() => editor.tf.select({ anchor: at([1, 0]), focus: at([1, 0], 5) }));

  it("shows Comment, Ask agent, text style, the four marks, lists and link — and no presets", async () => {
    render(<Doc editor={editor} ask={ask} comment={comment} />);
    selectIntro();
    await waitFor(() => bar());
    const names = within(bar())
      .getAllByRole("button", { hidden: true })
      .map((button) => button.getAttribute("aria-label") ?? button.textContent?.trim());
    expect(names).toEqual([
      "Comment",
      "Ask agent",
      "Text style: Text",
      "Bold",
      "Italic",
      "Strikethrough",
      "Code",
      "List",
      "Link",
    ]);
    // Markdown keeps neither: never offered.
    expect(
      within(bar()).queryByRole("button", { name: /underline|colou?r/i, hidden: true }),
    ).toBeNull();
    expect(within(bar()).queryByText("Shorter")).toBeNull();
    // Icon-only: no button carries a text label (the names are aria-labels).
    for (const button of within(bar()).getAllByRole("button", { hidden: true })) {
      expect(button.textContent?.trim()).toBe("");
    }
  });

  it("Bold marks the selected text and keeps the selection", async () => {
    render(<Doc editor={editor} ask={ask} comment={comment} />);
    selectIntro();
    press(await waitFor(() => barButton("Bold")));
    const leaf = (editor.children[1] as TElement).children[0] as { text: string; bold?: boolean };
    expect(leaf).toMatchObject({ text: "Intro", bold: true });
    expect(editor.selection).toMatchObject({ anchor: at([1, 0]), focus: at([1, 0], 5) });
    await waitFor(() => expect(barButton("Bold")).toHaveAttribute("aria-pressed", "true"));
  });

  it("the text style menu turns the block into a heading", async () => {
    render(<Doc editor={editor} ask={ask} comment={comment} />);
    selectIntro();
    expect(await waitFor(() => barButton("Text style: Text"))).not.toHaveAttribute("data-active");
    openMenu(barButton("Text style: Text"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Heading" }));
    expect((editor.children[1] as TElement).type).toBe("h2");
    expect(NodeApi.string(editor.children[1])).toBe("Intro text here.");
    // The trigger names the style and is tinted while it is a heading.
    await waitFor(() => expect(barButton("Text style: Heading")).toHaveAttribute("data-active"));
  });

  it("the list menu makes the block a bulleted list, and the trigger then says so", async () => {
    render(<Doc editor={editor} ask={ask} comment={comment} />);
    selectIntro();
    openMenu(await waitFor(() => barButton("List")));
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "Bulleted list",
      "Numbered list",
      "Checklist",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Bulleted list" }));
    expect((editor.children[1] as TElement).listStyleType).toBe("disc");
    await waitFor(() => expect(barButton("List: Bulleted list")).toHaveAttribute("data-active"));
  });

  it("Link links the selected text (web addresses only)", async () => {
    render(<Doc editor={editor} ask={ask} comment={comment} />);
    selectIntro();
    press(await waitFor(() => barButton("Link")));
    const input = await screen.findByLabelText("Link address");
    fireEvent.change(input, { target: { value: "example.com" } });
    fireEvent.submit(input.closest("form")!);
    const link = (editor.children[1] as TElement).children.find(
      (node) => (node as TElement).type === "a",
    ) as TElement | undefined;
    expect(link).toMatchObject({ url: "https://example.com/" });
    expect(NodeApi.string(link!)).toBe("Intro");
  });

  it("Comment opens the composer in the bar", async () => {
    render(<Doc editor={editor} ask={ask} comment={comment} />);
    selectIntro();
    press(await waitFor(() => barButton("Comment")));
    expect(await within(bar()).findByPlaceholderText("Add a comment…")).toBeInTheDocument();
  });

  it("Ask agent opens the panel with the presets inside; a preset asks about the selection", async () => {
    render(<Doc editor={editor} ask={ask} comment={comment} />);
    selectIntro();
    press(await waitFor(() => barButton("Ask agent")));
    expect(
      await within(bar()).findByPlaceholderText("Ask the agent to change this…"),
    ).toBeInTheDocument();
    const presets = bar().querySelector<HTMLElement>('[aria-label="Quick changes"]')!;
    expect([...presets.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Shorter",
      "Longer",
      "Formal",
      "Simpler",
      "Polish",
    ]);
    press(within(presets).getByText("Formal"));
    expect(ask.onAsk).toHaveBeenCalledWith({
      passage: expect.objectContaining({ text: "Intro", headingPath: ["The brief"] }),
      instruction: "Make it more formal",
      preset: "formal",
    });
  });

  it("while reading, the bar is Comment alone", async () => {
    render(<Doc editor={editor} readOnly ask={ask} comment={comment} />);
    selectIntro();
    await waitFor(() => bar());
    const names = within(bar())
      .getAllByRole("button", { hidden: true })
      .map((button) => button.getAttribute("aria-label"));
    expect(names).toEqual(["Comment"]);
  });
});

describe("the pill at the bottom", () => {
  let editor: Editor;
  let ask: CanvasAskControl;
  let comment: CanvasCommentControl;

  beforeEach(() => {
    editor = createCanvasEditor(markdownToValue(DOC));
    ask = makeAsk();
    comment = makeComment();
    coarse.current = false;
  });

  const pill = () => screen.getByRole("toolbar", { name: "Formatting" });
  const pillNames = () =>
    within(pill())
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"));

  it("with a mouse: block tools only, icon-only, and a filled Ask agent at the end", () => {
    render(<Doc editor={editor} ask={ask} comment={comment} pill />);
    expect(pillNames()).toEqual([
      "Text style: Text",
      "Table",
      "Checklist",
      "Quote",
      "More",
      "Comment",
      "Ask agent",
    ]);
    // The marks and link live in the selection bar (their shortcuts still work).
    for (const name of ["Bold", "Italic", "Strikethrough", "Code", "Link"]) {
      expect(within(pill()).queryByRole("button", { name })).toBeNull();
    }
    // Ask agent is the one button with a text label.
    expect(within(pill()).getByRole("button", { name: "Ask agent" })).toHaveTextContent(
      "Ask agent",
    );
  });

  it("on touch, with text selected, the marks and link take the block tools' place", async () => {
    coarse.current = true;
    render(<Doc editor={editor} ask={ask} comment={comment} pill />);
    expect(pillNames()).not.toContain("Bold");
    await act(async () => editor.tf.select({ anchor: at([1, 0]), focus: at([1, 0], 5) }));
    await waitFor(() =>
      expect(pillNames()).toEqual([
        "Text style: Text",
        "Bold",
        "Italic",
        "Strikethrough",
        "Code",
        "Link",
        "More",
        "Comment",
        "Ask agent",
      ]),
    );
    const bold = within(pill()).getByRole("button", { name: "Bold" });
    fireEvent.pointerDown(bold, { button: 0, pointerType: "touch" });
    fireEvent.click(bold);
    const leaf = (editor.children[1] as TElement).children[0] as { text: string; bold?: boolean };
    expect(leaf).toMatchObject({ text: "Intro", bold: true });
    await waitFor(() =>
      expect(within(pill()).getByRole("button", { name: "Bold" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
  });

  it("the ⋯ menu holds the lists, the code block and the block actions", async () => {
    render(<Doc editor={editor} ask={ask} comment={comment} pill />);
    await act(async () => editor.tf.select(at([1, 0], 3)));
    fireEvent.keyDown(within(pill()).getByRole("button", { name: "More" }), { key: "Enter" });
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      "Bulleted list",
      "Numbered list",
      "Code block",
      "Duplicate",
      "Move up",
      "Move down",
      "Turn into",
      "Delete block",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Numbered list" }));
    expect((editor.children[1] as TElement).listStyleType).toBe("decimal");
  });

  it("Ask agent with only a caret asks about the caret's whole block", async () => {
    render(<Doc editor={editor} ask={ask} comment={comment} pill />);
    await act(async () => editor.tf.select(at([3, 0], 4)));
    const trigger = within(pill()).getByRole("button", { name: "Ask agent" });
    await waitFor(() => expect(trigger).not.toHaveAttribute("aria-disabled"));
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    fireEvent.click(trigger);
    expect(await screen.findByText("Ask about this paragraph")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Polish" }));
    await waitFor(() => expect(ask.onAsk).toHaveBeenCalledTimes(1));
    expect(ask.onAsk).toHaveBeenCalledWith({
      passage: expect.objectContaining({
        text: "Ship it soon.",
        headingPath: ["The brief", "Scope"],
      }),
      instruction: "Polish the wording",
      preset: "polish",
    });
  });

  it("Ask agent with nothing to act on stays focusable and says why", async () => {
    render(<Doc editor={editor} ask={ask} comment={comment} pill />);
    const trigger = within(pill()).getByRole("button", { name: "Ask agent" });
    expect(trigger).toHaveAttribute("aria-disabled", "true");
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    fireEvent.click(trigger);
    expect(
      await screen.findByText("Select some text, or put the caret in a paragraph"),
    ).toBeInTheDocument();
    expect(ask.onAsk).not.toHaveBeenCalled();
  });

  it("the caret's passage: its whole block, none with a selection", () => {
    editor.tf.select(at([3, 0], 2));
    expect(caretPassage(editor)).toMatchObject({ text: "Ship it soon." });
    editor.tf.select({ anchor: at([3, 0]), focus: at([3, 0], 4) });
    expect(caretPassage(editor)).toBeNull();
  });
});

describe("the orb at the caret", () => {
  it("offers the caret's block, never a selection, selected blocks or an empty line", () => {
    const editor = createCanvasEditor(markdownToValue(`${DOC}\n\n`));
    editor.tf.select(at([1, 0], 3));
    expect(caretBlockIndex(editor)).toBe(1);
    editor.tf.select({ anchor: at([1, 0]), focus: at([1, 0], 4) });
    expect(caretBlockIndex(editor)).toBeNull();
    editor.tf.select(at([1, 0], 3));
    selectBlocks(editor, [1]);
    expect(caretBlockIndex(editor)).toBeNull();

    const empty = createCanvasEditor([
      { type: "p", children: [{ text: "Text" }] },
      { type: "p", children: [{ text: "" }] },
    ]);
    empty.tf.select(at([1, 0]));
    expect(caretBlockIndex(empty)).toBeNull();
  });

  it("the block's passage is its whole text under its headings", () => {
    const editor = createCanvasEditor(markdownToValue(DOC));
    expect(blockPassage(editor, 3)).toMatchObject({
      text: "Ship it soon.",
      headingPath: ["The brief", "Scope"],
    });
    expect(blockPassage(editor, 99)).toBeNull();
  });

  it("appears after the caret rests, hides while typing and on a selection; its click asks about the block", async () => {
    lineCenter.current = 12;
    const editor = createCanvasEditor(markdownToValue(DOC));
    const ask = makeAsk();
    render(<Doc editor={editor} ask={ask} comment={null} orb />);
    const orb = () => document.querySelector<HTMLElement>("[data-canvas-caret-orb]");

    await act(async () => {
      editor.tf.select(at([3, 0], 4));
      editor.tf.focus();
    });
    expect(orb()).toBeNull(); // not before the idle wait
    await waitFor(() => expect(orb()).not.toBeNull(), { timeout: 2000 });
    expect(orb()).toHaveAttribute("aria-label", "Ask agent");
    expect(orb()!.style.top).toBe("12px");

    // Typing hides it at once.
    await act(async () => editor.tf.insertText("x"));
    expect(orb()).toBeNull();
    await waitFor(() => expect(orb()).not.toBeNull(), { timeout: 2000 });

    // A selection hides it (and keeps it hidden).
    await act(async () => editor.tf.select({ anchor: at([3, 0]), focus: at([3, 0], 4) }));
    expect(orb()).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(orb()).toBeNull();

    // Back to a caret: it returns; a click opens Ask agent for the whole block.
    await act(async () => editor.tf.select(at([3, 0], 2)));
    await waitFor(() => expect(orb()).not.toBeNull(), { timeout: 2000 });
    fireEvent.pointerDown(orb()!, { button: 0, pointerType: "mouse" });
    fireEvent.click(orb()!);
    expect(await screen.findByText("Ask about this paragraph")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Shorter" }));
    await waitFor(() => expect(ask.onAsk).toHaveBeenCalledTimes(1));
    const draft = (ask.onAsk as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(buildCanvasEdit({ path: "/conversation/output/brief.md", version: 2, draft })).toEqual({
      path: "/conversation/output/brief.md",
      version: 2,
      selection: "Shipx it soon.",
      headingPath: ["The brief", "Scope"],
      instruction: "Make it shorter",
      preset: "shorter",
    });
  }, 15000);
});

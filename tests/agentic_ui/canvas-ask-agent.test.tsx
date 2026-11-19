// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Ask agent on a selection in the canvas (plan 44, Phase 4.3).
 *
 * Pinned, on the editor the canvas mounts: the passage a selection makes
 * (its text across blocks, the headings above it, outermost first, block
 * selection too), the request built from it (path, the saved version,
 * instruction, preset) and the 8 000-character cap; the presets' labels and
 * instructions. Through the panel: a preset sends a request on the latest
 * version; unsaved edits ask Save and send / Cancel and send only after the
 * save landed, on the new version; Ask agent waits while a reply streams;
 * the editor is read-only (and says so) while the agent's run goes, and
 * reloads the agent's version before it unlocks. And the wire: the schema
 * and the message whitelist keep `canvasEdit`, the send payload carries it,
 * and the user bubble's chip opens the document.
 *
 * The panel tests hold the selection fixed (`selectedPassage` mocked): a
 * DOM selection does not reach Slate in happy-dom. The passage itself is
 * pinned on a real editor above.
 */

const { api, passage, coarse, orbSpot } = vi.hoisted(() => ({
  api: {
    listConversationDocuments: vi.fn(),
    getLatestDocument: vi.fn(),
    // The pending suggestion set (Phase 4.6): none.
    getDocumentSuggestion: vi.fn(async () => null),
    putDocumentSuggestion: vi.fn(),
    deleteDocumentSuggestion: vi.fn(async () => undefined),
    listDocumentVersions: vi.fn(),
    getDocumentVersion: vi.fn(),
    saveDocumentVersion: vi.fn(),
    listDocumentComments: vi.fn(),
  },
  passage: { current: null as null | Record<string, unknown> },
  // The panel tests drive the pill's Ask agent as a phone (no caret orb).
  coarse: { current: true },
  // The orb at the caret's spot (its idle wait and measuring are pinned in
  // canvas-selection-bar.test.tsx); null: no orb.
  orbSpot: { current: null as null | { index: number; top: number } },
}));
vi.mock("@/shared/lib/api", () => api);
vi.mock("@/features/canvas/hooks/useCoarsePointer", () => ({
  useCoarsePointer: () => coarse.current,
}));
vi.mock("@/features/canvas/hooks/useCaretOrb", () => ({
  CARET_ORB_IDLE_MS: 400,
  useCaretOrb: () => orbSpot.current,
}));
vi.mock("@/features/canvas/lib/askAgent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/canvas/lib/askAgent")>();
  return {
    ...actual,
    // `real` is the unmocked one, for the tests on a real editor.
    real: actual.selectedPassage,
    selectedPassage: (editor: Parameters<typeof actual.selectedPassage>[0]) =>
      passage.current ?? actual.selectedPassage(editor),
  };
});

import DocumentCanvas from "@/features/canvas/components/DocumentCanvas";
import * as askAgent from "@/features/canvas/lib/askAgent";
import { selectBlocks } from "@/features/canvas/lib/blockCommands";
import { createCanvasEditor } from "@/features/canvas/lib/editorKit";
import { markdownToValue } from "@/features/canvas/lib/markdown";
import { CanvasEditChip } from "@/features/chat/components/message_parts/CanvasEditChip";
import { CanvasOpenerContext } from "@/features/chat/lib/canvasOpener";
import { buildUserMessage } from "@/features/inference/messagePayload";
import { transformMessage } from "@/shared/lib/consts";
import { toCanvasEdit } from "@/shared/lib/schemas";
import type { CanvasAskPassage, CanvasDocumentVersion, CanvasEditRef } from "@/shared/lib/types";
import { TooltipProvider } from "@/shared/ui/tooltip";

const { buildCanvasEdit, CANVAS_ASK_PRESETS, headingPathAt, passageProblem } = askAgent;
const realSelectedPassage = (askAgent as unknown as { real: typeof askAgent.selectedPassage }).real;

const PATH = "/conversation/output/brief.md";
const DOC = [
  "# The brief",
  "",
  "Intro text.",
  "",
  "## 2. Scope",
  "",
  "### Out of scope",
  "",
  "Comments come **later** in the year.",
  "",
  "Export is last.",
  "",
  "## 3. Next",
  "",
  "Ship it.",
  "",
].join("\n");

const at = (path: number[], offset = 0) => ({ path, offset });

describe("the passage and the request", () => {
  it("takes the selected text and the headings above it, outermost first", () => {
    const editor = createCanvasEditor(markdownToValue(DOC));
    // "Comments come later" … "Export" — across two paragraphs, through a bold mark.
    const comments = editor.children.findIndex((node) =>
      JSON.stringify(node).includes("Comments come"),
    );
    editor.tf.select({ anchor: at([comments, 0], 0), focus: at([comments + 1, 0], 6) });
    const picked = realSelectedPassage(editor)!;
    expect(picked.text).toBe("Comments come later in the year.\n\nExport");
    expect(picked.headingPath).toEqual(["The brief", "2. Scope", "Out of scope"]);

    // A heading closes the ones of its level and deeper.
    const ship = editor.children.length - 1;
    expect(headingPathAt(editor, ship)).toEqual(["The brief", "3. Next"]);
    expect(headingPathAt(editor, 0)).toEqual([]);
  });

  it("selected blocks are the passage too; a caret is none", () => {
    const editor = createCanvasEditor(markdownToValue(DOC));
    editor.tf.select(at([1, 0], 3));
    expect(realSelectedPassage(editor)).toBeNull();
    selectBlocks(editor, [1]);
    expect(realSelectedPassage(editor)?.text).toBe("Intro text.");
    expect(realSelectedPassage(editor)?.headingPath).toEqual(["The brief"]);
  });

  it("builds the request on the saved version, with the preset and a trimmed instruction", () => {
    const picked: CanvasAskPassage = {
      text: "Intro text.",
      headingPath: ["The brief"],
      range: { anchor: at([1, 0]), focus: at([1, 0], 11) },
    };
    expect(
      buildCanvasEdit({
        path: PATH,
        version: 4,
        draft: { passage: picked, instruction: "  Make it shorter ", preset: "shorter" },
      }),
    ).toEqual({
      path: PATH,
      version: 4,
      selection: "Intro text.",
      headingPath: ["The brief"],
      instruction: "Make it shorter",
      preset: "shorter",
    });
    // A typed instruction has no preset key at all.
    expect(
      buildCanvasEdit({ path: PATH, version: 4, draft: { passage: picked, instruction: "Fix" } }),
    ).not.toHaveProperty("preset");
  });

  it("strips NUL characters, which the bridge refuses", () => {
    const edit = buildCanvasEdit({
      path: PATH,
      version: 1,
      draft: {
        passage: {
          text: "a\u0000b",
          headingPath: ["\u0000", "H\u0000"],
          range: { anchor: at([0, 0]), focus: at([0, 0], 1) },
        },
        instruction: "Fix\u0000 it",
      },
    });
    expect(edit).toMatchObject({ selection: "ab", headingPath: ["H"], instruction: "Fix it" });
  });

  it("refuses more than 8 000 characters, and nothing selected", () => {
    const range = { anchor: at([0, 0]), focus: at([0, 0], 1) };
    expect(passageProblem({ text: "x".repeat(8000), headingPath: [], range })).toBeNull();
    expect(passageProblem({ text: "x".repeat(8001), headingPath: [], range })).toMatch(
      /Select less/,
    );
    expect(passageProblem(null)).toBe("Select some text first");
  });

  it("offers the five presets, each with its instruction", () => {
    expect(CANVAS_ASK_PRESETS.map((item) => [item.preset, item.label, item.instruction])).toEqual([
      ["shorter", "Shorter", "Make it shorter"],
      ["longer", "Longer", "Make it longer"],
      ["formal", "Formal", "Make it more formal"],
      ["simpler", "Simpler", "Make it simpler"],
      ["polish", "Polish", "Polish the wording"],
    ]);
  });
});

describe("the wire", () => {
  const edit: CanvasEditRef = {
    path: PATH,
    version: 4,
    selection: "Intro text.",
    headingPath: ["The brief"],
    instruction: "Make it shorter",
    preset: "shorter",
  };

  it("the schema keeps a well-formed request and drops junk", () => {
    expect(toCanvasEdit(edit)).toEqual(edit);
    expect(toCanvasEdit({ ...edit, heading_path: ["A"], headingPath: undefined })).toMatchObject({
      headingPath: ["A"],
    });
    expect(toCanvasEdit({ ...edit, path: "/conversation/output/../x.md" })).toBeNull();
    expect(toCanvasEdit({ ...edit, path: "/etc/passwd" })).toBeNull();
    expect(toCanvasEdit({ ...edit, version: 0 })).toBeNull();
    expect(toCanvasEdit({ ...edit, selection: "" })).toBeNull();
    expect(toCanvasEdit({ ...edit, selection: "x".repeat(8001) })).toBeNull();
    expect(toCanvasEdit({ ...edit, instruction: "" })).toBeNull();
    expect(toCanvasEdit("nope")).toBeNull();
    // An unknown preset is dropped, the request kept; headings capped at six × 200.
    const loose = toCanvasEdit({
      ...edit,
      preset: "louder",
      headingPath: ["h".repeat(300), 1, "", "b", "c", "d", "e", "f", "g"],
    })!;
    expect(loose).not.toHaveProperty("preset");
    expect(loose.headingPath).toHaveLength(6);
    expect(loose.headingPath[0]).toHaveLength(200);
  });

  it("the message whitelist keeps canvasEdit on a user message, in either casing", () => {
    expect(transformMessage({ id: "m1", sender: "user", canvasEdit: edit }).canvasEdit).toEqual(
      edit,
    );
    expect(transformMessage({ id: "m1", sender: "user", canvas_edit: edit }).canvasEdit).toEqual(
      edit,
    );
    expect(transformMessage({ id: "m2", sender: "ai", canvasEdit: edit }).canvasEdit).toBeNull();
    expect(transformMessage({ id: "m3", sender: "user" }).canvasEdit).toBeNull();
  });

  it("the send payload carries it, and leaves it out when absent", () => {
    expect(
      buildUserMessage({ parentMessageId: "p", content: "Make it shorter", canvasEdit: edit }),
    ).toEqual({
      sender: "user",
      parentMessageId: "p",
      content: "Make it shorter",
      canvasEdit: edit,
    });
    expect(buildUserMessage({ parentMessageId: "p", content: "hi" })).not.toHaveProperty(
      "canvasEdit",
    );
  });

  it("the bubble's chip names the document and the passage, and opens it", () => {
    const open = vi.fn();
    const long = {
      ...edit,
      selection: "A passage that runs on well past the sixty characters a chip shows.",
    };
    const { unmount } = render(
      <CanvasOpenerContext.Provider value={open}>
        <CanvasEditChip edit={long} />
      </CanvasOpenerContext.Provider>,
    );
    const chip = screen.getByRole("button", { name: /^Open brief in the canvas/ });
    expect(chip).toHaveTextContent("brief");
    // The passage is quoted in full (two lines, clamped by CSS), no «» marks.
    expect(chip).toHaveTextContent(
      "A passage that runs on well past the sixty characters a chip shows.",
    );
    fireEvent.click(chip);
    // With the clicked card, so the chat keeps it in place (keepInView).
    expect(open).toHaveBeenCalledWith(PATH, chip, { shineAfterVersion: edit.version });
    unmount();

    // Where there is no canvas (a public share), it only says what it was about.
    render(<CanvasEditChip edit={edit} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("Intro text.")).toBeInTheDocument();
  });
});

// ── Through the panel ───────────────────────────────────────────────────────

const latest = (over: Partial<CanvasDocumentVersion> = {}): CanvasDocumentVersion => ({
  path: PATH,
  name: "brief.md",
  version: 2,
  author: "agent",
  baseVersion: 1,
  createdAt: "2026-11-18T09:40:00Z",
  sizeBytes: 40,
  content: "# The brief\n\nIntro text.\n",
  ...over,
});

const INTRO: CanvasAskPassage = {
  text: "Intro text.",
  headingPath: ["The brief"],
  range: { anchor: at([1, 0]), focus: at([1, 0], 11) },
};

function renderCanvas(props: Partial<React.ComponentProps<typeof DocumentCanvas>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  const view = (extra: Partial<React.ComponentProps<typeof DocumentCanvas>>) => (
    <QueryClientProvider client={client}>
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
          {...props}
          {...extra}
        />
      </TooltipProvider>
    </QueryClientProvider>
  );
  const result = render(view({}));
  return {
    rerender: (extra: Partial<React.ComponentProps<typeof DocumentCanvas>>) =>
      result.rerender(view(extra)),
  };
}

/** The table picker is a popover: let it close before the next control is pressed. */
async function pickerClosed() {
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
}

/** Press the pill's Ask agent like a mouse does (pointerdown remembers the selection). */
function openAsk() {
  const trigger = screen.getByRole("button", { name: "Ask agent" });
  fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
  fireEvent.click(trigger);
}

describe("Ask agent in the canvas", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    api.listDocumentComments.mockResolvedValue([]);
    api.listConversationDocuments.mockResolvedValue([]);
    api.listDocumentVersions.mockResolvedValue([]);
    api.getLatestDocument.mockResolvedValue(latest());
    api.saveDocumentVersion.mockResolvedValue({
      kind: "saved",
      path: PATH,
      version: 3,
      createdAt: "2026-11-18T10:00:00Z",
    });
    passage.current = INTRO as never;
    coarse.current = true;
    orbSpot.current = null;
  });

  it("a preset sends the passage on the latest version as one request", async () => {
    const onAskAgent = vi.fn().mockResolvedValue(true);
    renderCanvas({ onAskAgent });
    await screen.findByRole("heading", { level: 1, name: "The brief" });

    openAsk();
    fireEvent.click(await screen.findByRole("button", { name: "Shorter" }));
    await waitFor(() => expect(onAskAgent).toHaveBeenCalledTimes(1));
    expect(onAskAgent).toHaveBeenCalledWith({
      path: PATH,
      version: 2,
      selection: "Intro text.",
      headingPath: ["The brief"],
      instruction: "Make it shorter",
      preset: "shorter",
    });
    expect(api.saveDocumentVersion).not.toHaveBeenCalled();
  });

  it("the floating selection bar's Ask agent opens the panel, the presets inside it", async () => {
    const onAskAgent = vi.fn().mockResolvedValue(true);
    renderCanvas({ onAskAgent });
    await screen.findByRole("heading", { level: 1, name: "The brief" });

    // happy-dom lays nothing out, so floating-ui's `hide` reports the selection
    // off screen and the menu is `visibility: hidden` here (no accessible
    // names): find it by its marker and its buttons by their text.
    const menu = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-canvas-selection-menu]");
      if (!found) throw new Error("no menu");
      return found;
    });
    expect(menu).toHaveAttribute("aria-label", "Selection actions");
    // The presets are not in the bar itself: they live in the Ask panel.
    expect(within(menu).queryByText("Shorter")).toBeNull();
    // Icon-only: the orb button is named by its label.
    fireEvent.click(menu.querySelector<HTMLElement>('button[aria-label="Ask agent"]')!);
    const input = await within(menu).findByPlaceholderText("Ask the agent to change this…");
    for (const label of ["Shorter", "Longer", "Formal", "Simpler", "Polish"]) {
      expect(within(menu).getByText(label)).toBeInTheDocument();
    }
    fireEvent.change(input, { target: { value: "Name the release" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(onAskAgent).toHaveBeenCalledTimes(1));
    expect(onAskAgent.mock.calls[0][0]).toMatchObject({
      version: 2,
      selection: "Intro text.",
      instruction: "Name the release",
    });
    // The phone has no floating menu: the pill's button is the way in there.
  });

  it("a typed instruction is sent with Enter; Esc closes without sending", async () => {
    const onAskAgent = vi.fn().mockResolvedValue(true);
    renderCanvas({ onAskAgent });
    await screen.findByRole("heading", { level: 1, name: "The brief" });

    openAsk();
    const input = await screen.findByPlaceholderText("Ask the agent to change this…");
    fireEvent.change(input, { target: { value: "Say it in Greek" } });
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByPlaceholderText("Ask the agent to change this…"),
      ).not.toBeInTheDocument(),
    );
    expect(onAskAgent).not.toHaveBeenCalled();

    openAsk();
    const again = await screen.findByPlaceholderText("Ask the agent to change this…");
    fireEvent.change(again, { target: { value: "  Say it in Greek " } });
    fireEvent.submit(again.closest("form")!);
    await waitFor(() => expect(onAskAgent).toHaveBeenCalledTimes(1));
    expect(onAskAgent.mock.calls[0][0]).toMatchObject({ instruction: "Say it in Greek" });
    expect(onAskAgent.mock.calls[0][0]).not.toHaveProperty("preset");
  });

  it("with unsaved edits asks first: Cancel sends nothing, Save and send saves then sends on the new version", async () => {
    const onAskAgent = vi.fn().mockResolvedValue(true);
    // A mouse: the pill keeps its block tools (Table) beside Ask agent.
    coarse.current = false;
    renderCanvas({ onAskAgent });
    await screen.findByRole("heading", { level: 1, name: "The brief" });

    const table = screen.getByRole("button", { name: "Table" });
    fireEvent.pointerDown(table, { button: 0, pointerType: "mouse" });
    fireEvent.click(table);
    fireEvent.click(await screen.findByRole("button", { name: "Insert a table, 2 by 3" }));
    await pickerClosed();
    expect(await screen.findByText("Unsaved changes")).toBeInTheDocument();

    openAsk();
    fireEvent.click(await screen.findByRole("button", { name: "Polish" }));
    expect(await screen.findByText("Save before asking the agent?")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discard" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByText("Save before asking the agent?")).not.toBeInTheDocument(),
    );
    expect(onAskAgent).not.toHaveBeenCalled();
    expect(api.saveDocumentVersion).not.toHaveBeenCalled();

    openAsk();
    fireEvent.click(await screen.findByRole("button", { name: "Polish" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save and send" }));
    await waitFor(() => expect(onAskAgent).toHaveBeenCalledTimes(1));
    expect(api.saveDocumentVersion).toHaveBeenCalledTimes(1);
    // Saved first (on v2), then asked on the version that save made.
    expect(api.saveDocumentVersion.mock.invocationCallOrder[0]).toBeLessThan(
      onAskAgent.mock.invocationCallOrder[0],
    );
    expect(onAskAgent.mock.calls[0][0]).toMatchObject({ version: 3, preset: "polish" });
  }, 15000);

  it("a failed save sends nothing", async () => {
    const onAskAgent = vi.fn().mockResolvedValue(true);
    // A mouse: the pill keeps its block tools (Table) beside Ask agent.
    coarse.current = false;
    api.saveDocumentVersion.mockRejectedValue(new Error("down"));
    renderCanvas({ onAskAgent });
    await screen.findByRole("heading", { level: 1, name: "The brief" });
    const table = screen.getByRole("button", { name: "Table" });
    fireEvent.pointerDown(table, { button: 0, pointerType: "mouse" });
    fireEvent.click(table);
    fireEvent.click(await screen.findByRole("button", { name: "Insert a table, 2 by 3" }));
    await pickerClosed();
    await screen.findByText("Unsaved changes");

    openAsk();
    fireEvent.click(await screen.findByRole("button", { name: "Longer" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save and send" }));
    expect(await screen.findByText("Save failed")).toBeInTheDocument();
    expect(onAskAgent).not.toHaveBeenCalled();
  }, 15000);

  it("waits while a reply streams, and says why", async () => {
    const onAskAgent = vi.fn().mockResolvedValue(true);
    renderCanvas({ onAskAgent, runActive: true });
    await screen.findByRole("heading", { level: 1, name: "The brief" });

    const trigger = screen.getByRole("button", { name: "Ask agent" });
    expect(trigger).toHaveAttribute("aria-disabled", "true");
    openAsk();
    expect(await screen.findByText("Wait for the current reply")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Shorter" })).not.toBeInTheDocument();
    expect(onAskAgent).not.toHaveBeenCalled();
  });

  it("the pill's Ask agent is always there while editing, says why with nothing to act on, and needs a conversation", async () => {
    // Nothing selected and no caret: there, but it says what it needs.
    passage.current = null;
    const { rerender } = renderCanvas({ onAskAgent: vi.fn() });
    await screen.findByRole("heading", { level: 1, name: "The brief" });
    const pill = screen.getByRole("toolbar", { name: "Formatting" });
    expect(within(pill).getByRole("button", { name: "Ask agent" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    openAsk();
    expect(
      await screen.findByText("Select some text, or put the caret in a paragraph"),
    ).toBeInTheDocument();
    // No conversation to send into: never.
    rerender({ onAskAgent: null });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Ask agent" })).not.toBeInTheDocument(),
    );
  });

  it("with a mouse the pill has Ask agent too, beside the floating menu over the selection", async () => {
    coarse.current = false;
    renderCanvas({ onAskAgent: vi.fn() });
    await screen.findByRole("heading", { level: 1, name: "The brief" });
    const pill = screen.getByRole("toolbar", { name: "Formatting" });
    expect(within(pill).getByRole("button", { name: "Ask agent" })).not.toHaveAttribute(
      "aria-disabled",
    );
    expect(document.querySelector("[data-canvas-selection-menu]")).not.toBeNull();
  });

  it("the orb at the caret asks about its whole block, on the latest version", async () => {
    coarse.current = false;
    passage.current = null;
    orbSpot.current = { index: 1, top: 10 };
    const onAskAgent = vi.fn().mockResolvedValue(true);
    const { rerender } = renderCanvas({ onAskAgent });
    await screen.findByRole("heading", { level: 1, name: "The brief" });

    const orb = document.querySelector<HTMLElement>("[data-canvas-caret-orb]")!;
    expect(orb).toHaveAttribute("aria-label", "Ask agent");
    fireEvent.click(orb);
    expect(await screen.findByText("Ask about this paragraph")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Simpler" }));
    await waitFor(() => expect(onAskAgent).toHaveBeenCalledTimes(1));
    expect(onAskAgent).toHaveBeenCalledWith({
      path: PATH,
      version: 2,
      selection: "Intro text.",
      headingPath: ["The brief"],
      instruction: "Make it simpler",
      preset: "simpler",
    });
    // While the agent edits that block, no orb.
    rerender({ onAskAgent, runActive: true, revision: "3:1" });
    await screen.findByLabelText("brief, read-only while the agent edits");
    expect(document.querySelector("[data-canvas-caret-orb]")).toBeNull();
  });

  it("the orb is hidden while reading, on touch, and without a conversation", async () => {
    passage.current = null;
    orbSpot.current = { index: 1, top: 10 };
    const orb = () => document.querySelector("[data-canvas-caret-orb]");

    // Touch: never (the pill's Ask agent is the way in there).
    coarse.current = true;
    const { rerender } = renderCanvas({ onAskAgent: vi.fn() });
    await screen.findByRole("heading", { level: 1, name: "The brief" });
    expect(orb()).toBeNull();

    coarse.current = false;
    rerender({ onAskAgent: vi.fn(), revision: "1" });
    await waitFor(() => expect(orb()).not.toBeNull());
    // No conversation to send into.
    rerender({ onAskAgent: null, revision: "2" });
    await waitFor(() => expect(orb()).toBeNull());

    // Reading: switch the mode to Viewing.
    rerender({ onAskAgent: vi.fn(), revision: "3" });
    await waitFor(() => expect(orb()).not.toBeNull());
    fireEvent.keyDown(screen.getByRole("button", { name: /^Mode: Editing/ }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Viewing/ }));
    await waitFor(() => expect(orb()).toBeNull());
  });

  it("is read-only while the agent's run goes, then loads the agent's version and unlocks", async () => {
    const onAskAgent = vi.fn().mockResolvedValue(true);
    const { rerender } = renderCanvas({ onAskAgent });
    await screen.findByRole("heading", { level: 1, name: "The brief" });

    openAsk();
    fireEvent.click(await screen.findByRole("button", { name: "Shorter" }));
    await waitFor(() => expect(onAskAgent).toHaveBeenCalled());
    rerender({ onAskAgent, runActive: true, revision: "3:1" });

    expect(
      await screen.findByLabelText("brief, read-only while the agent edits"),
    ).not.toHaveAttribute("contenteditable", "true");
    expect(screen.getAllByText(/Agent is editing…/).length).toBeGreaterThan(0);
    expect(screen.queryByRole("toolbar", { name: "Formatting" })).not.toBeInTheDocument();

    // The agent saved v3; the run ends.
    api.getLatestDocument.mockResolvedValue(
      latest({ version: 3, content: "# The brief\n\nShort intro.\n" }),
    );
    const reads = api.getLatestDocument.mock.calls.length;
    await act(async () => rerender({ onAskAgent, runActive: false, revision: "3:0" }));

    expect(await screen.findByText("Short intro.")).toBeInTheDocument();
    expect(api.getLatestDocument.mock.calls.length).toBeGreaterThan(reads);
    expect(await screen.findByLabelText("brief, editing")).toHaveAttribute(
      "contenteditable",
      "true",
    );
    expect(screen.queryAllByText(/Agent is editing…/)).toHaveLength(0);
    expect(screen.getByRole("toolbar", { name: "Formatting" })).toBeInTheDocument();
  }, 15000);

  it("sends the document's path as the documents API returned it", async () => {
    const onAskAgent = vi.fn().mockResolvedValue(true);
    api.getLatestDocument.mockResolvedValue(latest({ path: "/conversation/output/brief.md" }));
    renderCanvas({ onAskAgent, path: "/conversation/output/Brief.md" });
    await screen.findByRole("heading", { level: 1, name: "The brief" });
    openAsk();
    fireEvent.click(await screen.findByRole("button", { name: "Formal" }));
    await waitFor(() => expect(onAskAgent).toHaveBeenCalled());
    expect(onAskAgent.mock.calls[0][0].path).toBe("/conversation/output/brief.md");
  });

  it("any run that ends re-reads the latest version, with no new artifact card: a silent reload", async () => {
    // The chat's revision is `<message count>:<busy>` (ChatView): it changes
    // on every run end, whether or not the run presented a file.
    const { rerender } = renderCanvas({ revision: "4:1", runActive: true });
    await screen.findByText("Intro text.");
    const reads = api.getLatestDocument.mock.calls.length;
    api.getLatestDocument.mockResolvedValue(
      latest({ version: 3, content: "# The brief\n\nThe agent's intro.\n" }),
    );
    await act(async () => rerender({ revision: "4:0", runActive: false }));
    expect(await screen.findByText("The agent's intro.")).toBeInTheDocument();
    expect(api.getLatestDocument.mock.calls.length).toBeGreaterThan(reads);
    expect(screen.queryByRole("button", { name: "Review" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("brief, editing")).toHaveAttribute("contenteditable", "true");
  });

  it("a send that could not start unlocks at once", async () => {
    const onAskAgent = vi.fn().mockResolvedValue(false);
    renderCanvas({ onAskAgent });
    await screen.findByRole("heading", { level: 1, name: "The brief" });
    openAsk();
    fireEvent.click(await screen.findByRole("button", { name: "Simpler" }));
    await waitFor(() => expect(onAskAgent).toHaveBeenCalled());
    expect(await screen.findByLabelText("brief, editing")).toHaveAttribute(
      "contenteditable",
      "true",
    );
  });
});

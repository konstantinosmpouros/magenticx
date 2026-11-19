// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Comments as the agent's instruction channel (plan 44 v2), over a mocked
 * bridge.
 *
 * Pinned: `@agent` as a word (not in an address, not a longer word), the
 * instruction without it ("Address this comment." when nothing is left), the
 * "@" suggestion's query and completion; the wire (`commentId` kept only as a
 * UUID, by the schema and the message whitelist, sent by `buildCanvasEdit`);
 * the "Agent is writing" signal read from a run's timeline. In the canvas: a
 * reply or a new thread with `@agent` is saved first, then sent like Ask
 * agent with the thread's id (and through Save and send with unsaved edits),
 * the card says the agent is working while the run goes and the editor is
 * locked, the comments are read again when the run ends; the composer offers
 * "@agent" on "@" (keyboard and pointer); the agent's comments carry its
 * avatar and a thread it resolved says so; a click on a painted passage no
 * longer opens a card; a chat card with `commentId` opens its thread's card;
 * the agent writing the document locks it and marks where.
 */

const { api, passage, coarse } = vi.hoisted(() => ({
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
    createDocumentComment: vi.fn(),
    updateDocumentComment: vi.fn(),
    deleteDocumentComment: vi.fn(),
    exportDocument: vi.fn(),
  },
  passage: { current: null as null | Record<string, unknown> },
  coarse: { current: true },
}));
vi.mock("@/shared/lib/api", () => api);
vi.mock("@/features/canvas/hooks/useCoarsePointer", () => ({
  useCoarsePointer: () => coarse.current,
}));
vi.mock("@/features/canvas/lib/askAgent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/canvas/lib/askAgent")>();
  return {
    ...actual,
    selectedPassage: (editor: Parameters<typeof actual.selectedPassage>[0]) =>
      passage.current ?? actual.selectedPassage(editor),
  };
});

import DocumentCanvas from "@/features/canvas/components/DocumentCanvas";
import {
  completeMention,
  hasAgentMention,
  mentionInstruction,
  mentionQuery,
  splitAgentMentions,
} from "@/features/canvas/lib/agentMention";
import { agentWritingIn, writingPassage } from "@/features/canvas/lib/agentWriting";
import { buildCanvasEdit } from "@/features/canvas/lib/askAgent";
import { requestCanvasThread } from "@/features/canvas/lib/pendingThread";
import { CanvasEditChip } from "@/features/chat/components/message_parts/CanvasEditChip";
import { CanvasOpenerContext } from "@/features/chat/lib/canvasOpener";
import { transformMessage } from "@/shared/lib/consts";
import { toCanvasEdit } from "@/shared/lib/schemas";
import type {
  CanvasComment,
  CanvasDocumentVersion,
  RunTimeline,
  TimelineToolExecution,
} from "@/shared/lib/types";
import { TooltipProvider } from "@/shared/ui/tooltip";

const PATH = "/conversation/output/brief.md";
const DOC = "# The brief\n\nIntro text.\n\nThe plan is set. The plan is late.\n\nShip it.\n";
const THREAD = "5f0c1a3e-6b7d-4c8e-9f10-2a3b4c5d6e7f";
const at = (path: number[], offset = 0) => ({ path, offset });

const latest = (): CanvasDocumentVersion => ({
  path: PATH,
  name: "brief.md",
  version: 2,
  author: "agent",
  baseVersion: 1,
  createdAt: "2026-11-18T09:40:00Z",
  sizeBytes: 80,
  content: DOC,
});

const comment = (over: Partial<CanvasComment> = {}): CanvasComment => ({
  id: THREAD,
  path: PATH,
  version: 2,
  parentId: null,
  anchor: { quote: "Intro text.", prefix: "The brief\n", suffix: "\nThe plan" },
  body: "Shorter here?",
  author: "user",
  status: "open",
  resolvedBy: null,
  resolutionNote: null,
  createdAt: "2026-11-18T10:00:00Z",
  updatedAt: "2026-11-18T10:00:00Z",
  ...over,
});

// ── The text of a mention ───────────────────────────────────────────────────

describe("@agent in a comment", () => {
  it("is the token as a word, in any case", () => {
    expect(hasAgentMention("@agent make it shorter")).toBe(true);
    expect(hasAgentMention("Please, @Agent: fix this")).toBe(true);
    expect(hasAgentMention("ask (@AGENT)")).toBe(true);
    expect(hasAgentMention("mail me@agent.io")).toBe(false);
    expect(hasAgentMention("the @agents team")).toBe(false);
    expect(hasAgentMention("@@agent")).toBe(false);
    expect(hasAgentMention("no mention")).toBe(false);
  });

  it("asks with the comment without the token, or a default when nothing is left", () => {
    expect(mentionInstruction("@agent make it shorter")).toBe("make it shorter");
    expect(mentionInstruction("Make this formal @agent, please")).toBe("Make this formal , please");
    expect(mentionInstruction("  @AGENT  ")).toBe("Address this comment.");
    expect(splitAgentMentions("hi @agent there")).toEqual([
      { text: "hi ", mention: false },
      { text: "@agent", mention: true },
      { text: " there", mention: false },
    ]);
  });

  it("suggests @agent after an '@' that starts it, and completes it", () => {
    expect(mentionQuery("Fix @", 5)).toEqual({ start: 4, typed: "" });
    expect(mentionQuery("@ag", 3)).toEqual({ start: 0, typed: "ag" });
    expect(mentionQuery("@agent", 6)).toBeNull();
    expect(mentionQuery("@x", 2)).toBeNull();
    expect(mentionQuery("me@", 3)).toBeNull();
    expect(completeMention("Fix @ag", { start: 4, typed: "ag" })).toEqual({
      text: "Fix @agent ",
      caret: 11,
    });
  });
});

// ── The wire ────────────────────────────────────────────────────────────────

describe("commentId on the wire", () => {
  const edit = {
    path: PATH,
    version: 2,
    selection: "Intro text.",
    headingPath: ["The brief"],
    instruction: "make it shorter",
  };

  it("the schema keeps a thread's UUID and drops anything else", () => {
    expect(toCanvasEdit({ ...edit, commentId: THREAD })).toEqual({ ...edit, commentId: THREAD });
    expect(toCanvasEdit({ ...edit, comment_id: THREAD.toUpperCase() })).toEqual({
      ...edit,
      commentId: THREAD,
    });
    expect(toCanvasEdit({ ...edit, commentId: "c1" })).toEqual(edit);
    expect(toCanvasEdit({ ...edit, commentId: 7 })).toEqual(edit);
  });

  it("the message whitelist keeps it on a user message", () => {
    expect(
      transformMessage({ id: "m1", sender: "user", canvasEdit: { ...edit, commentId: THREAD } })
        .canvasEdit,
    ).toEqual({ ...edit, commentId: THREAD });
  });

  it("the request carries the thread's id, and leaves it out otherwise", () => {
    const draft = {
      passage: { text: "Intro text.", headingPath: ["The brief"], range: null },
      instruction: "make it shorter",
    };
    expect(buildCanvasEdit({ path: PATH, version: 2, draft: { ...draft, commentId: THREAD } }))
      .toEqual({ ...edit, commentId: THREAD });
    expect(buildCanvasEdit({ path: PATH, version: 2, draft })).not.toHaveProperty("commentId");
  });

  it("the chat card says it came from a comment, and opens that thread", () => {
    const open = vi.fn();
    render(
      <CanvasOpenerContext.Provider value={open}>
        <CanvasEditChip edit={{ ...edit, commentId: THREAD }} />
      </CanvasOpenerContext.Provider>,
    );
    const chip = screen.getByRole("button", { name: /^Open brief in the canvas, on the comment/ });
    expect(chip).toHaveTextContent("Comment · Intro text.");
    fireEvent.click(chip);
    expect(open).toHaveBeenCalledWith(PATH, chip, { shineAfterVersion: 2, commentId: THREAD });
  });
});

// ── The agent writing ───────────────────────────────────────────────────────

const tool = (over: Partial<TimelineToolExecution>): TimelineToolExecution => ({
  kind: "tool",
  id: "t1",
  name: "edit_file",
  argsText: "",
  state: "input-available",
  ...over,
});

const timeline = (items: TimelineToolExecution[], extra: Partial<RunTimeline> = {}) =>
  ({
    blocks: [{ kind: "thinking", id: "b1", items }],
    plan: null,
    interrupts: [],
    subagentCount: 0,
    terminal: false,
    lastSeq: 1,
    fold: {},
    ...extra,
  }) as unknown as RunTimeline;

const args = (name: string, value: Record<string, unknown>) => JSON.stringify({ name, args: value });

describe("the agent writing the open document", () => {
  it("is an edit_file / write_file call on its path with no result yet", () => {
    const edit = tool({
      argsText: args("edit_file", {
        file_path: PATH,
        old_string: "## Scope\n\nThe **plan** is set.",
        new_string: "x",
      }),
    });
    expect(agentWritingIn(timeline([edit]), PATH)).toEqual({ tool: "edit_file", passage: "Scope" });
    // Done, another file, a finished run, nothing: not writing.
    expect(agentWritingIn(timeline([{ ...edit, state: "output-available" }]), PATH)).toBeNull();
    expect(agentWritingIn(timeline([edit]), "/conversation/output/other.md")).toBeNull();
    expect(agentWritingIn(timeline([edit], { terminal: true }), PATH)).toBeNull();
    expect(agentWritingIn(null, PATH)).toBeNull();
    const write = tool({ name: "write_file", argsText: args("write_file", { file_path: PATH }) });
    expect(agentWritingIn(timeline([write]), PATH)).toEqual({ tool: "write_file", passage: null });
  });

  it("finds a sub-agent's write too", () => {
    const edit = tool({ argsText: args("edit_file", { file_path: PATH, old_string: "Ship it." }) });
    const run = timeline([], {
      blocks: [
        {
          kind: "subagent",
          id: "s1",
          taskId: "t",
          blocks: [{ kind: "thinking", id: "b", items: [edit] }],
        },
      ] as unknown as RunTimeline["blocks"],
    });
    expect(agentWritingIn(run, PATH)).toEqual({ tool: "edit_file", passage: "Ship it." });
  });

  it("looks up the first line of old_string with words, as it reads", () => {
    expect(writingPassage("\n| --- | --- |\n| **A** | [link](http://x) |")).toBe("A link");
    expect(writingPassage("> - [ ] *Do* `it`")).toBe("Do it");
    expect(writingPassage("\n\n")).toBeNull();
  });
});

// ── In the canvas ───────────────────────────────────────────────────────────

function renderCanvas(props: Partial<React.ComponentProps<typeof DocumentCanvas>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

/** happy-dom lays nothing out: each passage gets its own line (as in canvas-comments). */
const linesOf = new Map<string, number>();
beforeAll(() => {
  Range.prototype.getClientRects = function getClientRects(this: Range) {
    const text = this.toString();
    if (!linesOf.has(text)) linesOf.set(text, linesOf.size * 40 + 40);
    const top = linesOf.get(text)!;
    return [{ top, height: 24, width: 120, left: 0, right: 120, bottom: top + 24 }] as unknown as DOMRectList;
  };
});

const openCard = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "1 comment on this line" }));
  return screen.findByRole("dialog", { name: "Comment" });
};

const threadOf = (card: HTMLElement) =>
  within(card).getByRole("listitem", { name: "Comment on “Intro text.”" });

describe("comments as instructions in the canvas", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    api.listConversationDocuments.mockResolvedValue([]);
    api.listDocumentVersions.mockResolvedValue([]);
    api.getLatestDocument.mockResolvedValue(latest());
    api.listDocumentComments.mockResolvedValue([comment()]);
    api.createDocumentComment.mockImplementation(async (_u, _c, draft) =>
      comment({
        id: draft.parentId ? "r1" : THREAD,
        parentId: draft.parentId ?? null,
        anchor: draft.anchor ?? null,
        body: draft.body,
      }),
    );
    api.saveDocumentVersion.mockResolvedValue({
      kind: "saved",
      path: PATH,
      version: 3,
      createdAt: "2026-11-18T10:00:00Z",
    });
    passage.current = null;
    coarse.current = true;
  });

  it("a reply with @agent is saved, then sent with the thread's id; the card says the agent works; the run's end re-reads the comments", async () => {
    const onAskAgent = vi.fn().mockResolvedValue(true);
    const { rerender } = renderCanvas({ onAskAgent });
    await screen.findByRole("heading", { level: 1, name: "The brief" });
    const card = await openCard();

    fireEvent.click(
      within(card).getByRole("button", { name: "Reply, or @agent to ask the agent…" }),
    );
    const field = within(card).getByLabelText("Reply to the thread");
    expect(field).toHaveAttribute("placeholder", "Reply, or @agent to ask the agent…");
    fireEvent.change(field, { target: { value: "@agent make it shorter" } });
    expect(within(card).getByText("The agent will act on this")).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "Reply" }));

    await waitFor(() => expect(onAskAgent).toHaveBeenCalledTimes(1));
    // Saved first, then asked.
    expect(api.createDocumentComment).toHaveBeenCalledWith("user-1", "conv-1", {
      path: PATH,
      version: 2,
      parentId: THREAD,
      body: "@agent make it shorter",
    });
    expect(api.createDocumentComment.mock.invocationCallOrder[0]).toBeLessThan(
      onAskAgent.mock.invocationCallOrder[0],
    );
    expect(onAskAgent).toHaveBeenCalledWith({
      path: PATH,
      version: 2,
      selection: "Intro text.",
      headingPath: ["The brief"],
      instruction: "make it shorter",
      commentId: THREAD,
    });

    // The token is styled in the saved reply; the card says the agent works on it.
    const token = await within(threadOf(card)).findByText("@agent");
    expect(token.className).toMatch(/text-primary/);
    expect(within(threadOf(card)).getByRole("status")).toHaveTextContent(
      "Agent is working on this…",
    );

    // The run goes: the editor is locked. It ends: the comments are read again.
    const reads = api.listDocumentComments.mock.calls.length;
    rerender({ onAskAgent, runActive: true, revision: "3:1" });
    await screen.findByLabelText("brief, read-only while the agent edits");
    api.listDocumentComments.mockResolvedValue([
      comment({ status: "resolved", resolvedBy: "agent" }),
      comment({ id: "r1", parentId: THREAD, anchor: null, body: "@agent make it shorter" }),
      comment({ id: "r2", parentId: THREAD, anchor: null, body: "Cut it to one line.", author: "agent" }),
    ]);
    rerender({ onAskAgent, runActive: false, revision: "4:0" });
    await waitFor(() => expect(api.listDocumentComments.mock.calls.length).toBeGreaterThan(reads));
    // Resolved by the agent: off the line, in the document row's card.
    fireEvent.click(await screen.findByRole("button", { name: "1 resolved or detached comment" }));
    const others = await screen.findByRole("dialog", { name: "Resolved and detached comments" });
    expect(within(others).getByText(/Resolved by the agent/)).toBeInTheDocument();
    expect(within(others).getByText("Cut it to one line.")).toBeInTheDocument();
  });

  it("a new thread with @agent asks with the saved thread's id", async () => {
    api.listDocumentComments.mockResolvedValue([]);
    passage.current = {
      text: "Intro text.",
      headingPath: ["The brief"],
      range: { anchor: at([1, 0]), focus: at([1, 0], 11) },
    };
    const onAskAgent = vi.fn().mockResolvedValue(true);
    renderCanvas({ onAskAgent });
    await screen.findByRole("heading", { level: 1, name: "The brief" });
    const pill = screen.getByRole("toolbar", { name: "Formatting" });
    const trigger = within(pill).getByRole("button", { name: "Comment" });
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "touch" });
    fireEvent.click(trigger);
    const field = await screen.findByLabelText("Comment on the selected text");
    expect(field).toHaveAttribute("placeholder", "Comment, or @agent to ask the agent…");
    fireEvent.change(field, { target: { value: "@Agent" } });
    fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });

    await waitFor(() => expect(onAskAgent).toHaveBeenCalledTimes(1));
    expect(onAskAgent.mock.calls[0][0]).toMatchObject({
      selection: "Intro text.",
      instruction: "Address this comment.",
      commentId: THREAD,
    });
  });

  it("a plain comment asks nothing, and without a conversation @agent is not offered", async () => {
    const onAskAgent = vi.fn().mockResolvedValue(true);
    const { rerender } = renderCanvas({ onAskAgent });
    await screen.findByRole("heading", { level: 1, name: "The brief" });
    let card = await openCard();
    fireEvent.click(within(card).getByRole("button", { name: /^Reply/ }));
    fireEvent.change(within(card).getByLabelText("Reply to the thread"), {
      target: { value: "Fine by me, agent." },
    });
    fireEvent.click(within(card).getByRole("button", { name: "Reply" }));
    await waitFor(() => expect(api.createDocumentComment).toHaveBeenCalledTimes(1));
    expect(onAskAgent).not.toHaveBeenCalled();

    rerender({ onAskAgent: null });
    card = await screen.findByRole("dialog", { name: "Comment" }).catch(openCard);
    expect(within(card).getByRole("button", { name: "Reply…" })).toBeInTheDocument();
  });

  it("with unsaved edits, Save and send saves first, then asks on the new version", async () => {
    coarse.current = false;
    const onAskAgent = vi.fn().mockResolvedValue(true);
    renderCanvas({ onAskAgent });
    await screen.findByRole("heading", { level: 1, name: "The brief" });
    const table = screen.getByRole("button", { name: "Table" });
    fireEvent.pointerDown(table, { button: 0, pointerType: "mouse" });
    fireEvent.click(table);
    fireEvent.click(await screen.findByRole("button", { name: "Insert a table, 2 by 3" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByText("Unsaved changes")).toBeInTheDocument();

    const card = await openCard();
    fireEvent.click(within(card).getByRole("button", { name: /^Reply/ }));
    fireEvent.change(within(card).getByLabelText("Reply to the thread"), {
      target: { value: "@agent tighten" },
    });
    fireEvent.click(within(card).getByRole("button", { name: "Reply" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save and send" }));
    await waitFor(() => expect(onAskAgent).toHaveBeenCalledTimes(1));
    expect(api.saveDocumentVersion.mock.invocationCallOrder[0]).toBeLessThan(
      onAskAgent.mock.invocationCallOrder[0],
    );
    expect(onAskAgent.mock.calls[0][0]).toMatchObject({ version: 3, commentId: THREAD });
  }, 15000);

  it("offers @agent on '@': Enter takes it, a click takes it, Esc closes only the suggestion", async () => {
    renderCanvas({ onAskAgent: vi.fn() });
    await screen.findByRole("heading", { level: 1, name: "The brief" });
    const card = await openCard();
    fireEvent.click(within(card).getByRole("button", { name: /^Reply/ }));
    const field = within(card).getByLabelText<HTMLTextAreaElement>("Reply to the thread");

    // Typed with the caret at the end (a new value puts it there).
    const type = (value: string) => fireEvent.change(field, { target: { value } });
    type("Fix @a");
    const option = within(card).getByRole("option", { name: /@agent/ });
    expect(field).toHaveAttribute("aria-activedescendant", option.id);
    fireEvent.keyDown(field, { key: "Enter" });
    expect(field.value).toBe("Fix @agent ");
    expect(within(card).queryByRole("option")).not.toBeInTheDocument();

    type("Then @");
    fireEvent.click(within(card).getByRole("option", { name: /@agent/ }));
    expect(field.value).toBe("Then @agent ");

    type("Or @");
    fireEvent.keyDown(field, { key: "Escape" });
    expect(within(card).queryByRole("option")).not.toBeInTheDocument();
    // The form is still open: Esc closed the suggestion, not the reply.
    expect(within(card).getByLabelText("Reply to the thread")).toBeInTheDocument();
  });

  it("shows the agent's comments with its avatar and name", async () => {
    api.listDocumentComments.mockResolvedValue([
      comment(),
      comment({ id: "r1", parentId: THREAD, anchor: null, body: "Done: one line now.", author: "agent" }),
    ]);
    renderCanvas({ onAskAgent: vi.fn() });
    await screen.findByRole("heading", { level: 1, name: "The brief" });
    const card = await openCard();
    const reply = within(threadOf(card)).getByText("Done: one line now.").closest("div")!
      .parentElement!;
    expect(within(reply).getByText("Agent")).toBeInTheDocument();
    expect(reply.querySelector("[data-canvas-agent-avatar]")).not.toBeNull();
  });

  it("a click on a painted passage does not open its card: only the mark does", async () => {
    renderCanvas();
    await screen.findByRole("heading", { level: 1, name: "The brief" });
    await screen.findByRole("button", { name: "1 comment on this line" });
    fireEvent.click(screen.getByText("Intro text."));
    expect(screen.queryByRole("dialog", { name: "Comment" })).not.toBeInTheDocument();
  });

  it("opens the thread a chat card asked for under its mark", async () => {
    requestCanvasThread({ path: PATH, commentId: THREAD });
    renderCanvas();
    const card = await screen.findByRole("dialog", { name: "Comment" });
    expect(threadOf(card)).toBeInTheDocument();
  });

  it("opens a thread the agent resolved in the document row's card, on it", async () => {
    api.listDocumentComments.mockResolvedValue([
      comment({ status: "resolved", resolvedBy: "agent" }),
    ]);
    renderCanvas();
    await screen.findByRole("heading", { level: 1, name: "The brief" });
    // Asked while the canvas is open (heard, not taken at mount).
    act(() => requestCanvasThread({ path: PATH, commentId: THREAD }));
    const others = await screen.findByRole("dialog", { name: "Resolved and detached comments" });
    const item = within(others).getByRole("listitem", {
      name: "Resolved comment on “Intro text.”",
    });
    expect(item.className).toMatch(/ring-2/);
    expect(within(others).getByText("Resolved by the agent")).toBeInTheDocument();
  });

  it("while the agent writes the document: read-only, and marked where", async () => {
    const { rerender } = renderCanvas({ onAskAgent: vi.fn() });
    await screen.findByRole("heading", { level: 1, name: "The brief" });
    expect(screen.getByLabelText("brief, editing")).toBeInTheDocument();
    rerender({
      onAskAgent: vi.fn(),
      runActive: true,
      agentWriting: { tool: "edit_file", passage: "The plan is set." },
    });
    await screen.findByLabelText("brief, read-only while the agent edits");
    expect(await screen.findByText("Agent is writing here")).toBeInTheDocument();
    expect(document.querySelector("[data-canvas-writing-bar]")).not.toBeNull();
    expect(screen.getByText("Agent is writing…")).toBeInTheDocument();

    // Not found in the text (or write_file): the label at the top.
    rerender({
      onAskAgent: vi.fn(),
      runActive: true,
      agentWriting: { tool: "write_file", passage: null },
    });
    await waitFor(() => expect(document.querySelector("[data-canvas-writing-bar]")).toBeNull());
    expect(screen.getAllByText("Agent is writing…").length).toBeGreaterThan(0);

    // Done: editable again.
    rerender({ onAskAgent: vi.fn(), runActive: false, agentWriting: null });
    await screen.findByLabelText("brief, editing");
    expect(screen.queryByText(/Agent is writing/)).not.toBeInTheDocument();
  });
});

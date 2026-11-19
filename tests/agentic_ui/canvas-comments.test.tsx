// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Comments in the canvas (plan 44, Phase 4.4), over a mocked bridge.
 *
 * Pinned: the anchor of a selection is its quote with the text around it,
 * read the same way it is found again; a quote that occurs twice is found by
 * its prefix and suffix, a quote that is gone is detached, and a quote over
 * the bridge's bound is refused; the wire contract (camelCase or snake_case,
 * rows that can't be placed dropped) and the four routes with their bodies;
 * in the canvas: Comment on a selection sends one thread on the shown saved
 * version and opens the panel, the panel lists the open threads with their
 * replies (a detached one says so) and folds the resolved ones, and reply,
 * resolve, reopen, edit and delete reach the bridge — each shown at once and
 * rolled back when refused. A comment never makes the document unsaved.
 */

const { api, http, passage, coarse } = vi.hoisted(() => ({
  api: {
    listConversationDocuments: vi.fn(),
    getLatestDocument: vi.fn(),
    listDocumentVersions: vi.fn(),
    getDocumentVersion: vi.fn(),
    saveDocumentVersion: vi.fn(),
    listDocumentComments: vi.fn(),
    createDocumentComment: vi.fn(),
    updateDocumentComment: vi.fn(),
    deleteDocumentComment: vi.fn(),
    exportDocument: vi.fn(),
  },
  http: { requestJson: vi.fn(), requestVoid: vi.fn() },
  passage: { current: null as null | Record<string, unknown> },
  coarse: { current: true },
}));
vi.mock("@/shared/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/lib/api")>();
  // `wire` keeps the real calls, for the contract tests over a mocked http.
  return { ...api, wire: actual };
});
vi.mock("@/shared/lib/http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/lib/http")>()),
  requestJson: http.requestJson,
  requestVoid: http.requestVoid,
}));
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
import { captureAnchor, buildTextIndex, locateAnchor } from "@/features/canvas/lib/commentAnchors";
import { createCanvasEditor } from "@/features/canvas/lib/editorKit";
import { markdownToValue } from "@/features/canvas/lib/markdown";
import * as apiModule from "@/shared/lib/api";
import { ApiError } from "@/shared/lib/http";
import { CanvasCommentListSchema, CanvasCommentSchema } from "@/shared/lib/schemas";
import type { CanvasComment, CanvasDocumentVersion } from "@/shared/lib/types";
import { TooltipProvider } from "@/shared/ui/tooltip";

const wire = (apiModule as unknown as { wire: typeof import("@/shared/lib/api") }).wire;

const PATH = "/conversation/output/brief.md";
const DOC = "# The brief\n\nIntro text.\n\nThe plan is set. The plan is late.\n\nShip it.\n";
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
  id: "c1",
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

describe("comment anchors", () => {
  it("captures the quote with the text around it, and finds it again", () => {
    const editor = createCanvasEditor(markdownToValue(DOC));
    const capture = captureAnchor(editor, { anchor: at([1, 0], 0), focus: at([1, 0], 5) });
    expect(capture).toEqual({
      kind: "anchor",
      anchor: {
        quote: "Intro",
        prefix: "The brief\n",
        suffix: " text.\nThe plan is set. The plan is late.\nShip it.",
      },
    });
    const { text } = buildTextIndex(editor);
    if (capture?.kind !== "anchor") throw new Error("no anchor");
    expect(locateAnchor(text, capture.anchor)).toEqual({
      start: 10,
      end: 15,
    });
  });

  it("tells two occurrences apart by the text around them", () => {
    const editor = createCanvasEditor(markdownToValue(DOC));
    // The second "The plan" of the paragraph.
    const capture = captureAnchor(editor, { anchor: at([2, 0], 17), focus: at([2, 0], 25) });
    if (capture?.kind !== "anchor") throw new Error("no anchor");
    expect(capture.anchor.quote).toBe("The plan");
    const { text } = buildTextIndex(editor);
    const found = locateAnchor(text, capture.anchor);
    expect(found).not.toBeNull();
    expect(text.slice(found!.start, found!.end + 8)).toBe("The plan is late");
    // Without context, the first one wins.
    expect(locateAnchor(text, { quote: "The plan", prefix: "", suffix: "" })?.start).toBe(
      text.indexOf("The plan"),
    );
  });

  it("is detached when the quote is gone, and refuses a caret or too long a quote", () => {
    const editor = createCanvasEditor(markdownToValue(DOC));
    expect(
      locateAnchor(buildTextIndex(editor).text, { quote: "Gone", prefix: "", suffix: "" }),
    ).toBeNull();
    expect(captureAnchor(editor, { anchor: at([1, 0], 2), focus: at([1, 0], 2) })).toBeNull();
    const long = createCanvasEditor(markdownToValue(`${"word ".repeat(500)}\n`));
    const capture = captureAnchor(long, { anchor: at([0, 0], 0), focus: at([0, 0], 2400) });
    expect(capture?.kind).toBe("problem");
  });
});

describe("the comments contract", () => {
  beforeEach(() => {
    http.requestJson.mockReset();
    http.requestVoid.mockReset();
  });

  it("reads camelCase or snake_case, and drops what can't be placed", () => {
    const list = CanvasCommentListSchema.parse({
      comments: [
        {
          id: "a",
          path: PATH,
          version: 2,
          parent_id: null,
          anchor: { quote: "x" },
          body: "b",
          author: "user",
          status: "open",
          created_at: "t",
        },
        {
          id: "r",
          path: PATH,
          version: 2,
          parentId: "a",
          anchor: null,
          body: "reply",
          author: "agent",
          status: "open",
          resolvedBy: "agent",
        },
        { id: "lost", path: PATH, version: 2, parentId: null, anchor: null, body: "no anchor" },
        { path: PATH, body: "no id", anchor: { quote: "y" } },
      ],
    });
    expect(list.map((item) => item.id)).toEqual(["a", "r"]);
    expect(list[0]).toMatchObject({
      parentId: null,
      anchor: { quote: "x", prefix: "", suffix: "" },
      createdAt: "t",
    });
    expect(list[1]).toMatchObject({ parentId: "a", author: "agent", resolvedBy: "agent" });
    expect(CanvasCommentSchema.safeParse({ body: "no id" }).success).toBe(false);
  });

  it("sends each change to its route, with the CSRF token", async () => {
    http.requestJson.mockResolvedValue(comment());
    await wire.createDocumentComment("user-1", "conv-1", {
      path: PATH,
      version: 2,
      body: "Shorter?",
      anchor: { quote: "Intro text.", prefix: "", suffix: "" },
    });
    let [url, options] = http.requestJson.mock.calls.at(-1)!;
    expect(url).toBe("/api/v1/conversations/user-1/conv-1/documents/comments");
    expect(options).toMatchObject({
      method: "POST",
      csrf: true,
      body: { path: PATH, version: 2, body: "Shorter?", anchor: { quote: "Intro text." } },
    });
    expect(options.body).not.toHaveProperty("parentId");

    await wire.createDocumentComment("user-1", "conv-1", {
      path: PATH,
      version: 2,
      body: "Yes",
      parentId: "c1",
    });
    [, options] = http.requestJson.mock.calls.at(-1)!;
    expect(options.body).toEqual({ path: PATH, version: 2, body: "Yes", parentId: "c1" });

    await wire.updateDocumentComment("user-1", "conv-1", "c1", { status: "resolved" });
    [url, options] = http.requestJson.mock.calls.at(-1)!;
    expect(url).toBe("/api/v1/conversations/user-1/conv-1/documents/comments/c1");
    expect(options).toMatchObject({ method: "PATCH", csrf: true, body: { status: "resolved" } });

    await wire.deleteDocumentComment("user-1", "conv-1", "c1");
    [url, options] = http.requestVoid.mock.calls.at(-1)!;
    expect(url).toBe("/api/v1/conversations/user-1/conv-1/documents/comments/c1");
    expect(options).toMatchObject({ method: "DELETE", csrf: true });

    http.requestJson.mockResolvedValue([]);
    await wire.listDocumentComments("user-1", "conv-1", PATH);
    [url] = http.requestJson.mock.calls.at(-1)!;
    expect(url).toBe(
      `/api/v1/conversations/user-1/conv-1/documents/comments?${new URLSearchParams({ path: PATH })}`,
    );
  });
});

function renderCanvas(props: Partial<React.ComponentProps<typeof DocumentCanvas>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
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
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const openPanel = async () => {
  fireEvent.click(await screen.findByRole("button", { name: /^Comments/ }));
  return screen.findByRole("complementary", { name: "Comments" });
};

const threadCard = (panel: HTMLElement, quote: string) =>
  within(panel).getByRole("listitem", { name: `Comment on “${quote}”` });

describe("comments in the canvas", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    api.listConversationDocuments.mockResolvedValue([]);
    api.listDocumentVersions.mockResolvedValue([]);
    api.getLatestDocument.mockResolvedValue(latest());
    api.listDocumentComments.mockResolvedValue([]);
    passage.current = null;
    coarse.current = true;
  });

  it("Comment on a selection starts one thread on the shown version and opens the panel", async () => {
    passage.current = {
      text: "Intro text.",
      headingPath: ["The brief"],
      range: { anchor: at([1, 0]), focus: at([1, 0], 11) },
    };
    let answer: (value: CanvasComment) => void = () => {};
    api.createDocumentComment.mockReturnValue(new Promise((done) => (answer = done)));
    renderCanvas();
    await screen.findByRole("heading", { level: 1, name: "The brief" });

    const pill = screen.getByRole("toolbar", { name: "Formatting" });
    const trigger = within(pill).getByRole("button", { name: "Comment" });
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "touch" });
    fireEvent.click(trigger);
    const field = await screen.findByLabelText("Comment on the selected text");
    fireEvent.change(field, { target: { value: "  Shorter here?  " } });
    fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });

    await waitFor(() => expect(api.createDocumentComment).toHaveBeenCalledTimes(1));
    expect(api.createDocumentComment).toHaveBeenCalledWith("user-1", "conv-1", {
      path: PATH,
      version: 2,
      body: "Shorter here?",
      anchor: {
        quote: "Intro text.",
        prefix: "The brief\n",
        suffix: "\nThe plan is set. The plan is late.\nShip it.",
      },
    });
    // Shown at once, while it is on its way.
    const panel = await screen.findByRole("complementary", { name: "Comments" });
    expect(within(panel).getByText("Sending…")).toBeInTheDocument();
    await act(async () => answer(comment()));
    expect(within(panel).queryByText("Sending…")).not.toBeInTheDocument();
    expect(within(panel).getByText("Shorter here?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Comments, 1 open" })).toBeInTheDocument();
    // A comment is not an edit.
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
  });

  it("rolls a refused thread back", async () => {
    passage.current = {
      text: "Intro text.",
      headingPath: ["The brief"],
      range: { anchor: at([1, 0]), focus: at([1, 0], 11) },
    };
    api.createDocumentComment.mockRejectedValue(new ApiError("Too many", { status: 429 }));
    renderCanvas();
    await screen.findByRole("heading", { level: 1, name: "The brief" });
    const trigger = within(screen.getByRole("toolbar", { name: "Formatting" })).getByRole(
      "button",
      {
        name: "Comment",
      },
    );
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "touch" });
    fireEvent.click(trigger);
    const field = await screen.findByLabelText("Comment on the selected text");
    fireEvent.change(field, { target: { value: "Nope" } });
    fireEvent.keyDown(field, { key: "Enter", metaKey: true });
    const panel = await screen.findByRole("complementary", { name: "Comments" });
    await waitFor(() => expect(within(panel).queryByText("Nope")).not.toBeInTheDocument());
    expect(within(panel).getByText("No comments yet")).toBeInTheDocument();
  });

  it("lists open threads with replies, says which are detached, and folds the resolved ones", async () => {
    api.listDocumentComments.mockResolvedValue([
      comment(),
      comment({ id: "r1", parentId: "c1", anchor: null, body: "Agreed.", author: "agent" }),
      comment({
        id: "c2",
        anchor: { quote: "A passage that is gone", prefix: "", suffix: "" },
        body: "Old note",
      }),
      comment({
        id: "c3",
        status: "resolved",
        resolvedBy: "user",
        anchor: { quote: "Ship it.", prefix: "", suffix: "" },
        body: "Done",
      }),
    ]);
    renderCanvas();
    await screen.findByRole("heading", { level: 1, name: "The brief" });
    expect(await screen.findByRole("button", { name: "Comments, 2 open" })).toBeInTheDocument();
    const panel = await openPanel();

    const first = threadCard(panel, "Intro text.");
    expect(within(first).getByText("Shorter here?")).toBeInTheDocument();
    expect(within(first).getByText("Agreed.")).toBeInTheDocument();
    // Edit and Delete only on one's own comments: the agent's reply has none.
    expect(
      within(first).getByRole("button", { name: "More actions on this thread" }),
    ).toBeInTheDocument();
    expect(within(first).queryByRole("button", { name: "More actions on this reply" })).toBeNull();
    expect(within(first).queryByText(/Detached/)).not.toBeInTheDocument();
    const gone = threadCard(panel, "A passage that is gone");
    expect(await within(gone).findByText(/Detached/)).toBeInTheDocument();

    const folded = within(panel).getByRole("button", { name: "Resolved (1)" });
    expect(within(panel).queryByText("Done")).not.toBeInTheDocument();
    fireEvent.click(folded);
    expect(within(panel).getByText("Done")).toBeInTheDocument();
    expect(within(panel).getByText(/Resolved by you/)).toBeInTheDocument();
  });

  it("replies, resolves and reopens, rolling back a refused change", async () => {
    api.listDocumentComments.mockResolvedValue([comment()]);
    api.createDocumentComment.mockImplementation(async (_u, _c, draft) =>
      comment({ id: "r9", parentId: draft.parentId, anchor: null, body: draft.body }),
    );
    renderCanvas();
    await screen.findByRole("heading", { level: 1, name: "The brief" });
    const panel = await openPanel();
    const card = threadCard(panel, "Intro text.");

    fireEvent.click(within(card).getByRole("button", { name: "Reply…" }));
    const field = within(card).getByLabelText("Reply to the thread");
    fireEvent.change(field, { target: { value: "On it." } });
    fireEvent.click(within(card).getByRole("button", { name: "Reply" }));
    await waitFor(() =>
      expect(api.createDocumentComment).toHaveBeenCalledWith("user-1", "conv-1", {
        path: PATH,
        version: 2,
        parentId: "c1",
        body: "On it.",
      }),
    );
    expect(await within(card).findByText("On it.")).toBeInTheDocument();

    // A refused resolve comes back open.
    api.updateDocumentComment.mockRejectedValueOnce(new ApiError("Down", { status: 503 }));
    fireEvent.click(within(card).getByRole("button", { name: "Resolve thread" }));
    await waitFor(() => expect(api.updateDocumentComment).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("button", { name: "Comments, 1 open" })).toBeInTheDocument();
    expect(threadCard(panel, "Intro text.")).toBeInTheDocument();

    api.updateDocumentComment.mockImplementation(async (_u, _c, _id, patch) =>
      comment({ ...patch, resolvedBy: patch.status === "resolved" ? "user" : null }),
    );
    fireEvent.click(
      within(threadCard(panel, "Intro text.")).getByRole("button", { name: "Resolve thread" }),
    );
    expect(api.updateDocumentComment).toHaveBeenLastCalledWith("user-1", "conv-1", "c1", {
      status: "resolved",
    });
    expect(await within(panel).findByText("No open comments")).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "Resolved (1)" }));
    fireEvent.click(within(panel).getByRole("button", { name: "Reopen" }));
    expect(api.updateDocumentComment).toHaveBeenLastCalledWith("user-1", "conv-1", "c1", {
      status: "open",
    });
    expect(await screen.findByRole("button", { name: "Comments, 1 open" })).toBeInTheDocument();
  });

  it("edits and deletes one's own comment after a confirmation", async () => {
    api.listDocumentComments.mockResolvedValue([comment()]);
    api.updateDocumentComment.mockImplementation(async (_u, _c, _id, patch) => comment(patch));
    api.deleteDocumentComment.mockResolvedValue(undefined);
    renderCanvas();
    await screen.findByRole("heading", { level: 1, name: "The brief" });
    const panel = await openPanel();
    const card = () => threadCard(panel, "Intro text.");
    const openMore = () => {
      const trigger = within(card()).getByRole("button", { name: "More actions on this thread" });
      fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    };

    openMore();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
    const field = within(card()).getByLabelText("Edit the comment");
    fireEvent.change(field, { target: { value: "Much shorter here?" } });
    fireEvent.click(within(card()).getByRole("button", { name: "Save" }));
    expect(api.updateDocumentComment).toHaveBeenCalledWith("user-1", "conv-1", "c1", {
      body: "Much shorter here?",
    });
    expect(await within(card()).findByText("Much shorter here?")).toBeInTheDocument();

    openMore();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const confirm = within(card()).getByRole("alertdialog", { name: "Delete this thread?" });
    expect(api.deleteDocumentComment).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(api.deleteDocumentComment).toHaveBeenCalledWith("user-1", "conv-1", "c1"),
    );
    expect(await within(panel).findByText("No comments yet")).toBeInTheDocument();
  });

  it("offers Comment while reading, and none of it marks the document unsaved", async () => {
    passage.current = {
      text: "Intro text.",
      headingPath: ["The brief"],
      range: { anchor: at([1, 0]), focus: at([1, 0], 11) },
    };
    renderCanvas({ compact: true });
    await screen.findByRole("heading", { level: 1, name: "The brief" });
    expect(screen.queryByRole("toolbar", { name: "Formatting" })).not.toBeInTheDocument();
    const bar = await screen.findByRole("toolbar", { name: "Selection" });
    expect(within(bar).getByRole("button", { name: "Comment" })).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

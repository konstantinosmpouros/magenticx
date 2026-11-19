// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SlateEditor, Value } from "platejs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Suggesting mode (plan 44, Phase 4.6): the USER's edits become suggestions.
 *
 * Pinned: typing and deleting in Suggesting (Plate's `SuggestionPlugin` on
 * the canvas editor) leave the document's text as it was and build the
 * proposal; Editing changes the text directly; the two texts a value stands
 * for (base = every suggestion rejected, proposed = every one accepted); a
 * saved set drawn word by word; rebasing onto a newer version; the
 * suggestion saver (PUT, DELETE, a moved base); the remembered mode; and in
 * the canvas — Save PUTs the set (no version), unsaved suggestions guard a
 * close, a pending set drawn in any mode, Accept one / Accept all saving the
 * right markdown as ONE version then the rest of the set, Reject all
 * deleting it with no version, a 409 opening the conflict dialog, a set
 * rebased, set aside as stale (Discard), or cleared when the latest already
 * says it, and the agent's versions loading directly (no review).
 */

const { api, editors } = vi.hoisted(() => ({
  api: {
    listConversationDocuments: vi.fn(),
    getLatestDocument: vi.fn(),
    listDocumentVersions: vi.fn(),
    getDocumentVersion: vi.fn(),
    saveDocumentVersion: vi.fn(),
    listDocumentComments: vi.fn(),
    getDocumentSuggestion: vi.fn(),
    putDocumentSuggestion: vi.fn(),
    deleteDocumentSuggestion: vi.fn(),
  },
  // Every editor the canvas mounts, so a test can type into the live one.
  editors: [] as unknown[],
}));
vi.mock("@/shared/lib/api", () => api);
vi.mock("platejs/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("platejs/react")>();
  return {
    ...actual,
    usePlateEditor: ((...args: Parameters<typeof actual.usePlateEditor>) => {
      const editor = actual.usePlateEditor(...args);
      if (!editors.includes(editor)) editors.push(editor);
      return editor;
    }) as typeof actual.usePlateEditor,
  };
});

import DocumentCanvas from "@/features/canvas/components/DocumentCanvas";
import { createCanvasEditor } from "@/features/canvas/lib/editorKit";
import { markdownToValue, normalizeMarkdown } from "@/features/canvas/lib/markdown";
import { loadCanvasMode, saveCanvasMode } from "@/features/canvas/lib/modeStorage";
import { SuggestionSaver } from "@/features/canvas/lib/suggestionSaver";
import {
  decideSuggestions,
  editorTexts,
  listSuggestions,
  rebaseProposed,
  setSuggesting,
  suggestionValue,
} from "@/features/canvas/lib/suggestions";
import type {
  CanvasDocumentAuthor,
  CanvasDocumentVersion,
  CanvasDocumentVersionMeta,
} from "@/shared/lib/types";
import { TooltipProvider } from "@/shared/ui/tooltip";

const PATH = "/conversation/output/brief.md";
const MODE_KEY = "mx_canvas_mode:user-1:desktop";

const BASE = "# Brief\n\nWe will cover everything.\n\n## Budget\n\nTen thousand.\n";
const PROPOSED =
  "# Brief\n\nWe cover the EU market only.\n\n## Budget\n\nTen thousand.\n\n## Risks\n\nTiming.\n";

/** A point in a text leaf. */
const at = (path: number[], offset = 0) => ({ path, offset });

/** A leaf's suggestion kind and text, for a block's children. */
const pieces = (value: Value, block: number) =>
  (value[block] as { children: Array<Record<string, unknown>> }).children.map((leaf) => {
    const key = Object.keys(leaf).find((name) => name.startsWith("suggestion_"));
    const data = key ? (leaf[key] as { type: string }) : null;
    return [data?.type ?? "same", leaf.text];
  });

// -- Typing in Suggesting ----------------------------------------------------------

describe("typing in Suggesting mode", () => {
  const suggestingEditor = (markdown = BASE) => {
    const editor = createCanvasEditor(markdownToValue(markdown));
    setSuggesting(editor, true);
    return editor;
  };

  it("marks inserted and deleted text and leaves the document's text as it was", () => {
    const editor = suggestingEditor();
    // "We will cover everything." — add " Soon" at the end, delete "will ".
    editor.tf.select(editor.api.end([1])!);
    editor.tf.insertText(" Soon");
    editor.tf.select({ anchor: at([1, 0], 3), focus: at([1, 0], 8) });
    editor.tf.deleteFragment();

    const texts = editorTexts(editor.children);
    expect(texts.text).toBe(normalizeMarkdown(BASE));
    expect(texts.proposed).toBe(
      "# Brief\n\nWe cover everything. Soon\n\n## Budget\n\nTen thousand.\n",
    );
    expect(pieces(editor.children, 1)).toEqual([
      ["same", "We "],
      ["remove", "will "],
      ["same", "cover everything."],
      ["insert", " Soon"],
    ]);
    expect(listSuggestions(editor.children).map((item) => [item.kind, item.summary])).toEqual([
      ["remove", "will"],
      ["insert", "Soon"],
    ]);
  });

  it("Backspace marks a character for removal instead of deleting it; Enter in a heading is a suggested line break", () => {
    const editor = suggestingEditor();
    editor.tf.select(editor.api.end([3])!); // "Ten thousand."
    editor.tf.deleteBackward("character");
    expect(editorTexts(editor.children)).toEqual({
      text: normalizeMarkdown(BASE),
      proposed: "# Brief\n\nWe will cover everything.\n\n## Budget\n\nTen thousand\n",
    });

    const heading = suggestingEditor();
    heading.tf.select(at([2, 0], 3)); // "Bud|get"
    heading.tf.insertBreak();
    expect(heading.children).toHaveLength(5);
    const texts = editorTexts(heading.children);
    expect(texts.text).toBe(normalizeMarkdown(BASE));
    expect(texts.proposed).toContain("## Bud\n\n");
    expect(texts.proposed).not.toContain("\\");
  });

  it("deleting the user's own insertion removes it outright, leaving nothing suggested", () => {
    const editor = suggestingEditor();
    editor.tf.select(editor.api.end([1])!);
    editor.tf.insertText("!");
    editor.tf.deleteBackward("character");
    expect(editorTexts(editor.children)).toEqual({ text: normalizeMarkdown(BASE), proposed: null });
    expect(listSuggestions(editor.children)).toEqual([]);
  });

  it("Editing is unaffected: the text changes directly, nothing is suggested", () => {
    const editor = createCanvasEditor(markdownToValue(BASE));
    editor.tf.select(editor.api.end([1])!);
    editor.tf.insertText(" Soon");
    const texts = editorTexts(editor.children);
    expect(texts.proposed).toBeNull();
    expect(texts.text).toContain("We will cover everything. Soon");
  });
});

// -- The two texts, and a saved set drawn --------------------------------------------

describe("a saved set: base + proposed", () => {
  it("is drawn word by word over the base, and gives back both texts exactly", () => {
    const value = suggestionValue(BASE, PROPOSED);
    expect(pieces(value, 1)).toEqual([
      ["same", "We "],
      ["remove", "will "],
      ["same", "cover "],
      ["remove", "everything"],
      ["insert", "the EU market only"],
      ["same", "."],
    ]);
    expect(editorTexts(value)).toEqual({
      text: normalizeMarkdown(BASE),
      proposed: normalizeMarkdown(PROPOSED),
    });
    expect(listSuggestions(value).map((item) => item.kind)).toEqual([
      "remove",
      "replace",
      "insert",
    ]);
    expect(listSuggestions(value)[2].summary).toBe("Risks Timing.");
  });

  it("all rejected is the base, all accepted the proposal, one accepted only that one", () => {
    const rejectAll = createCanvasEditor(suggestionValue(BASE, PROPOSED));
    decideSuggestions(
      rejectAll,
      listSuggestions(rejectAll.children).map((item) => item.id),
      "reject",
    );
    expect(editorTexts(rejectAll.children)).toEqual({
      text: normalizeMarkdown(BASE),
      proposed: null,
    });

    const acceptAll = createCanvasEditor(suggestionValue(BASE, PROPOSED));
    decideSuggestions(
      acceptAll,
      listSuggestions(acceptAll.children).map((item) => item.id),
      "accept",
    );
    expect(editorTexts(acceptAll.children)).toEqual({
      text: normalizeMarkdown(PROPOSED),
      proposed: null,
    });

    const one = createCanvasEditor(suggestionValue(BASE, PROPOSED));
    const risks = listSuggestions(one.children).find((item) => item.kind === "insert")!;
    decideSuggestions(one, [risks.id], "accept");
    expect(editorTexts(one.children)).toEqual({
      text: "# Brief\n\nWe will cover everything.\n\n## Budget\n\nTen thousand.\n\n## Risks\n\nTiming.\n",
      proposed: normalizeMarkdown(PROPOSED),
    });
  });

  it("keeps marks and links on the words around a change", () => {
    const base = "Read **the old** [guide](https://example.com).\n";
    const proposed = "Read **the new** [guide](https://example.com).\n";
    const value = suggestionValue(base, proposed);
    expect(editorTexts(value)).toEqual({ text: base, proposed });
    const children = (value[0] as { children: Array<Record<string, unknown>> }).children;
    expect(children.find((child) => child.type === "a")).toMatchObject({
      url: "https://example.com",
    });
  });
});

describe("rebasing onto a newer version", () => {
  it("carries the user's changes onto the agent's, or gives up when they touch the same line", () => {
    const latest = BASE.replace("Ten thousand.", "Twelve thousand.");
    const proposed = BASE.replace("We will cover everything.", "We cover the EU only.");
    expect(rebaseProposed(BASE, proposed, latest)).toBe(
      normalizeMarkdown(latest.replace("We will cover everything.", "We cover the EU only.")),
    );
    const clash = BASE.replace("We will cover everything.", "We cover Asia.");
    expect(rebaseProposed(BASE, proposed, clash)).toBeNull();
    expect(rebaseProposed(BASE, proposed, BASE)).toBe(normalizeMarkdown(proposed));
  });
});

describe("the suggestion saver", () => {
  const make = (clean: string | null, serverBase: number | null) => {
    const put = vi.fn(async (content: string, baseVersion: number) => ({
      path: PATH,
      baseVersion,
      content,
      updatedAt: "",
    }));
    const remove = vi.fn(async () => undefined);
    const saver = new SuggestionSaver({ clean, serverBase }, { put, remove, onState: vi.fn() });
    let proposed: string | null = clean;
    saver.attach(() => proposed);
    return { saver, put, remove, set: (text: string | null) => (proposed = text) };
  };

  it("PUTs a changed set, deletes an emptied one, and PUTs again when the base moved", async () => {
    const { saver, put, remove, set } = make(null, null);
    expect(saver.isDirty()).toBe(false);
    set("proposed A");
    expect(saver.isDirty()).toBe(true);
    await saver.flush(3);
    expect(put).toHaveBeenCalledWith("proposed A", 3);
    expect(saver.isDirty()).toBe(false);

    await saver.flush(3);
    expect(put).toHaveBeenCalledTimes(1); // nothing changed
    await saver.flush(4, true);
    expect(put).toHaveBeenLastCalledWith("proposed A", 4); // the base moved

    set(null);
    await saver.flush(4);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(saver.isDirty()).toBe(false);
  });

  it("a set the server dropped (the agent reviewed it) goes when unchanged, stays unsaved when not", async () => {
    const unchanged = make("proposed A", 2);
    expect(unchanged.saver.serverCleared()).toBe(true);
    expect(unchanged.saver.savedBase).toBeNull();
    expect(unchanged.saver.snapshot.status).toBe("saved");
    // Nothing held any more: a second clear has nothing to do.
    expect(unchanged.saver.serverCleared()).toBe(false);
    expect(unchanged.remove).not.toHaveBeenCalled();

    const changed = make("proposed A", 2);
    changed.set("proposed A, then more");
    expect(changed.saver.serverCleared()).toBe(false);
    expect(changed.saver.isDirty()).toBe(true);
    await changed.saver.flush(2);
    expect(changed.put).toHaveBeenCalledWith("proposed A, then more", 2);

    expect(make(null, null).saver.serverCleared()).toBe(false);
  });

  it("a failed save stays unsaved with its message", async () => {
    const { saver, put, set } = make(null, null);
    put.mockRejectedValueOnce(new Error("Saving too often."));
    set("proposed A");
    await saver.flush(1);
    expect(saver.snapshot).toEqual({ status: "failed", errorMessage: "Saving too often." });
    expect(saver.isDirty()).toBe(true);
  });
});

describe("the remembered mode", () => {
  it("is kept per user and layout, and anything unknown reads as nothing", () => {
    saveCanvasMode("user-1", "desktop", "suggesting");
    expect(loadCanvasMode("user-1", "desktop")).toBe("suggesting");
    expect(loadCanvasMode("user-1", "phone")).toBeNull();
    expect(loadCanvasMode("user-2", "desktop")).toBeNull();
    localStorage.setItem(MODE_KEY, "shouting");
    expect(loadCanvasMode("user-1", "desktop")).toBeNull();
  });

  it("works without storage", () => {
    const real = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get: () => {
        throw new Error("blocked");
      },
    });
    try {
      expect(() => saveCanvasMode("user-1", "desktop", "viewing")).not.toThrow();
      expect(loadCanvasMode("user-1", "desktop")).toBeNull();
    } finally {
      if (real) Object.defineProperty(window, "localStorage", real);
    }
  });
});

// -- The canvas -----------------------------------------------------------------------

const version = (
  n: number,
  content: string,
  author: CanvasDocumentAuthor = "agent",
): CanvasDocumentVersion => ({
  path: PATH,
  name: "brief.md",
  version: n,
  author,
  baseVersion: n > 1 ? n - 1 : null,
  createdAt: "2026-11-19T09:40:00Z",
  sizeBytes: content.length,
  content,
});

const meta = (n: number, author: CanvasDocumentAuthor): CanvasDocumentVersionMeta => ({
  version: n,
  author,
  baseVersion: n > 1 ? n - 1 : null,
  createdAt: "2026-11-19T09:40:00Z",
  sizeBytes: 10,
});

/** The document's versions, oldest first; the latest is the last one. */
function serve(versions: Array<{ content: string; author: CanvasDocumentAuthor }>) {
  const all = versions.map((item, index) => version(index + 1, item.content, item.author));
  const latest = all[all.length - 1];
  api.getLatestDocument.mockResolvedValue(latest);
  api.listConversationDocuments.mockResolvedValue([
    {
      path: PATH,
      name: "brief.md",
      version: latest.version,
      author: latest.author,
      updatedAt: "",
      sizeBytes: 9,
    },
  ]);
  api.listDocumentVersions.mockResolvedValue(
    [...all].reverse().map((item) => meta(item.version, item.author)),
  );
  api.getDocumentVersion.mockImplementation(
    async (_u: string, _c: string, _p: string, n: number) => all[n - 1],
  );
  return latest;
}

/** The server's pending set: the proposed text on version `baseVersion`. */
const pending = (baseVersion: number, content: string) =>
  api.getDocumentSuggestion.mockResolvedValue({ path: PATH, baseVersion, content, updatedAt: "" });

function renderCanvas() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  const tree = (revision: string, runActive = false) => (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <DocumentCanvas
          userId="user-1"
          conversationId="conv-1"
          path={PATH}
          revision={revision}
          runActive={runActive}
          compact={false}
          canToggleFullscreen
          fullscreen={false}
          onPreviewFile={null}
          onSelectPath={vi.fn()}
          onClose={onClose}
          onToggleFullscreen={vi.fn()}
        />
      </TooltipProvider>
    </QueryClientProvider>
  );
  const view = render(tree("0"));
  return {
    ...view,
    onClose,
    newRevision: (revision: string) => view.rerender(tree(revision)),
    /** A run of the conversation starts (true) or ends (false), at `revision`. */
    run: (revision: string, active: boolean) => view.rerender(tree(revision, active)),
  };
}

/** The live editor of the open document. */
const liveEditor = () => editors[editors.length - 1] as SlateEditor;

const bar = () => screen.findByRole("region", { name: "Your suggestions" });

beforeEach(() => {
  editors.length = 0;
  for (const fn of Object.values(api)) fn.mockReset();
  api.listDocumentComments.mockResolvedValue([]);
  api.getDocumentSuggestion.mockResolvedValue(null);
  api.deleteDocumentSuggestion.mockResolvedValue(undefined);
  api.putDocumentSuggestion.mockImplementation(
    async (
      _u: string,
      _c: string,
      body: { path: string; baseVersion: number; content: string },
    ) => ({
      ...body,
      updatedAt: "",
    }),
  );
  api.saveDocumentVersion.mockImplementation(
    async (_u: string, _c: string, body: { baseVersion: number }) => ({
      kind: "saved",
      path: PATH,
      version: body.baseVersion + 1,
      createdAt: "2026-11-19T10:00:00Z",
    }),
  );
});
afterEach(() => localStorage.clear());

describe("Suggesting mode in the canvas", () => {
  it("offers three modes and remembers the one picked", async () => {
    serve([{ content: BASE, author: "agent" }]);
    const first = renderCanvas();
    await screen.findByRole("heading", { level: 1, name: "Brief" });
    fireEvent.keyDown(screen.getByRole("button", { name: "Mode: Editing. Change mode" }), {
      key: "Enter",
    });
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "EditingChange the text directly",
      "SuggestingYour edits become suggestions",
      "ViewingRead without changing it",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: /Suggesting/ }));
    expect(localStorage.getItem(MODE_KEY)).toBe("suggesting");
    expect(await screen.findByLabelText("brief, suggesting")).toHaveAttribute(
      "contenteditable",
      "true",
    );
    first.unmount();

    renderCanvas();
    expect(
      await screen.findByRole("button", { name: "Mode: Suggesting. Change mode" }),
    ).toBeInTheDocument();
  });

  it("typing in Suggesting is unsaved work; Save PUTs the set and writes no version", async () => {
    saveCanvasMode("user-1", "desktop", "suggesting");
    serve([{ content: BASE, author: "agent" }]);
    const view = renderCanvas();
    await screen.findByLabelText("brief, suggesting");
    await act(async () => {
      const editor = liveEditor();
      editor.tf.select(editor.api.end([1])!);
      editor.tf.insertText(" Soon");
    });
    // The suggestion shows at once, with the bar.
    expect(within(await bar()).getByText("1 suggestion")).toBeInTheDocument();
    expect(document.querySelector("ins")?.textContent).toBe(" Soon");

    // Unsaved: closing asks first.
    fireEvent.click(screen.getByRole("button", { name: "Close document" }));
    expect(await screen.findByText("Unsaved changes")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(view.onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() => expect(api.putDocumentSuggestion).toHaveBeenCalledTimes(1));
    expect(api.putDocumentSuggestion).toHaveBeenCalledWith("user-1", "conv-1", {
      path: PATH,
      baseVersion: 1,
      content: "# Brief\n\nWe will cover everything. Soon\n\n## Budget\n\nTen thousand.\n",
    });
    expect(api.saveDocumentVersion).not.toHaveBeenCalled();
    // Saved: closing no longer asks.
    fireEvent.click(screen.getByRole("button", { name: "Close document" }));
    expect(view.onClose).toHaveBeenCalledTimes(1);
  });

  it("draws a pending set over the latest version in any mode, with ✓ / ✕ on each", async () => {
    saveCanvasMode("user-1", "desktop", "viewing");
    serve([{ content: BASE, author: "agent" }]);
    pending(1, PROPOSED);
    renderCanvas();

    const region = await bar();
    expect(within(region).getByText("3 suggestions")).toBeInTheDocument();
    expect(within(region).getByText("Not in the document until accepted")).toBeInTheDocument();
    const editor = screen.getByLabelText("brief, read-only");
    expect([...editor.querySelectorAll("del")].map((el) => el.textContent)).toEqual([
      "will ",
      "everything",
    ]);
    expect(editor.querySelector("ins")?.textContent).toBe("the EU market only");
    expect(editor.querySelectorAll('[data-canvas-suggestion="insert"]')).toHaveLength(3);
    expect(await screen.findByRole("button", { name: /^Accept the edit/ })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Reject the addition “Risks Timing\.”/ }),
    ).toBeInTheDocument();
    expect(api.getDocumentVersion).not.toHaveBeenCalled();
  });

  it("Accept one saves ONE version with only that suggestion, then PUTs the rest on it", async () => {
    serve([{ content: BASE, author: "agent" }]);
    pending(1, PROPOSED);
    renderCanvas();
    await bar();
    fireEvent.click(await screen.findByRole("button", { name: /^Accept the addition/ }));

    await waitFor(() => expect(api.putDocumentSuggestion).toHaveBeenCalledTimes(1));
    expect(api.saveDocumentVersion).toHaveBeenCalledTimes(1);
    expect(api.saveDocumentVersion).toHaveBeenCalledWith("user-1", "conv-1", {
      path: PATH,
      baseVersion: 1,
      content:
        "# Brief\n\nWe will cover everything.\n\n## Budget\n\nTen thousand.\n\n## Risks\n\nTiming.\n",
    });
    expect(api.putDocumentSuggestion).toHaveBeenCalledWith("user-1", "conv-1", {
      path: PATH,
      baseVersion: 2,
      content: normalizeMarkdown(PROPOSED),
    });
    expect(within(await bar()).getByText("2 suggestions")).toBeInTheDocument();
  });

  it("Accept all saves the proposed text as one version and deletes the set", async () => {
    serve([{ content: BASE, author: "agent" }]);
    pending(1, PROPOSED);
    renderCanvas();
    await bar();
    fireEvent.click(screen.getByRole("button", { name: "Accept all" }));

    await waitFor(() => expect(api.deleteDocumentSuggestion).toHaveBeenCalledTimes(1));
    expect(api.saveDocumentVersion).toHaveBeenCalledTimes(1);
    expect(api.saveDocumentVersion.mock.calls[0][2]).toEqual({
      path: PATH,
      baseVersion: 1,
      content: normalizeMarkdown(PROPOSED),
    });
    expect(api.putDocumentSuggestion).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Your suggestions" })).toBeNull(),
    );
    expect(document.querySelector("[data-slate-editor] ins, [data-slate-editor] del")).toBeNull();
  });

  it("Reject all deletes the set and writes no version", async () => {
    serve([{ content: BASE, author: "agent" }]);
    pending(1, PROPOSED);
    renderCanvas();
    await bar();
    fireEvent.click(screen.getByRole("button", { name: "Reject all" }));

    await waitFor(() => expect(api.deleteDocumentSuggestion).toHaveBeenCalledTimes(1));
    expect(api.deleteDocumentSuggestion).toHaveBeenCalledWith("user-1", "conv-1", PATH);
    expect(api.saveDocumentVersion).not.toHaveBeenCalled();
    expect(api.putDocumentSuggestion).not.toHaveBeenCalled();
    const editor = screen.getByLabelText("brief, editing");
    expect(editor.textContent).toContain("We will cover everything.");
    expect(editor.querySelector("ins, del")).toBeNull();
  });

  it("an accept refused with 409 opens the conflict dialog and keeps the set", async () => {
    serve([{ content: BASE, author: "agent" }]);
    pending(1, PROPOSED);
    api.saveDocumentVersion.mockResolvedValueOnce({
      kind: "conflict",
      currentVersion: 2,
      currentContent: "# Brief\n\nNewer.\n",
    });
    renderCanvas();
    await bar();
    fireEvent.click(screen.getByRole("button", { name: "Accept all" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent(/saved version 2/);
    expect(screen.getByRole("button", { name: "Keep mine" })).toBeInTheDocument();
    expect(api.deleteDocumentSuggestion).not.toHaveBeenCalled();
    expect(api.putDocumentSuggestion).not.toHaveBeenCalled();
  });

  it("rebases a set made on an older version onto the agent's newer one", async () => {
    const latestText = BASE.replace("Ten thousand.", "Twelve thousand.");
    serve([
      { content: BASE, author: "user" },
      { content: latestText, author: "agent" },
    ]);
    pending(1, BASE.replace("We will cover everything.", "We cover the EU only."));
    renderCanvas();

    expect(within(await bar()).getByText("2 suggestions")).toBeInTheDocument();
    expect(api.getDocumentVersion).toHaveBeenCalledWith(
      "user-1",
      "conv-1",
      PATH,
      1,
      expect.anything(),
    );
    const editor = screen.getByLabelText("brief, editing");
    expect(editor.textContent).toContain("Twelve thousand.");
    expect([...editor.querySelectorAll("del")].map((el) => el.textContent)).toEqual([
      "will ",
      "everything",
    ]);
    expect([...editor.querySelectorAll("ins")].map((el) => el.textContent)).toEqual([
      "the EU only",
    ]);
    // Nothing unsaved: the server's set stands for the same changes.
    expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
  });

  it("shows a set that no longer fits read-only over its base, until Discard deletes it", async () => {
    serve([
      { content: BASE, author: "user" },
      { content: BASE.replace("We will cover everything.", "We cover Asia."), author: "agent" },
    ]);
    pending(1, BASE.replace("We will cover everything.", "We cover the EU only."));
    renderCanvas();

    expect(
      await screen.findByText(/The document changed since your suggestions on v1/),
    ).toBeInTheDocument();
    // Over v1's text, which still says "everything": the user's words read against it.
    const stale = screen.getByLabelText("brief, read-only");
    expect([...stale.querySelectorAll("del")].map((el) => el.textContent)).toEqual([
      "will ",
      "everything",
    ]);
    expect(stale.querySelector("ins")?.textContent).toBe("the EU only");
    expect(screen.queryByRole("region", { name: "Your suggestions" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(api.deleteDocumentSuggestion).toHaveBeenCalledTimes(1));
    const editor = await screen.findByLabelText("brief, editing");
    expect(editor.textContent).toContain("We cover Asia.");
    expect(editor.querySelector("ins, del")).toBeNull();
  });

  it("clears the set silently when the latest version already says it", async () => {
    serve([
      { content: BASE, author: "user" },
      { content: PROPOSED, author: "agent" },
    ]);
    pending(1, PROPOSED);
    renderCanvas();
    const editor = await screen.findByLabelText("brief, editing");
    await waitFor(() => expect(api.deleteDocumentSuggestion).toHaveBeenCalledTimes(1));
    expect(editor.querySelector("ins, del")).toBeNull();
    expect(screen.queryByRole("region", { name: "Your suggestions" })).toBeNull();
  });

  it("loads the agent's versions directly in every mode — never held for review", async () => {
    saveCanvasMode("user-1", "desktop", "suggesting");
    serve([{ content: BASE, author: "user" }]);
    const view = renderCanvas();
    await screen.findByLabelText("brief, suggesting");

    serve([
      { content: BASE, author: "user" },
      { content: PROPOSED, author: "agent" },
    ]);
    view.newRevision("1");
    await waitFor(() =>
      expect(screen.getByLabelText("brief, suggesting").textContent).toContain(
        "We cover the EU market only.",
      ),
    );
    expect(document.querySelector("[data-slate-editor] ins, [data-slate-editor] del")).toBeNull();
    expect(screen.queryByRole("region", { name: "Your suggestions" })).toBeNull();
    expect(api.saveDocumentVersion).not.toHaveBeenCalled();
  });

  it("carries a pending set onto an agent version that arrives while open", async () => {
    serve([{ content: BASE, author: "agent" }]);
    pending(1, BASE.replace("We will cover everything.", "We cover the EU only."));
    const view = renderCanvas();
    expect(within(await bar()).getByText("2 suggestions")).toBeInTheDocument();

    serve([
      { content: BASE, author: "agent" },
      { content: BASE.replace("Ten thousand.", "Twelve thousand."), author: "agent" },
    ]);
    view.newRevision("1");
    await waitFor(() =>
      expect(screen.getByLabelText("brief, editing").textContent).toContain("Twelve thousand."),
    );
    expect(within(await bar()).getByText("2 suggestions")).toBeInTheDocument();
    expect(document.querySelector("[data-slate-editor] ins")?.textContent).toBe("the EU only");
  });

  it("a run that ends re-reads the set: rejected by the agent, it goes with no version", async () => {
    serve([{ content: BASE, author: "agent" }]);
    pending(1, PROPOSED);
    const view = renderCanvas();
    expect(within(await bar()).getByText("3 suggestions")).toBeInTheDocument();

    view.run("1", true);
    api.getDocumentSuggestion.mockResolvedValue(null); // the agent rejected them
    view.run("2", false);

    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Your suggestions" })).toBeNull(),
    );
    const editor = screen.getByLabelText("brief, editing");
    expect(editor.textContent).toContain("We will cover everything.");
    expect(editor.querySelector("ins, del")).toBeNull();
    // The server already dropped it: nothing deleted or saved from here.
    expect(api.deleteDocumentSuggestion).not.toHaveBeenCalled();
    expect(api.putDocumentSuggestion).not.toHaveBeenCalled();
    expect(api.saveDocumentVersion).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
  });

  it("a run that ends re-reads the set: accepted by the agent, its version shows with no suggestion", async () => {
    serve([{ content: BASE, author: "agent" }]);
    pending(1, PROPOSED);
    const view = renderCanvas();
    expect(within(await bar()).getByText("3 suggestions")).toBeInTheDocument();

    view.run("1", true);
    serve([
      { content: BASE, author: "agent" },
      { content: PROPOSED, author: "agent" },
    ]);
    api.getDocumentSuggestion.mockResolvedValue(null);
    view.run("2", false);

    await waitFor(() =>
      expect(screen.getByLabelText("brief, editing").textContent).toContain(
        "We cover the EU market only.",
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Your suggestions" })).toBeNull(),
    );
    expect(document.querySelector("[data-slate-editor] ins, [data-slate-editor] del")).toBeNull();
    expect(api.putDocumentSuggestion).not.toHaveBeenCalled();
    expect(api.saveDocumentVersion).not.toHaveBeenCalled();
  });

  it("a run that ends with the set still there keeps it", async () => {
    serve([{ content: BASE, author: "agent" }]);
    pending(1, PROPOSED);
    const view = renderCanvas();
    expect(within(await bar()).getByText("3 suggestions")).toBeInTheDocument();
    const reads = api.getDocumentSuggestion.mock.calls.length;

    view.run("1", true);
    view.run("2", false);

    await waitFor(() => expect(api.getDocumentSuggestion.mock.calls.length).toBe(reads + 1));
    expect(within(await bar()).getByText("3 suggestions")).toBeInTheDocument();
  });
});

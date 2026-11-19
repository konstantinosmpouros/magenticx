// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Suggesting mode (plan 44, Phase 4.6).
 *
 * Pinned: the suggestions worked out from two versions (word level inside an
 * edited block, block level for added / removed blocks, a renumbered list
 * adding nothing), the display marks, and the text a set of decisions
 * leaves; the mode remembered per user and layout (and a storage that
 * throws); in the canvas — the agent's changes against the base (the user's
 * newest version, or the version last reviewed here), several agent versions
 * as one set, read-only while they are pending, Accept all saving nothing,
 * a rejection saving ONE user version (one rejected, all rejected), a 409 on
 * that save opening the conflict dialog, and Editing left as it was.
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
import { normalizeMarkdown } from "@/features/canvas/lib/markdown";
import {
  loadCanvasMode,
  loadReviewedVersion,
  saveCanvasMode,
} from "@/features/canvas/lib/reviewStorage";
import {
  buildSuggestions,
  resolveSuggestions,
  SUGGESTION_KEY,
  suggestionDisplay,
} from "@/features/canvas/lib/suggestions";
import type {
  CanvasDocumentAuthor,
  CanvasDocumentVersion,
  CanvasDocumentVersionMeta,
} from "@/shared/lib/types";
import { TooltipProvider } from "@/shared/ui/tooltip";

const PATH = "/conversation/output/brief.md";
const REVIEWED_KEY = `mx_canvas_reviewed:user-1:conv-1:${PATH}`;
const MODE_KEY = "mx_canvas_mode:user-1:desktop";

const BASE = "# Brief\n\nWe will cover everything.\n\n## Budget\n\nTen thousand.\n";
const AGENT =
  "# Brief\n\nWe cover the EU market only.\n\n## Budget\n\nTen thousand.\n\n## Risks\n\nTiming.\n";

/** A node's text, leaves joined. */
const textOf = (node: unknown): string => {
  const n = node as { text?: string; children?: unknown[] };
  return n.text ?? (n.children ?? []).map(textOf).join("");
};

describe("suggestions from two versions", () => {
  it("marks words inside an edited block and whole blocks the agent added", () => {
    const set = buildSuggestions(BASE, AGENT);
    expect(set.suggestions.map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: "s1", kind: "replace" },
      { id: "s2", kind: "insert" },
    ]);
    expect(set.suggestions[1].summary).toBe("Risks Timing.");

    const value = suggestionDisplay(set, {});
    const edited = value[1] as { children: Array<Record<string, unknown>> };
    const pieces = edited.children.map((leaf) => {
      const mark = leaf[SUGGESTION_KEY] as { kind: string } | undefined;
      return [mark?.kind ?? "same", leaf.text];
    });
    expect(pieces).toEqual([
      ["same", "We "],
      ["remove", "will "],
      ["same", "cover "],
      ["remove", "everything"],
      ["insert", "the EU market only"],
      ["same", "."],
    ]);
    expect(
      value.slice(-2).map((block) => (block as Record<string, unknown>)[SUGGESTION_KEY]),
    ).toEqual([
      { id: "s2", kind: "insert" },
      { id: "s2", kind: "insert" },
    ]);
  });

  it("shows a removed block struck whole, and a decided suggestion plainly", () => {
    const set = buildSuggestions(AGENT, BASE);
    expect(set.suggestions.map((item) => item.kind)).toEqual(["replace", "remove"]);
    const accepted = suggestionDisplay(set, { s1: "accept", s2: "reject" });
    expect(accepted.map(textOf)).toEqual([
      "Brief",
      "We will cover everything.",
      "Budget",
      "Ten thousand.",
      "Risks",
      "Timing.",
    ]);
    expect(JSON.stringify(accepted)).not.toContain(SUGGESTION_KEY);
  });

  it("leaves the agent's version when all are accepted, the base when all are rejected", () => {
    const set = buildSuggestions(BASE, AGENT);
    expect(resolveSuggestions(set, new Set())).toBe(normalizeMarkdown(AGENT));
    expect(resolveSuggestions(set, new Set(["s1", "s2"]))).toBe(normalizeMarkdown(BASE));
    expect(resolveSuggestions(set, new Set(["s1"]))).toBe(
      "# Brief\n\nWe will cover everything.\n\n## Budget\n\nTen thousand.\n\n## Risks\n\nTiming.\n",
    );
  });

  it("pairs an edited block among new ones by its words, and ignores a renumbered list", () => {
    const base = "# T\n\nThe quick brown fox jumps.\n";
    const agent = "# T\n\nA new opening line.\n\nThe quick red fox jumps.\n";
    expect(buildSuggestions(base, agent).suggestions.map((item) => item.kind)).toEqual([
      "insert",
      "replace",
    ]);

    const list = buildSuggestions("1. alpha\n2. beta\n", "1. new\n2. alpha\n3. beta\n");
    expect(list.suggestions).toHaveLength(1);
    expect(list.suggestions[0]).toMatchObject({ kind: "insert", summary: "new" });
    expect(buildSuggestions(BASE, BASE).suggestions).toEqual([]);
  });

  it("keeps marks and links on the words around a change", () => {
    const set = buildSuggestions(
      "Read **the old** [guide](https://example.com).\n",
      "Read **the new** [guide](https://example.com).\n",
    );
    const children = (suggestionDisplay(set, {})[0] as { children: Array<Record<string, unknown>> })
      .children;
    expect(children.filter((leaf) => leaf.bold).map((leaf) => leaf.text)).toEqual([
      "the ",
      "old",
      "new",
    ]);
    expect(children.find((child) => child.type === "a")).toMatchObject({
      url: "https://example.com",
    });
    expect(resolveSuggestions(set, new Set(["s1"]))).toBe(
      "Read **the old** [guide](https://example.com).\n",
    );
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
      expect(loadReviewedVersion("user-1", "conv-1", PATH)).toBeNull();
    } finally {
      if (real) Object.defineProperty(window, "localStorage", real);
    }
  });
});

// -- The canvas -------------------------------------------------------------------

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

/** The document's versions: text by number, newest last; the latest is the last one. */
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

function renderCanvas() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (revision: string) => (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <DocumentCanvas
          userId="user-1"
          conversationId="conv-1"
          path={PATH}
          revision={revision}
          compact={false}
          canToggleFullscreen
          fullscreen={false}
          onPreviewFile={null}
          onSelectPath={vi.fn()}
          onClose={vi.fn()}
          onToggleFullscreen={vi.fn()}
        />
      </TooltipProvider>
    </QueryClientProvider>
  );
  const view = render(tree("0"));
  return { ...view, newRevision: (revision: string) => view.rerender(tree(revision)) };
}

const bar = () => screen.findByRole("region", { name: "Suggestions from the agent" });

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.listDocumentComments.mockResolvedValue([]);
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
      "EditingEdit the document directly",
      "SuggestingReview the agent's changes before they stay",
      "ViewingRead without changing it",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: /Suggesting/ }));
    expect(localStorage.getItem(MODE_KEY)).toBe("suggesting");
    first.unmount();

    renderCanvas();
    expect(
      await screen.findByRole("button", { name: "Mode: Suggesting. Change mode" }),
    ).toBeInTheDocument();
  });

  it("shows the agent's changes since the user's last version, read-only", async () => {
    saveCanvasMode("user-1", "desktop", "suggesting");
    serve([
      { content: BASE, author: "user" },
      { content: AGENT, author: "agent" },
    ]);
    renderCanvas();

    const region = await bar();
    expect(within(region).getByText("2 suggestions from the agent")).toBeInTheDocument();
    expect(
      within(region).getByText(/Read-only until you accept or reject them/),
    ).toBeInTheDocument();
    const editor = screen.getByLabelText("brief, read-only until the suggestions are reviewed");
    expect(editor).toHaveAttribute("contenteditable", "false");
    expect([...editor.querySelectorAll("del")].map((el) => el.textContent)).toEqual([
      "will ",
      "everything",
    ]);
    expect(editor.querySelector("ins")?.textContent).toBe("the EU market only");
    expect(editor.querySelectorAll('[data-canvas-suggestion="insert"]')).toHaveLength(2);
    expect(api.getDocumentVersion).toHaveBeenCalledWith(
      "user-1",
      "conv-1",
      PATH,
      1,
      expect.anything(),
    );
    // Each suggestion has its Accept / Reject, by keyboard too.
    expect(await screen.findByRole("button", { name: /^Accept the edit/ })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Reject the addition “Risks Timing\.”/ }),
    ).toBeInTheDocument();
    // No formatting toolbar, no undo while pending.
    expect(screen.queryByRole("toolbar", { name: "Formatting" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("collapses several agent versions since the last reviewed one into one set", async () => {
    saveCanvasMode("user-1", "desktop", "suggesting");
    localStorage.setItem(REVIEWED_KEY, "1");
    serve([
      { content: BASE, author: "agent" },
      { content: BASE.replace("Ten thousand.", "Twelve thousand."), author: "agent" },
      { content: AGENT.replace("Ten thousand.", "Twelve thousand."), author: "agent" },
    ]);
    renderCanvas();
    expect(within(await bar()).getByText("3 suggestions from the agent")).toBeInTheDocument();
    expect(api.getDocumentVersion).toHaveBeenCalledWith(
      "user-1",
      "conv-1",
      PATH,
      1,
      expect.anything(),
    );
  });

  it("Accept all keeps the agent's version: nothing saved, editable again, marked reviewed", async () => {
    saveCanvasMode("user-1", "desktop", "suggesting");
    serve([
      { content: BASE, author: "user" },
      { content: AGENT, author: "agent" },
    ]);
    renderCanvas();
    await bar();
    fireEvent.click(screen.getByRole("button", { name: "Accept all" }));

    const editor = await screen.findByLabelText("brief, editing");
    expect(editor).toHaveAttribute("contenteditable", "true");
    expect(screen.queryByRole("region", { name: "Suggestions from the agent" })).toBeNull();
    expect(editor.querySelector("ins, del")).toBeNull();
    expect(editor.textContent).toContain("We cover the EU market only.");
    expect(api.saveDocumentVersion).not.toHaveBeenCalled();
    expect(localStorage.getItem(REVIEWED_KEY)).toBe("2");
  });

  it("rejecting one suggestion saves ONE version: the agent's text with it put back", async () => {
    saveCanvasMode("user-1", "desktop", "suggesting");
    serve([
      { content: BASE, author: "user" },
      { content: AGENT, author: "agent" },
    ]);
    renderCanvas();
    await bar();
    fireEvent.click(await screen.findByRole("button", { name: /^Reject the edit/ }));
    // One left: the count follows, nothing is saved yet.
    expect(await screen.findByText("1 suggestion from the agent")).toBeInTheDocument();
    expect(api.saveDocumentVersion).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: /^Accept the addition/ }));

    await waitFor(() => expect(api.saveDocumentVersion).toHaveBeenCalledTimes(1));
    expect(api.saveDocumentVersion).toHaveBeenCalledWith("user-1", "conv-1", {
      path: PATH,
      baseVersion: 2,
      content:
        "# Brief\n\nWe will cover everything.\n\n## Budget\n\nTen thousand.\n\n## Risks\n\nTiming.\n",
    });
    const editor = await screen.findByLabelText("brief, editing");
    expect(editor.textContent).toContain("We will cover everything.");
    expect(editor.textContent).toContain("Timing.");
  });

  it("Reject all saves the base's text as the user's version", async () => {
    saveCanvasMode("user-1", "desktop", "suggesting");
    localStorage.setItem(REVIEWED_KEY, "1");
    serve([
      { content: BASE, author: "agent" },
      { content: AGENT, author: "agent" },
    ]);
    renderCanvas();
    await bar();
    fireEvent.click(screen.getByRole("button", { name: "Reject all" }));
    await waitFor(() => expect(api.saveDocumentVersion).toHaveBeenCalledTimes(1));
    expect(api.saveDocumentVersion.mock.calls[0][2]).toEqual({
      path: PATH,
      baseVersion: 2,
      content: normalizeMarkdown(BASE),
    });
    expect(await screen.findByLabelText("brief, editing")).toBeInTheDocument();
    expect(localStorage.getItem(REVIEWED_KEY)).toBe("2");
  });

  it("a rejection refused with 409 opens the conflict dialog", async () => {
    saveCanvasMode("user-1", "desktop", "suggesting");
    serve([
      { content: BASE, author: "user" },
      { content: AGENT, author: "agent" },
    ]);
    api.saveDocumentVersion.mockResolvedValueOnce({
      kind: "conflict",
      currentVersion: 3,
      currentContent: "# Brief\n\nNewer.\n",
    });
    renderCanvas();
    await bar();
    fireEvent.click(screen.getByRole("button", { name: "Reject all" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent(/saved version 3/);
    expect(screen.getByRole("button", { name: "Keep mine" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep theirs" })).toBeInTheDocument();
  });

  it("turns an agent version that arrives while open into suggestions", async () => {
    saveCanvasMode("user-1", "desktop", "suggesting");
    serve([{ content: BASE, author: "user" }]);
    const view = renderCanvas();
    expect(await screen.findByLabelText("brief, editing")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Suggestions from the agent" })).toBeNull();

    serve([
      { content: BASE, author: "user" },
      { content: AGENT, author: "agent" },
    ]);
    view.newRevision("1");
    expect(within(await bar()).getByText("2 suggestions from the agent")).toBeInTheDocument();
  });

  it("Editing is unaffected: the agent's version loads as it is, editable", async () => {
    serve([
      { content: BASE, author: "user" },
      { content: AGENT, author: "agent" },
    ]);
    renderCanvas();
    const editor = await screen.findByLabelText("brief, editing");
    expect(editor).toHaveAttribute("contenteditable", "true");
    expect(editor.querySelector("ins, del")).toBeNull();
    expect(screen.queryByRole("region", { name: "Suggestions from the agent" })).toBeNull();
    // Read plainly: Suggesting will not offer this version again.
    expect(localStorage.getItem(REVIEWED_KEY)).toBe("2");

    // Switching to Suggesting now: nothing left to review, still editable.
    fireEvent.keyDown(screen.getByRole("button", { name: "Mode: Editing. Change mode" }), {
      key: "Enter",
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("menuitem", { name: /Suggesting/ }));
    });
    expect(await screen.findByLabelText("brief, editing")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Suggestions from the agent" })).toBeNull();
  });
});

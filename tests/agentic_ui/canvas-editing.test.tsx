// @vitest-environment happy-dom
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Canvas editing (plan 44, Phase 4.2).
 *
 * Pinned: the save client (POST with CSRF, snake_case body, the 201 and the
 * 409 `stale_base` both as values, anything else thrown) and its schemas; the
 * save controller's rules — nothing sent until the user saves, Discard, one save in flight with
 * the latest text queued behind it, every save based on the version the edit
 * started from, no request for unchanged text, a 409 held as a conflict that
 * Keep theirs / Keep mine resolve, Restore as a new version on the latest;
 * the editing hook's refresh rule (a newer version reloads silently with no
 * unsaved edits, and only raises the banner with them); the conflict
 * dialog's three paths; the compare diff; the link rule; and the markdown
 * the toolbar's blocks write.
 */

const { http } = vi.hoisted(() => ({ http: { requestJson: vi.fn() } }));
vi.mock("@/shared/lib/http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/lib/http")>()),
  requestJson: http.requestJson,
}));

import { saveDocumentVersion } from "@/shared/lib/api";
import { ApiError } from "@/shared/lib/http";
import { CanvasDocumentSavedSchema, CanvasStaleBaseSchema } from "@/shared/lib/schemas";
import type { CanvasDocumentVersion, CanvasSaveResult, CanvasSaveState } from "@/shared/lib/types";
import { SaveController } from "@/features/canvas/lib/saveController";
import { diffDocuments } from "@/features/canvas/lib/documentDiff";
import { normalizeLinkUrl } from "@/features/canvas/lib/editorCommands";
import { markdownToValue, valueToMarkdown } from "@/features/canvas/lib/markdown";
import { useCanvasEditing } from "@/features/canvas/hooks/useCanvasEditing";
import { CanvasConflictDialog } from "@/features/canvas/components/canvas_parts/CanvasConflictDialog";

const PATH = "/conversation/output/brief.md";

describe("save client and schemas", () => {
  beforeEach(() => http.requestJson.mockReset());

  it("posts the text with its base version, CSRF on, and maps the 201", async () => {
    http.requestJson.mockResolvedValueOnce(
      CanvasDocumentSavedSchema.parse({
        path: PATH,
        version: 4,
        created_at: "2026-11-18T10:00:00Z",
      }),
    );
    const result = await saveDocumentVersion("user-1", "conv-1", {
      path: PATH,
      baseVersion: 3,
      content: "# Brief\n",
    });
    const [url, opts] = http.requestJson.mock.calls[0];
    expect(url).toBe("/api/v1/conversations/user-1/conv-1/documents/versions");
    expect(opts).toMatchObject({
      method: "POST",
      csrf: true,
      body: { path: PATH, base_version: 3, content: "# Brief\n" },
    });
    expect(result).toEqual({
      kind: "saved",
      path: PATH,
      version: 4,
      createdAt: "2026-11-18T10:00:00Z",
    });
  });

  it("resolves a 409 stale_base to a conflict with the latest text", async () => {
    http.requestJson.mockRejectedValueOnce(
      new ApiError("The document has a newer version.", {
        status: 409,
        detailObject: {
          code: "stale_base",
          message: "The document has a newer version.",
          current_version: 5,
          current_content: "theirs\n",
        },
      }),
    );
    const result = await saveDocumentVersion("u", "c", {
      path: PATH,
      baseVersion: 3,
      content: "x",
    });
    expect(result).toEqual({ kind: "conflict", currentVersion: 5, currentContent: "theirs\n" });
  });

  it("throws a 409 without the latest text, and every other failure", async () => {
    http.requestJson.mockRejectedValueOnce(
      new ApiError("conflict", { status: 409, detailObject: { code: "stale_base" } }),
    );
    await expect(
      saveDocumentVersion("u", "c", { path: PATH, baseVersion: 1, content: "x" }),
    ).rejects.toThrow();
    http.requestJson.mockRejectedValueOnce(new ApiError("Too many", { status: 429 }));
    await expect(
      saveDocumentVersion("u", "c", { path: PATH, baseVersion: 1, content: "x" }),
    ).rejects.toThrow("Too many");
  });

  it("refuses a saved body without a version number", () => {
    expect(() => CanvasDocumentSavedSchema.parse({ path: PATH, created_at: "x" })).toThrow();
    expect(
      CanvasStaleBaseSchema.safeParse({ code: "other", current_version: 1, current_content: "" })
        .success,
    ).toBe(false);
  });
});

/** A controller over a scripted save, with every state it reported. */
function setup(results: Array<CanvasSaveResult | Error | Promise<CanvasSaveResult>> = []) {
  const calls: Array<{ content: string; base: number }> = [];
  const states: CanvasSaveState[] = [];
  let text = "base\n";
  const save = vi.fn((content: string, base: number) => {
    calls.push({ content, base });
    const scripted = results.shift();
    if (scripted instanceof Error) return Promise.reject(scripted);
    if (scripted) return Promise.resolve(scripted);
    // The server's answer: the next version after the base.
    return Promise.resolve<CanvasSaveResult>({
      kind: "saved",
      path: PATH,
      version: base + 1,
      createdAt: "now",
    });
  });
  const ctl = new SaveController(
    { version: 3, author: "agent", createdAt: "then", markdown: "base\n" },
    {
      save,
      normalize: (markdown) => markdown,
      onState: (state) => states.push(state),
    },
  );
  ctl.attach(() => text);
  return {
    ctl,
    save,
    calls,
    states,
    type: (value: string) => {
      text = value;
      ctl.edited();
    },
  };
}

describe("save controller", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("never saves on its own: only the user's save sends, based on the version edited", async () => {
    const t = setup();
    t.type("a\n");
    t.type("ab\n");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.save).not.toHaveBeenCalled();
    expect(t.ctl.snapshot.status).toBe("unsaved");
    await t.ctl.flush();
    expect(t.calls).toEqual([{ content: "ab\n", base: 3 }]);
    expect(t.ctl.snapshot.status).toBe("saved");
    expect(t.ctl.snapshot.head).toEqual({ version: 4, author: "user", createdAt: "now" });
  });

  it("never saves twice at once: a flush during a save queues the latest text on the new base", async () => {
    let release!: (result: CanvasSaveResult) => void;
    const first = new Promise<CanvasSaveResult>((resolve) => {
      release = resolve;
    });
    const t = setup([first]);
    t.type("one\n");
    const flushing = t.ctl.flush();
    expect(t.ctl.snapshot.status).toBe("saving");
    t.type("two\n");
    void t.ctl.flush();
    void t.ctl.flush();
    expect(t.save).toHaveBeenCalledTimes(1);
    release({ kind: "saved", path: PATH, version: 4, createdAt: "now" });
    await flushing;
    await vi.runAllTimersAsync();
    expect(t.calls).toEqual([
      { content: "one\n", base: 3 },
      { content: "two\n", base: 4 },
    ]);
    expect(t.ctl.snapshot.head.version).toBe(5);
    expect(t.ctl.snapshot.status).toBe("saved");
  });

  it("sends nothing when the text is unchanged (an edit undone)", async () => {
    const t = setup();
    t.type("changed\n");
    t.type("base\n");
    await vi.advanceTimersByTimeAsync(2500);
    await t.ctl.flush();
    expect(t.save).not.toHaveBeenCalled();
    expect(t.ctl.snapshot.status).toBe("saved");
  });

  it("goes back to Saved, with no Save to press, once an edit is undone (a space typed and deleted)", async () => {
    const t = setup();
    t.type("base \n");
    expect(t.ctl.snapshot.status).toBe("unsaved");
    t.type("base\n");
    expect(t.ctl.snapshot.status).toBe("unsaved");
    await vi.advanceTimersByTimeAsync(300);
    expect(t.ctl.snapshot.status).toBe("saved");
    expect(t.save).not.toHaveBeenCalled();

    // A real change stays unsaved after the pause.
    t.type("base, more\n");
    await vi.advanceTimersByTimeAsync(300);
    expect(t.ctl.snapshot.status).toBe("unsaved");
  });

  it("holds a 409 as a conflict, and Keep mine saves on the winner", async () => {
    const t = setup([{ kind: "conflict", currentVersion: 5, currentContent: "theirs\n" }]);
    t.type("mine\n");
    await t.ctl.flush();
    expect(t.ctl.snapshot.status).toBe("conflict");
    expect(t.ctl.snapshot.conflict).toEqual({
      currentVersion: 5,
      currentContent: "theirs\n",
      mine: "mine\n",
    });

    t.type("mine, more\n");
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.save).toHaveBeenCalledTimes(1);

    await t.ctl.keepMine();
    expect(t.calls[1]).toEqual({ content: "mine, more\n", base: 5 });
    expect(t.ctl.snapshot.status).toBe("saved");
    expect(t.ctl.snapshot.conflict).toBeNull();
  });

  it("Keep theirs takes the latest text and saves nothing", async () => {
    const t = setup([{ kind: "conflict", currentVersion: 5, currentContent: "theirs\n" }]);
    t.type("mine\n");
    await t.ctl.flush();
    const markdown = t.ctl.keepTheirs("agent");
    expect(markdown).toBe("theirs\n");
    expect(t.ctl.snapshot).toMatchObject({
      status: "saved",
      conflict: null,
      head: { version: 5, author: "agent" },
    });
    expect(t.save).toHaveBeenCalledTimes(1);
  });

  it("Discard drops the edits: back to the saved text, nothing sent", async () => {
    const t = setup();
    t.type("draft\n");
    expect(t.ctl.hasUnsavedWork()).toBe(true);
    expect(t.ctl.discard()).toBe("base\n");
    expect(t.ctl.snapshot.status).toBe("saved");
    expect(t.ctl.hasUnsavedWork()).toBe(false);
    await t.ctl.flush();
    expect(t.save).not.toHaveBeenCalled();
  });

  it("Discard also drops a pending conflict", async () => {
    const t = setup([{ kind: "conflict", currentVersion: 5, currentContent: "theirs\n" }]);
    t.type("mine\n");
    await t.ctl.flush();
    expect(t.ctl.discard()).toBe("base\n");
    expect(t.ctl.snapshot).toMatchObject({ status: "saved", conflict: null });
  });

  it("Restore saves the old text as a new version based on the latest", async () => {
    const t = setup();
    await t.ctl.replaceAndSave("# Old v1\n");
    expect(t.calls).toEqual([{ content: "# Old v1\n", base: 3 }]);
    expect(t.ctl.snapshot.head).toMatchObject({ version: 4, author: "user" });
  });

  it("a failed save says why and Retry sends it again", async () => {
    const t = setup([new Error("Saving too often.")]);
    t.type("x\n");
    await t.ctl.flush();
    expect(t.ctl.snapshot).toMatchObject({ status: "failed", errorMessage: "Saving too often." });
    await t.ctl.flush();
    expect(t.calls).toHaveLength(2);
    expect(t.ctl.snapshot.status).toBe("saved");
  });
});

describe("editing hook: a newer version from outside", () => {
  const version = (n: number, content: string): CanvasDocumentVersion => ({
    path: PATH,
    name: "brief.md",
    version: n,
    author: "agent",
    baseVersion: n - 1,
    createdAt: "2026-11-18T09:40:00Z",
    sizeBytes: content.length,
    content,
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
  );
  const mount = () =>
    renderHook(
      ({ latest }: { latest: CanvasDocumentVersion | null }) =>
        useCanvasEditing({
          userId: "u",
          conversationId: "c",
          path: PATH,
          latest,
          authorOf: () => "agent",
        }),
      { wrapper, initialProps: { latest: version(4, "# Brief\n\nOld.\n") } },
    );

  it("reloads silently when the user has no unsaved edits", () => {
    const hook = mount();
    expect(hook.result.current.source).toEqual({ key: 0, markdown: "# Brief\n\nOld.\n" });
    hook.rerender({ latest: version(5, "# Brief\n\nNew.\n") });
    // The agent's version: the previous text comes along, so what changed shines.
    expect(hook.result.current.source).toEqual({
      key: 1,
      markdown: "# Brief\n\nNew.\n",
      previous: "# Brief\n\nOld.\n",
    });
    expect(hook.result.current.incoming).toBeNull();
    expect(hook.result.current.save?.head.version).toBe(5);
  });

  it("raises the banner instead when the user has unsaved edits, and Review opens the conflict", () => {
    const hook = mount();
    act(() => hook.result.current.attach(() => "# Brief\n\nMine.\n"));
    act(() => hook.result.current.edited());
    hook.rerender({ latest: version(5, "# Brief\n\nNew.\n") });
    expect(hook.result.current.source?.key).toBe(0);
    expect(hook.result.current.incoming?.version).toBe(5);
    act(() => hook.result.current.reviewIncoming());
    expect(hook.result.current.save?.status).toBe("conflict");
    expect(hook.result.current.save?.conflict).toMatchObject({
      currentVersion: 5,
      mine: "# Brief\n\nMine.\n",
    });
    expect(hook.result.current.incoming).toBeNull();
  });
});

describe("conflict dialog", () => {
  it("offers Compare, Keep theirs and Keep mine, naming who saved", () => {
    const onCompare = vi.fn();
    const onKeepTheirs = vi.fn();
    const onKeepMine = vi.fn();
    render(
      <CanvasConflictDialog
        open
        version={5}
        byAgent
        onOpenChange={() => {}}
        onCompare={onCompare}
        onKeepTheirs={onKeepTheirs}
        onKeepMine={onKeepMine}
      />,
    );
    expect(screen.getByText(/The agent saved version 5/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep theirs" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
    expect(onCompare).toHaveBeenCalledOnce();
    expect(onKeepTheirs).toHaveBeenCalledOnce();
    expect(onKeepMine).toHaveBeenCalledOnce();
  });
});

describe("compare diff", () => {
  it("marks the changed word inside a line, not the whole line", () => {
    const diff = diffDocuments("# T\n\nThe quick fox.\n", "# T\n\nThe slow fox.\n");
    expect(diff).toMatchObject({ added: 1, removed: 1 });
    const changed = diff.items
      .flatMap((item) => (item.type === "row" ? [item.row] : []))
      .find((row) => row.kind === "changed");
    expect(changed?.pieces).toEqual([
      { kind: "same", text: "The " },
      { kind: "removed", text: "quick" },
      { kind: "added", text: "slow" },
      { kind: "same", text: " fox." },
    ]);
  });

  it("folds long unchanged stretches and reports identical texts", () => {
    const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const diff = diffDocuments(`${long}\nend\n`, `${long}\nEND\n`);
    expect(diff.items[0]).toMatchObject({ type: "fold" });
    expect(diffDocuments("same\n", "same\n")).toMatchObject({ added: 0, removed: 0 });
  });
});

describe("toolbar rules", () => {
  it("accepts web and mail links only", () => {
    expect(normalizeLinkUrl("example.com/a")).toBe("https://example.com/a");
    expect(normalizeLinkUrl("mailto:me@example.com")).toBe("mailto:me@example.com");
    expect(normalizeLinkUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeLinkUrl("data:text/html,x")).toBeNull();
    expect(normalizeLinkUrl("   ")).toBeNull();
  });

  it("writes checklists, quotes and an empty table as clean markdown", () => {
    const todo = "- [ ] one\n- [x] two\n\n> quote\n";
    expect(valueToMarkdown(markdownToValue(todo))).toBe(todo);
    const cell = (type: string) => ({ type, children: [{ type: "p", children: [{ text: "" }] }] });
    const table = valueToMarkdown([
      {
        type: "table",
        children: [
          { type: "tr", children: [cell("th"), cell("th")] },
          { type: "tr", children: [cell("td"), cell("td")] },
        ],
      },
    ] as never);
    // No zero-width spaces for empty cells.
    expect(table).not.toMatch(/​/);
    expect(table.trim().split("\n")).toHaveLength(3);
  });
});

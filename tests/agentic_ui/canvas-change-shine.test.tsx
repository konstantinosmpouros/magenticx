// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

/**
 * After the agent's version loads (plan 44, Phase 4.3): the blocks whose text
 * is new are the ones that shine; and opening the canvas keeps the clicked
 * card where it was on screen while the chat column re-wraps.
 */

import { createCanvasEditor } from "@/features/canvas/lib/editorKit";
import { changedBlocks, changedTexts } from "@/features/canvas/lib/changeShine";
import { requestCanvasShine, takeCanvasShine } from "@/features/canvas/lib/pendingShine";
import { markdownToValue } from "@/features/canvas/lib/markdown";
import { keepInView } from "@/features/chat/lib/keepInView";

/** A block's plain text (its leaves joined). */
const textOf = (node: { children?: unknown[] }): string =>
  (node.children ?? []).map((leaf) => (leaf as { text?: string }).text ?? "").join("");

const BEFORE = ["# Brief", "", "Intro text.", "", "## Scope", "", "We cover everything.", ""].join(
  "\n",
);
const AFTER = ["# Brief", "", "Intro text.", "", "## Scope", "", "We cover the EU only.", ""].join(
  "\n",
);

describe("what shines after the agent's version loads", () => {
  it("only the blocks whose text is new", () => {
    const editor = createCanvasEditor(markdownToValue(AFTER));
    expect(changedBlocks(editor, BEFORE).map(textOf)).toEqual(["We cover the EU only."]);
  });

  it("nothing when the text is the same", () => {
    const editor = createCanvasEditor(markdownToValue(BEFORE));
    expect(changedBlocks(editor, BEFORE)).toEqual([]);
  });
});

describe("shining what an Ask agent request changed", () => {
  it("the texts that are new in the agent's version", () => {
    expect(changedTexts(BEFORE, AFTER)).toEqual(["We cover the EU only."]);
    expect(changedTexts(BEFORE, BEFORE)).toEqual([]);
  });

  it("a request is kept for the canvas of that path, taken once", () => {
    requestCanvasShine({ path: "/conversation/output/a.md", afterVersion: 4 });
    expect(takeCanvasShine("/conversation/output/b.md")).toBeNull();
    expect(takeCanvasShine("/conversation/output/a.md")).toEqual({
      path: "/conversation/output/a.md",
      afterVersion: 4,
    });
    expect(takeCanvasShine("/conversation/output/a.md")).toBeNull();
  });
});

describe("keepInView", () => {
  it("scrolls the chat by however far the clicked element moved", async () => {
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    Object.defineProperty(scroller, "scrollHeight", { value: 2000 });
    Object.defineProperty(scroller, "clientHeight", { value: 500 });
    const anchor = document.createElement("button");
    scroller.appendChild(anchor);
    document.body.appendChild(scroller);

    let top = 300;
    vi.spyOn(anchor, "getBoundingClientRect").mockImplementation(
      () => ({ top, bottom: top + 40 }) as DOMRect,
    );
    // The layout change pushes the element 120px further down.
    keepInView(anchor, () => {
      top = 420;
    });
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    expect(scroller.scrollTop).toBe(120);
    scroller.remove();
  });

  it("just runs the change without an anchor", () => {
    const change = vi.fn();
    keepInView(null, change);
    expect(change).toHaveBeenCalledTimes(1);
  });
});

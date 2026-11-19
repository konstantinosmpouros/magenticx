// @vitest-environment happy-dom
/**
 * The comment marks in the canvas's right margin (plan 44, Phase 4.4): one
 * mark per line where commented passages start, its count the threads on
 * that line, a click opening the card of that line's threads; the document
 * row's button holding the threads with no line (plan 44 v2: not in the
 * margin any more); and the caret orb kept clear of a mark on its line.
 */
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  CanvasCommentMarkers,
  CanvasOtherCommentsButton,
} from "@/features/canvas/components/canvas_parts/CanvasCommentMarkers";
import { orbClearOfMarks } from "@/features/canvas/lib/caretOrb";
import { measureCommentMarkers } from "@/features/canvas/lib/commentMarkers";
import { TooltipProvider } from "@/shared/ui/tooltip";

/** A range whose first line box sits at `top` (jsdom has no layout). */
function fakeRange(top: number, height = 24): Range {
  return {
    getClientRects: () => [{ top, height, width: 80, left: 0, right: 80, bottom: top + height }],
  } as unknown as Range;
}

function column(top: number): HTMLElement {
  return { getBoundingClientRect: () => ({ top }) } as unknown as HTMLElement;
}

describe("measureCommentMarkers", () => {
  it("puts passages that start on one line under one mark, lines top to bottom", () => {
    const markers = measureCommentMarkers(
      [
        { id: "late", range: fakeRange(400) },
        { id: "a", range: fakeRange(200) },
        { id: "b", range: fakeRange(203) },
      ],
      column(100),
    );
    expect(markers).toEqual([
      { top: 100, height: 24, ids: ["a", "b"] },
      { top: 300, height: 24, ids: ["late"] },
    ]);
  });

  it("skips a passage with no line box (folded away) and works without a column", () => {
    const hidden = { getClientRects: () => [] } as unknown as Range;
    expect(measureCommentMarkers([{ id: "x", range: hidden }], column(0))).toEqual([]);
    expect(measureCommentMarkers([{ id: "x", range: fakeRange(10) }], null)).toEqual([]);
  });
});

describe("CanvasCommentMarkers", () => {
  const renderMarks = (activeId: string | null, onOpen = vi.fn(), onClose = vi.fn()) =>
    render(
      <TooltipProvider>
        <CanvasCommentMarkers
          markers={[
            { top: 10, height: 24, ids: ["t1"] },
            { top: 90, height: 24, ids: ["t2", "t3"] },
          ]}
          activeId={activeId}
          onOpen={onOpen}
          onClose={onClose}
          renderThreads={(ids) => <p>threads {ids.join(",")}</p>}
        />
      </TooltipProvider>,
    );

  it("shows the count of each line and opens the card of its first thread", () => {
    const onOpen = vi.fn();
    renderMarks(null, onOpen);
    const one = screen.getByRole("button", { name: "1 comment on this line" });
    const two = screen.getByRole("button", { name: "2 comments on this line" });
    expect(two).toHaveTextContent("2");
    expect(one).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(two);
    expect(onOpen).toHaveBeenCalledWith("t2");
  });

  it("holds a line's threads in the card open for the active thread, and closes it", () => {
    const onClose = vi.fn();
    renderMarks("t3", vi.fn(), onClose);
    const card = screen.getByRole("dialog", { name: "2 comments" });
    expect(card).toHaveTextContent("threads t2,t3");
    expect(screen.getByRole("button", { name: "2 comments on this line" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    fireEvent.keyDown(card, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("has no mark for the threads with no line in the margin any more", () => {
    renderMarks(null);
    expect(screen.queryByRole("button", { name: /resolved or detached/ })).not.toBeInTheDocument();
  });

  it("renders nothing without marks", () => {
    const { container } = render(
      <CanvasCommentMarkers
        markers={[]}
        activeId={null}
        onOpen={() => {}}
        onClose={() => {}}
        renderThreads={() => null}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("CanvasOtherCommentsButton (the document row)", () => {
  function Row({ count }: { count: number }) {
    const [open, setOpen] = useState(false);
    return (
      <TooltipProvider>
        <CanvasOtherCommentsButton
          others={{ count, render: () => <p>the others</p>, open, onOpenChange: setOpen }}
        />
      </TooltipProvider>
    );
  }

  it("shows the count and opens the card of the resolved and detached threads", () => {
    render(<Row count={3} />);
    const button = screen.getByRole("button", { name: "3 resolved or detached comments" });
    expect(button).toHaveTextContent("3");
    fireEvent.click(button);
    expect(screen.getByRole("dialog", { name: "Resolved and detached comments" })).toHaveTextContent(
      "the others",
    );
  });

  it("is absent with none", () => {
    const { container } = render(<Row count={0} />);
    expect(container).toBeEmptyDOMElement();
    const none = render(<CanvasOtherCommentsButton others={null} />);
    expect(none.container).toBeEmptyDOMElement();
  });
});

describe("the caret orb stays clear of a margin mark", () => {
  /** A column 600px wide at x=100, a scroller showing `visible` px, and marks at those tops. */
  function layout(marks: { top: number; right?: number }[], visible: number) {
    const scroller = document.createElement("div");
    scroller.setAttribute("data-canvas-scroller", "");
    Object.defineProperty(scroller, "clientWidth", { value: visible });
    scroller.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
    const column = document.createElement("div");
    column.getBoundingClientRect = () => ({ left: 100, top: 0, right: 700 }) as DOMRect;
    for (const mark of marks) {
      const node = document.createElement("button");
      node.setAttribute("data-canvas-comment-mark", "");
      const right = 100 + (mark.right ?? 640);
      node.getBoundingClientRect = () =>
        ({ top: mark.top, bottom: mark.top + 20, left: right - 34, right }) as DOMRect;
      column.appendChild(node);
    }
    scroller.appendChild(column);
    document.body.appendChild(scroller);
    return column;
  }

  it("keeps its spot when no mark is on its line", () => {
    expect(orbClearOfMarks(layout([{ top: 200 }], 900), 50)).toEqual({ top: 50, left: null });
  });

  it("sits right of the mark when the margin shows room for both", () => {
    // The mark's right edge is at 640 in the column; the scroller shows 800px from x=0.
    expect(orbClearOfMarks(layout([{ top: 40 }], 900), 50)).toEqual({ top: 50, left: 644 });
  });

  it("goes under the mark (and the one under it) in a narrow margin", () => {
    const column = layout([{ top: 40 }, { top: 66 }], 760);
    const place = orbClearOfMarks(column, 50);
    expect(place.left).toBeNull();
    // Under the second mark (bottom 86): 86 + 4 + 14.
    expect(place.top).toBe(104);
  });
});

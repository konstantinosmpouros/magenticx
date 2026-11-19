// @vitest-environment happy-dom
/**
 * The comment marks in the canvas's right margin (plan 44, Phase 4.4): one
 * mark per line where commented passages start, its count the threads on
 * that line, a click opening the card of that line's threads, and the top
 * mark holding the threads with no line.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CanvasCommentMarkers } from "@/features/canvas/components/canvas_parts/CanvasCommentMarkers";
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
          others={{ count: 3, render: () => <p>the others</p> }}
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

  it("opens the threads with no line from the top mark", () => {
    renderMarks(null);
    fireEvent.click(
      screen.getByRole("button", { name: "3 more comments: on changed text or resolved" }),
    );
    expect(screen.getByRole("dialog", { name: "Other comments" })).toHaveTextContent("the others");
  });

  it("renders nothing without marks", () => {
    const { container } = render(
      <CanvasCommentMarkers
        markers={[]}
        activeId={null}
        onOpen={() => {}}
        onClose={() => {}}
        renderThreads={() => null}
        others={null}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

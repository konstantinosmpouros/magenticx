import { describe, expect, it } from "vitest";

import { createTimeline, foldTimeline, reduceTimelineEvents } from "@/features/inference/timeline";
import type { ThinkingBlock } from "@/shared/lib/types";

/**
 * Thinking streams live: a thought arrives as THINKING_TEXT_MESSAGE_START, its
 * CONTENT pieces, then END, and the timeline grows ONE step from the pieces —
 * across separate folds, as frames arrive — instead of a step per piece. A
 * thought sent whole (pieces with no START, as older stored runs have) is
 * still a step of its own.
 */

const thoughtsOf = (blocks: { kind: string }[]) =>
  (blocks.find((b) => b.kind === "thinking") as ThinkingBlock).items
    .filter((item) => item.kind === "thought")
    .map((item) => (item as { text: string }).text);

describe("streamed thinking", () => {
  it("grows one step per thought from its pieces", () => {
    const timeline = foldTimeline([
      { type: "THINKING_START" },
      { type: "THINKING_TEXT_MESSAGE_START" },
      { type: "THINKING_TEXT_MESSAGE_CONTENT", delta: "**Plan**\n\n" },
      { type: "THINKING_TEXT_MESSAGE_CONTENT", delta: "Look it " },
      { type: "THINKING_TEXT_MESSAGE_CONTENT", delta: "up." },
      { type: "THINKING_TEXT_MESSAGE_END" },
      { type: "THINKING_TEXT_MESSAGE_START" },
      { type: "THINKING_TEXT_MESSAGE_CONTENT", delta: "Answer short." },
      { type: "THINKING_TEXT_MESSAGE_END" },
      { type: "THINKING_END" },
    ]);
    expect(thoughtsOf(timeline.blocks)).toEqual(["**Plan**\n\nLook it up.", "Answer short."]);
  });

  it("keeps growing the same step across frames", () => {
    let timeline = reduceTimelineEvents(createTimeline(), [
      { type: "THINKING_START" },
      { type: "THINKING_TEXT_MESSAGE_START" },
      { type: "THINKING_TEXT_MESSAGE_CONTENT", delta: "Look it " },
    ]);
    expect(thoughtsOf(timeline.blocks)).toEqual(["Look it "]);
    timeline = reduceTimelineEvents(timeline, [{ type: "THINKING_TEXT_MESSAGE_CONTENT", delta: "up." }]);
    expect(thoughtsOf(timeline.blocks)).toEqual(["Look it up."]);
  });

  it("still makes a step per whole thought sent without START", () => {
    const timeline = foldTimeline([
      { type: "THINKING_TEXT_MESSAGE_CONTENT", delta: "Analyzing the input..." },
      { type: "THINKING_TEXT_MESSAGE_CONTENT", delta: "Retrieved 4 documents." },
    ]);
    expect(thoughtsOf(timeline.blocks)).toEqual(["Analyzing the input...", "Retrieved 4 documents."]);
  });
});

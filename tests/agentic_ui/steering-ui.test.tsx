// @vitest-environment happy-dom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The markdown renderer pulls in KaTeX's stylesheet, which Node cannot import.
vi.mock("@/shared/ui/ai-elements/response", () => ({
  Response: ({ children }: { children?: unknown }) => <div>{String(children ?? "")}</div>,
}));

import { ComposerTaskNotices } from "@/features/chat/components/ComposerTaskNotices";
import { TimelineSequence } from "@/features/chat/components/message_parts/TimelineSequence";
import { foldTimeline } from "@/features/inference";

/**
 * Steering in the UI (SSE plan, phase 5). Pinned: a USER_INTERJECTION event —
 * as CUSTOM or as a type of its own — becomes a `user_interjection` block at
 * the point the run read it, between the text around it; an empty one is
 * dropped; the block renders the user's words; the queued chip says when the
 * message goes in (next step for plain text, the answer's end for a command).
 */

const interjection = (text: string) => ({
  type: "CUSTOM",
  name: "USER_INTERJECTION",
  value: { text, queued_at: "2026-11-23T10:00:00Z" },
});

describe("USER_INTERJECTION in a run's stream", () => {
  it("opens a block where the run read it, between the text around it", () => {
    const timeline = foldTimeline([
      { type: "TEXT_MESSAGE_CONTENT", delta: "Looking up revenue. " },
      interjection("only the 2025 numbers"),
      { type: "TEXT_MESSAGE_CONTENT", delta: "Narrowing to 2025." },
    ]);
    expect(timeline.blocks.map((block) => block.kind)).toEqual(["content", "user_interjection", "content"]);
    expect(timeline.blocks[1]).toMatchObject({ kind: "user_interjection", text: "only the 2025 numbers" });
  });

  it("reads the type-of-its-own form and drops an empty message", () => {
    const timeline = foldTimeline([
      { type: "USER_INTERJECTION", text: "and in euros" },
      { type: "CUSTOM", name: "USER_INTERJECTION", value: { text: "" } },
    ]);
    expect(timeline.blocks).toMatchObject([{ kind: "user_interjection", text: "and in euros" }]);
  });

  it("renders the user's words inside the answer", () => {
    const timeline = foldTimeline([interjection("only the 2025 numbers")], { status: "completed" });
    render(
      <TimelineSequence
        timeline={timeline}
        runId="m"
        isStreaming={false}
        expandedThinking={{}}
        onToggleThinking={() => {}}
      />,
    );
    expect(screen.getByText("You, while it worked")).toBeInTheDocument();
    expect(screen.getByText("only the 2025 numbers")).toBeInTheDocument();
  });
});

describe("the queued chip", () => {
  const queued = { id: "q1", content: "and in euros", attachmentCount: 0, queuedAt: Date.UTC(2026, 10, 23, 10) };

  it("says a plain message is read at the next step, or sent after the answer", () => {
    render(<ComposerTaskNotices queuedMessages={[{ ...queued, commandName: null }]} onCancelQueued={() => {}} />);
    expect(within(screen.getByRole("status")).getByText("Read at the next step, or sent after this answer")).toBeInTheDocument();
  });

  it("says a command waits for the answer to end", () => {
    render(<ComposerTaskNotices queuedMessages={[{ ...queued, commandName: "review" }]} onCancelQueued={() => {}} />);
    expect(within(screen.getByRole("status")).getByText("Sent when this answer ends")).toBeInTheDocument();
  });

  it("offers Send now while an answer runs, and it stops that answer", () => {
    const onSendNow = vi.fn();
    render(
      <ComposerTaskNotices
        queuedMessages={[{ ...queued, commandName: null }]}
        onCancelQueued={() => {}}
        onSendNow={onSendNow}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Send now: stop the answer and send this message" }));
    expect(onSendNow).toHaveBeenCalledTimes(1);
  });

  it("has no Send now when nothing runs", () => {
    render(<ComposerTaskNotices queuedMessages={[{ ...queued, commandName: null }]} onCancelQueued={() => {}} />);
    expect(screen.queryByRole("button", { name: /Send now/ })).toBeNull();
  });
});

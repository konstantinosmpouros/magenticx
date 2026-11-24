// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import {
  createTimeline,
  reduceTimelineEvents,
  timelineThoughtStrings,
} from "@/features/inference/timeline";
import { createFrameScheduler } from "@/features/inference/frameScheduler";

/**
 * Plan 45, Phase 3: the run engine folds every stream frame as it arrives
 * but hands the result to React once per animation frame. These tests pin the
 * two halves of that promise: a burst of token frames costs one render, and
 * nothing in the burst is lost or reordered — the published timeline is the
 * one folding the frames one at a time gives. Anything the user must see or
 * answer (an approval, the run ending) is published at once.
 */

const api = vi.hoisted(() => ({
  startInference: vi.fn(),
  resumeInferenceRun: vi.fn(),
  cancelInferenceRun: vi.fn(),
  getActiveInferenceRuns: vi.fn(() => new Promise(() => {})),
  connectInferenceStream: vi.fn(),
}));
vi.mock("@/shared/lib/api", () => api);

const { useInferenceRuns } = await import("@/features/inference/useInferenceRuns");

const RUN = "run-1";
const CONV = "conv-1";
const T0 = 1_000_000;

const text = (delta: string, seq: number) => ({ type: "TEXT_MESSAGE_CHUNK", delta, seq });
const thinking = (delta: string, seq: number) => ({
  type: "THINKING_TEXT_MESSAGE_CONTENT",
  delta,
  seq,
});
const hitl = (id: string, seq: number) => ({
  type: "CUSTOM",
  name: "HITL_INTERRUPT",
  seq,
  value: {
    thread_id: "thread-1",
    interrupt: { id, value: { action_requests: [{ name: "edit_file", args: {} }] } },
  },
});

const run = (status = "running") => ({
  id: RUN,
  userId: "user-1",
  conversationId: CONV,
  assistantMessageId: "msg-1",
  status,
  messagePath: [],
  rawEvents: [],
  pendingInterrupts: 0,
  startedAt: new Date(T0),
  updatedAt: new Date(T0),
});

type Frame = {
  type: string;
  run: ReturnType<typeof run>;
  events?: Record<string, unknown>[];
};

/** Wait past the frame scheduler's background fallback (100 ms). */
const nextPublish = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });

describe("createFrameScheduler", () => {
  it("merges repeated asks into one run and can be flushed or cancelled", () => {
    const callback = vi.fn();
    const scheduler = createFrameScheduler(callback);
    scheduler.schedule();
    scheduler.schedule();
    scheduler.flush();
    expect(callback).toHaveBeenCalledTimes(1);
    scheduler.flush();
    expect(callback).toHaveBeenCalledTimes(1);
    scheduler.schedule();
    scheduler.cancel();
    scheduler.flush();
    expect(callback).toHaveBeenCalledTimes(1);
  });
});

describe("useInferenceRuns: one publish per frame, nothing lost", () => {
  let push: (frame: Frame) => void = () => {};
  let renders = 0;
  const setConversations = vi.fn();
  const setCurrentConversation = vi.fn();
  const setThinkingState = vi.fn();

  beforeEach(() => {
    renders = 0;
    api.connectInferenceStream.mockImplementation(
      (_user: string, _run: string, onEvent: (frame: Frame) => void) => {
        push = onEvent;
        return new Promise(() => {});
      },
    );
    api.startInference.mockResolvedValue({
      run: run(),
      message: null,
      summary: { id: CONV, isPrivate: false, updated_at: new Date(T0).toISOString() },
      detail: { id: CONV, messages: [] },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const mount = async () => {
    const hook = renderHook(() => {
      renders += 1;
      return useInferenceRuns({
        userId: "user-1",
        currentConversationId: CONV,
        setConversations,
        setCurrentConversation,
        setThinkingState,
        toast: vi.fn(),
      });
    });
    await act(async () => {
      await hook.result.current.beginRun({ mode: "send", conversationId: CONV } as never);
    });
    // A first token frame: the run's first events are published at once.
    act(() => push({ type: "events", run: run(), events: [thinking("t0 ", 1)] }));
    await nextPublish();
    return hook;
  };

  it("publishes a burst of token frames in one render, with every delta kept in order", async () => {
    const hook = await mount();
    const frames: Frame[] = [];
    for (let i = 0; i < 40; i += 1) {
      const seq = 2 + i;
      frames.push({
        type: "events",
        run: run(),
        events: [i < 20 ? thinking(`t${i + 1} `, seq) : text(`w${i - 19} `, seq)],
      });
    }

    const before = renders;
    const conversationCalls = setConversations.mock.calls.length;
    act(() => {
      for (const frame of frames) push(frame);
    });
    // Folded but not yet handed to React.
    expect(renders - before).toBeLessThanOrEqual(1);
    await nextPublish();
    expect(renders - before).toBeLessThanOrEqual(2);
    // One sidebar publish for the burst, not 40.
    expect(setConversations.mock.calls.length - conversationCalls).toBe(1);

    // The same frames folded one at a time give the same timeline.
    let expected = reduceTimelineEvents(createTimeline(), [thinking("t0 ", 1)]);
    for (const frame of frames) expected = reduceTimelineEvents(expected, frame.events ?? []);
    const published = hook.result.current.getRunForConversation(CONV);
    expect(published?.timeline).toEqual(expected);
    expect(timelineThoughtStrings(published?.timeline).join("")).toContain("t0 t1 t2");
    expect(timelineThoughtStrings(published?.timeline).join("")).toContain("t19 t20 ");
  });

  it("publishes a new approval at once, without waiting for the frame", async () => {
    const hook = await mount();
    act(() => push({ type: "events", run: run(), events: [hitl("int-1", 2)] }));
    const published = hook.result.current.getRunForConversation(CONV);
    expect(published?.timeline?.blocks.length).toBeGreaterThan(0);
    const before = setConversations.mock.calls.length;
    act(() => push({ type: "events", run: run(), events: [text("x", 3)] }));
    // An ordinary token right after waits for the frame.
    expect(setConversations.mock.calls.length).toBe(before);
  });

  it("publishes the end of a run at once, including tokens still waiting", async () => {
    const hook = await mount();
    act(() => {
      push({ type: "events", run: run(), events: [text("last words", 2)] });
      push({ type: "terminal", run: { ...run("completed"), rawEvents: [] } });
    });
    expect(hook.result.current.getRunForConversation(CONV)).toBeNull();
    expect(hook.result.current.isConversationStreaming(CONV)).toBe(false);
    // Nothing is published again for a run that ended.
    const calls = setConversations.mock.calls.length;
    await nextPublish();
    expect(setConversations.mock.calls.length).toBe(calls);
  });
});

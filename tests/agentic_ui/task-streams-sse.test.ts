// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The conversation channel and a task's drill-down over SSE (SSE plan, phase 2).
 *
 * Pinned: each SSE event's data is one frame, handed to the same
 * frame handling (`run_started` still gets its run transformed); the channel
 * opens `…/{conversation}/events` with no cursor and calls `onOpen` once the
 * response is there; a channel that ends is reopened (it never ends on its
 * own); the task stream resumes with `?since=` and resolves on `terminal`;
 * a 404 is final.
 */

vi.mock("@/shared/lib/sessionRefresh", () => ({
  ensureFreshSession: vi.fn(async () => ({ status: "refreshed" })),
}));

import { connectConversationChannel, connectTaskStream } from "@/shared/lib/api/asyncTasks";
import type { ConversationChannelFrame, TaskSocketFrame } from "@/shared/lib/types";

const encoder = new TextEncoder();

function bodyOf(chunks: string[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(encoder.encode(chunks[index++]));
      else controller.close();
    },
  });
}

const okStream = (chunks: string[]) =>
  ({ ok: true, status: 200, headers: new Headers(), body: bodyOf(chunks) }) as unknown as Response;

/** One SSE event exactly as the bridge writes it: the frame as data, its type as event, its seq as id. */
const frame = (data: { type: string; seq?: string } & Record<string, unknown>) =>
  `${data.seq ? `id: ${data.seq}\n` : ""}event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;

describe("background-task streams over SSE", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("feeds the channel's frames to the same handling and reopens a channel that ended", async () => {
    const controller = new AbortController();
    const frames: ConversationChannelFrame[] = [];
    let opens = 0;
    fetchMock
      .mockResolvedValueOnce(
        okStream([
          frame({ type: "queue", queued_message: null }),
          ": ping\n\n",
          frame({
            type: "run_started",
            seq: "4-0",
            from_queue: true,
            run: { id: "run-9", conversationId: "conv-1", status: "running", content: "" },
          }),
        ]),
      )
      .mockImplementationOnce(async () => {
        // The second connection: the reconnect happened — stop here.
        controller.abort();
        throw new DOMException("Aborted", "AbortError");
      });

    await expect(
      connectConversationChannel("user-1", "conv-1", (f) => frames.push(f), {
        signal: controller.signal,
        onOpen: () => (opens += 1),
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(fetchMock.mock.calls[0][0]).toMatch(/\/conversations\/user-1\/conv-1\/events$/);
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get("Accept")).toBe("text/event-stream");
    expect(opens).toBe(1);
    expect(frames.map((f) => f.type)).toEqual(["queue", "run_started"]);
    const started = frames[1] as Extract<ConversationChannelFrame, { type: "run_started" }>;
    expect(started.run.id).toBe("run-9");
    expect(started.fromQueue).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("resumes a task stream from `since` and resolves on its terminal frame", async () => {
    fetchMock.mockResolvedValueOnce(
      okStream([
        frame({ type: "event", seq: "3-0", event: { type: "TEXT_MESSAGE_CONTENT", delta: "Hi" } }),
        frame({ type: "terminal", status: "success" }),
      ]),
    );
    const frames: TaskSocketFrame[] = [];

    await connectTaskStream("user-1", "task-1", (f) => frames.push(f), { since: () => "2-0" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/tasks\/user-1\/task-1\/events\?since=2-0$/);
    expect(frames.map((f) => f.type)).toEqual(["event", "terminal"]);
  });

  it("stops for good on a 404", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers(),
      json: async () => ({ detail: "Task not found." }),
    } as unknown as Response);

    await expect(connectTaskStream("user-1", "gone", () => {})).rejects.toMatchObject({
      permanent: true,
      code: 4404,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

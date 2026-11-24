// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The run stream client over SSE (SSE plan, phase 1) and the shared SSE reader.
 *
 * Pinned: the reader hands over every event the moment its blank line arrives
 * — split across chunks, CRLF or not — with its `event` / `id`, and skips
 * `: ping` comments; over SSE the client applies the snapshot, each event and
 * the terminal state, and resolves on the terminal frame; a stream that ends
 * without one reconnects with `?since=<last id>`; a 404 is final (no retry
 * loop against a run that is gone).
 */

vi.mock("@/shared/lib/sessionRefresh", () => ({
  ensureFreshSession: vi.fn(async () => ({ status: "refreshed" })),
}));

import { connectInferenceStream } from "@/shared/lib/api/inference-stream";
import { readSseStream, type SseEvent } from "@/shared/lib/api/sse";

const encoder = new TextEncoder();

/** A response body that delivers `chunks` one read at a time. */
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

const sse = (event: string, data: unknown, id?: string) =>
  `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** A run event payload the client's transform accepts. */
const runPayload = (status: string, content = "") => ({
  type: "update",
  run: { id: "run-1", conversationId: "conv-1", status, content },
});

describe("readSseStream", () => {
  it("parses events split across chunks, with CRLF, and skips comments", async () => {
    const events: SseEvent[] = [];
    let chunks = 0;
    await readSseStream(
      bodyOf([": ping\n\nid: 1-0\nevent: ev", "ent\r\ndata: {\"a\":1}\r\n\r\n", "data: plain\n\n"]),
      (event) => events.push(event),
      () => (chunks += 1),
    );
    expect(events).toEqual([
      { event: "event", id: "1-0", data: '{"a":1}' },
      { event: "message", id: null, data: "plain" },
    ]);
    expect(chunks).toBe(3);
  });
});

describe("connectInferenceStream over SSE", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("applies the snapshot, each event and the terminal state, then resolves", async () => {
    fetchMock.mockResolvedValueOnce(
      okStream([
        sse("snapshot", runPayload("running")),
        ": ping\n\n",
        sse("event", runPayload("running", "Hel"), "5-0"),
        sse("event", runPayload("running", "Hello"), "6-0"),
        sse("terminal", runPayload("completed", "Hello")),
      ]),
    );
    const applied: string[] = [];

    await connectInferenceStream("user-1", "run-1", (event) => applied.push(event.type));

    expect(applied).toHaveLength(4);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/inference\/runs\/user-1\/run-1\/events$/);
    expect(new Headers(init.headers).get("Accept")).toBe("text/event-stream");
  });

  it("reconnects with the last event id when the stream ends without a terminal frame", async () => {
    fetchMock
      .mockResolvedValueOnce(okStream([sse("event", runPayload("running", "Hel"), "5-0")]))
      .mockResolvedValueOnce(okStream([sse("terminal", runPayload("completed", "Hello"))]));

    await connectInferenceStream("user-1", "run-2", () => {});

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toMatch(/\/run-2\/events\?since=5-0$/);
  });

  it("stops for good on a 404 instead of retrying a run that is gone", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers(),
      json: async () => ({ detail: "Inference run not found." }),
    } as unknown as Response);

    await expect(connectInferenceStream("user-1", "run-3", () => {})).rejects.toMatchObject({
      permanent: true,
      code: 4404,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

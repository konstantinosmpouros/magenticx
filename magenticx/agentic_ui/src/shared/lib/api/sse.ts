/**
 * A Server-Sent Events reader over a `fetch` response body — shared by the
 * workflow run stream and the inference run stream.
 *
 * Read with `fetch` rather than `EventSource`, so the request goes through the
 * shared transport (credentials, the silent 401 refresh-and-retry) and a 403 /
 * 404 / 429 is a real status the caller can act on, not an opaque "error,
 * reconnecting". Each event is handed over the moment its blank line arrives:
 * no batching here — batching renders is the frame scheduler's job.
 */

/** One parsed SSE event: its `event:` name ("message" when absent), `id:` and `data:`. */
export type SseEvent = { event: string; id: string | null; data: string };

/** Parse one event block (the lines before a blank line); null for a comment-only block. */
function parseBlock(block: string): SseEvent | null {
  let event = "message";
  let id: string | null = null;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue; // comment (`: ping`) or empty
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    // One optional space after the colon belongs to the syntax, not the value.
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "id") id = value;
    else if (field === "data") data.push(value);
  }
  return data.length > 0 ? { event, id, data: data.join("\n") } : null;
}

/**
 * Read `body` until it ends, calling `onEvent` for every complete event and
 * `onChunk` for every chunk received (heartbeats included — proof the
 * connection is alive). Resolves when the server closes the stream; rejects on
 * a transport error or an abort of the request's signal.
 */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: SseEvent) => void,
  onChunk?: () => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk?.();
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const parsed = parseBlock(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (parsed) onEvent(parsed);
        boundary = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode();
    const last = buffer.trim() ? parseBlock(buffer) : null;
    if (last) onEvent(last);
  } finally {
    reader.releaseLock();
  }
}

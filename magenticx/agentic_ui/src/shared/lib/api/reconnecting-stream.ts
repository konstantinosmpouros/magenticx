/**
 * A reconnecting Server-Sent Events reader for the bridge's background-task
 * streams — the conversation channel and a task's own stream (plan 41).
 *
 * Each event's `data` is one JSON frame and its `id` the frame's `seq`. The
 * policy is the run stream's (`inference-stream.ts`): the thing being watched
 * is server-owned and durable, so a dropped stream is retried forever with a
 * capped backoff (never given up on), and an offline tab waits for `online`
 * instead of spinning. Refused for good: a 400 / 401 / 403 / 404 — `requestRaw`
 * has already tried the silent session refresh on a 401. Kept apart from the
 * run stream rather than folded into it so that hot path is not touched; both
 * follow the same table.
 */
import { ApiError, requestRaw } from "../http";
import { waitUntilOnline } from "./inference-stream";
import { readSseStream } from "./sse";

const RECONNECT_BACKOFF_MS = [250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000];

class PermanentStreamError extends Error {
  readonly permanent = true;
  readonly code: number;
  constructor(message: string, code: number) {
    super(message);
    this.name = "PermanentStreamError";
    this.code = code;
  }
}

export type ReconnectingStreamHandlers = {
  /**
   * The cursor to resume after, read on every (re)connect. Omit it for a
   * stream that always starts from "now".
   */
  since?: () => string | null;
  /** Called after each successful open — a caller re-syncs what a gap may have hidden. */
  onOpen?: () => void;
  /** One parsed frame. Returning `"done"` ends the stream and resolves. */
  onFrame: (frame: unknown) => "done" | void;
};

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

/** Hand one frame to the caller; a frame it cannot apply never ends the stream. */
function deliver(handlers: ReconnectingStreamHandlers, frame: unknown): "done" | void {
  if (!frame || typeof frame !== "object") return;
  try {
    return handlers.onFrame(frame);
  } catch {
    return;
  }
}

/**
 * One SSE connection: `GET <path>/events?since=…`, read until a frame says it
 * is done. Rejects (to be retried) when the stream ends before that, and
 * permanently on a 400 / 401 / 403 / 404 — `requestRaw` has already tried the
 * silent refresh on a 401, and announced the sign-out if it failed.
 */
async function runOneSseConnection(
  path: string,
  handlers: ReconnectingStreamHandlers,
  signal: AbortSignal | undefined,
  onProgress: () => void,
): Promise<void> {
  const since = handlers.since?.() ?? null;
  const query = since ? `?since=${encodeURIComponent(since)}` : "";
  let res: Response;
  try {
    res = await requestRaw(`${path}/events${query}`, {
      accept: "text/event-stream",
      signal,
      fallbackMessage: "Live updates could not be opened.",
    });
  } catch (err) {
    if (err instanceof ApiError && [400, 401, 403, 404].includes(err.status)) {
      throw new PermanentStreamError(err.message, 4000 + err.status);
    }
    throw err;
  }
  if (!res.body) throw new Error("The event stream had no body");
  handlers.onOpen?.();

  let done = false;
  await readSseStream(
    res.body,
    ({ data }) => {
      if (done) return;
      let frame: unknown;
      try {
        frame = JSON.parse(data);
      } catch {
        return;
      }
      done = deliver(handlers, frame) === "done";
    },
    onProgress,
  );
  if (!done) throw new Error("The event stream ended");
}

/**
 * Follow a bridge stream (`path` without its `/events` suffix) until a frame
 * says it is done (`onFrame` returns `"done"`), the caller aborts, or it is
 * refused for good. Everything else reconnects.
 */
export async function runReconnectingStream(
  path: string,
  handlers: ReconnectingStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  let consecutiveFailures = 0;
  for (;;) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      await runOneSseConnection(path, handlers, signal, () => {
        consecutiveFailures = 0;
      });
      return;
    } catch (err: unknown) {
      const error = err as { name?: string; permanent?: boolean };
      if (signal?.aborted || error?.name === "AbortError") {
        throw new DOMException("Aborted", "AbortError");
      }
      if (error?.permanent) throw err;
      consecutiveFailures += 1;
      const delay = RECONNECT_BACKOFF_MS[Math.min(consecutiveFailures - 1, RECONNECT_BACKOFF_MS.length - 1)];
      await sleepWithAbort(delay, signal);
      await waitUntilOnline(signal);
    }
  }
}

/**
 * Inference run stream client — the live event stream for an in-flight run,
 * over Server-Sent Events (SSE plan), with resume-from-last-seq reconnects.
 *
 * Frames: a snapshot on a fresh subscribe, then one `event` per Redis stream
 * entry (the new AG-UI events of one upstream chunk; its `seq` is the SSE
 * event id), then `terminal`.
 *
 * Session expiry: the request goes through `requestRaw`, which does the silent
 * refresh-and-retry itself and announces the sign-out if that fails, so a 401
 * reaching this module is final.
 *
 * Everything except `connectInferenceStream` and `waitUntilOnline` is
 * module-private.
 */
import type { InferenceRunEvent } from "../types";
import { ApiError, requestRaw } from "../http";
import { transformInferenceRunEvent } from "./inference";
import { INFERENCE_BASE_PATH } from "./paths";
import { readSseStream } from "./sse";

// Reconnect backoff, capped rather than exhausted.
//
// This used to be five steps totalling ~9 seconds, after which the client gave
// up permanently. That is fine for a run streaming tokens, but wrong for a run
// PAUSED at a human approval: the user may sit on that prompt for minutes while
// the server holds the run open, and any transient drop in that window (laptop
// sleep, wifi blip, a backgrounded tab) burned all five attempts in nine seconds
// and left the UI permanently blind to a run that was still executing. Approving
// then failed with a stale interrupt and the answer only appeared on refresh.
//
// The run is server-owned and durable, so there is no reason to stop trying:
// back off to 30s and keep going. `waitUntilOnline` below means an offline tab
// costs nothing while it waits. Frames received reset the counter, so a stream
// that briefly drops recovers at the fast end of the table.
const INFERENCE_RECONNECT_BACKOFF_MS = [250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000];

// Tracks the last delivered Redis-stream entry ID per active run so reconnects
// can resume with ``since=lastSeenSeq``. Cleared when the terminal frame is
// received (or when an explicit abort completes the run).
const lastSeenInferenceSeq = new Map<string, string>();

/** The stream cannot succeed by retrying (forbidden, not found, a bad cursor, the session is over). */
class PermanentInferenceStreamError extends Error {
  readonly permanent = true;
  readonly code: number;
  constructor(message: string, code: number) {
    super(message);
    this.name = "PermanentInferenceStreamError";
    this.code = code;
  }
}

/** One stream frame. */
type StreamFrame =
  | { type: "snapshot"; payload: unknown }
  | { type: "event"; seq: string | null; payload: unknown }
  | { type: "terminal"; payload: unknown };

/**
 * Apply one frame. Returns true for the terminal frame, after which the
 * connection is done. A malformed payload is skipped, never thrown.
 */
function applyFrame(runId: string, frame: StreamFrame, onEvent: (event: InferenceRunEvent) => void): boolean {
  if (frame.payload) {
    try {
      // The terminal payload is the DB-built final state — applying it flips
      // the run to its real status even when the terminal stream entry was
      // lost on this connection (send raced the close, reconnect gap).
      onEvent(transformInferenceRunEvent(frame.payload as Parameters<typeof transformInferenceRunEvent>[0]));
    } catch {
      // ignore a malformed payload
    }
  }
  if (frame.type === "event" && frame.seq) lastSeenInferenceSeq.set(runId, frame.seq);
  if (frame.type === "terminal") {
    lastSeenInferenceSeq.delete(runId);
    return true;
  }
  return false;
}

function inferenceRunPath(userId: string, runId: string): string {
  return `${INFERENCE_BASE_PATH}/runs/${encodeURIComponent(userId)}/${encodeURIComponent(runId)}`;
}

function inferenceSleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

/**
 * One SSE connection: `GET …/events?since=<last seq>`, read to the end.
 * Resolves on the terminal frame; rejects (to be retried) when the stream ends
 * without one, and permanently on a 400 / 401 / 403 / 404.
 */
async function runOneInferenceSseConnection(
  userId: string,
  runId: string,
  onEvent: (event: InferenceRunEvent) => void,
  signal: AbortSignal | undefined,
  onProgress: () => void,
): Promise<void> {
  const since = lastSeenInferenceSeq.get(runId);
  const query = since ? `?since=${encodeURIComponent(since)}` : "";
  let res: Response;
  try {
    res = await requestRaw(`${inferenceRunPath(userId, runId)}/events${query}`, {
      accept: "text/event-stream",
      signal,
      fallbackMessage: "The run's live updates could not be opened.",
    });
  } catch (err) {
    // requestRaw already tried a silent refresh on a 401 (and announced the
    // sign-out if it failed); 0 (bridge unreachable), 429 and 5xx are retried.
    if (err instanceof ApiError && [400, 401, 403, 404].includes(err.status)) {
      throw new PermanentInferenceStreamError(err.message, 4000 + err.status);
    }
    throw err;
  }
  if (!res.body) throw new Error("The run's event stream had no body");

  let done = false;
  await readSseStream(
    res.body,
    ({ event, id, data }) => {
      if (done) return;
      if (event !== "snapshot" && event !== "event" && event !== "terminal") return;
      let payload: unknown = null;
      try {
        payload = JSON.parse(data);
      } catch {
        if (event !== "terminal") return;
      }
      const frame: StreamFrame =
        event === "event" ? { type: "event", seq: id, payload } : { type: event, payload };
      done = applyFrame(runId, frame, onEvent);
    },
    onProgress,
  );
  if (!done) throw new Error("The run's event stream ended before its terminal frame");
}

/**
 * Resolve immediately when online, otherwise wait for the browser's `online`
 * event. Prevents a sleeping/offline tab from spinning through reconnect
 * attempts that cannot possibly succeed.
 */
export function waitUntilOnline(signal?: AbortSignal): Promise<void> {
  if (typeof navigator === "undefined" || navigator.onLine !== false) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener("online", onOnline);
      signal?.removeEventListener("abort", onAbort);
    };
    const onOnline = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    window.addEventListener("online", onOnline);
    signal?.addEventListener("abort", onAbort);
  });
}

/**
 * Follow a run's live events until its terminal frame, reconnecting with the
 * last seen `seq` after any drop.
 */
export async function connectInferenceStream(
  userId: string,
  runId: string,
  onEvent: (event: InferenceRunEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  let consecutiveFailures = 0;
  for (;;) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      await runOneInferenceSseConnection(userId, runId, onEvent, signal, () => {
        consecutiveFailures = 0;
      });
      return;
    } catch (caught: unknown) {
      const err = caught as { name?: string; permanent?: boolean };
      if (signal?.aborted || err?.name === "AbortError") {
        throw new DOMException("Aborted", "AbortError");
      }
      if (err?.permanent) {
        throw caught;
      }
      consecutiveFailures += 1;
      // Hold at the longest step instead of giving up — see the note on the
      // backoff table. A connection that delivers anything resets this counter,
      // so a flaky link recovers to fast retries rather than staying at 30s.
      const delay =
        INFERENCE_RECONNECT_BACKOFF_MS[
          Math.min(consecutiveFailures - 1, INFERENCE_RECONNECT_BACKOFF_MS.length - 1)
        ];
      await inferenceSleepWithAbort(delay, signal);
      // Don't burn a retry against a known-offline network; resume the moment
      // the browser reports connectivity again.
      await waitUntilOnline(signal);
    }
  }
}

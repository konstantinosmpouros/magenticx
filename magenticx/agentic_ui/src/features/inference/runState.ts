/**
 * The pure run-state fold shared by every live view of a run: the main chat
 * (`useInferenceRuns`) and the agent builder's "Try it" panel
 * (`useAgentTrial`). A stream frame, a start answer or a cancel/resume
 * answer goes in; the run with its timeline folded comes out. Kept apart from
 * either hook so both read a frame exactly the same way.
 */
import {
  createTimeline,
  foldTimeline,
  reduceTimelineEvents,
  timelineThoughtStrings,
} from "./timeline";
import type {
  InferenceRun,
  InferenceRunEvent,
  MessageOut,
  ThinkingState,
} from "@/shared/lib/types";

const ACTIVE_STATUSES = new Set(["queued", "running", "cancelling"]);

export const patchMessage = (messages: MessageOut[], message: MessageOut) => {
  const found = messages.some((item) => item.id === message.id);
  return found
    ? messages.map((item) => (item.id === message.id ? message : item))
    : [...messages, message];
};

/**
 * Patch the row with this id, keeping the same list (and the same row) when
 * every patched field already holds that value.
 *
 * A run event arrives about once per streamed token (plan 45). `list.map()`
 * always returns a new array, so patching unconditionally made every token a
 * new conversation list and re-rendered the whole sidebar for nothing.
 */
export function patchRowById<T extends { id: string }>(
  rows: T[],
  id: string,
  patch: Partial<T>,
): T[] {
  let changed = false;
  const next = rows.map((row) => {
    if (row.id !== id) return row;
    const differs = (Object.keys(patch) as (keyof T)[]).some(
      (key) => !Object.is(row[key], patch[key]),
    );
    if (!differs) return row;
    changed = true;
    return { ...row, ...patch };
  });
  return changed ? next : rows;
}

const sameStrings = (a: readonly string[] | undefined, b: readonly string[] | undefined) =>
  a === b ||
  (a !== undefined && b !== undefined && a.length === b.length && a.every((v, i) => v === b[i]));

/**
 * The thinking state for a live run, or `prev` itself when nothing it shows
 * has changed (same message, thoughts, start and branch).
 *
 * While the answer's text streams, the thoughts don't move; rebuilding the
 * object anyway handed every message a new `thinkingState` on every token.
 */
export function nextLiveThinkingState(
  prev: ThinkingState | null,
  next: ThinkingState,
): ThinkingState {
  if (
    prev &&
    prev.messageId === next.messageId &&
    prev.isActive === next.isActive &&
    prev.isDone === next.isDone &&
    prev.startTime === next.startTime &&
    prev.endTime === next.endTime &&
    prev.currentThoughtIndex === next.currentThoughtIndex &&
    sameStrings(prev.thoughts, next.thoughts) &&
    sameStrings(prev.branchPath, next.branchPath)
  ) {
    return prev;
  }
  return next;
}

export const isActiveRun = (run: InferenceRun | null | undefined) =>
  Boolean(run && ACTIVE_STATUSES.has(String(run.status)));

/**
 * Has the agent actually started doing something on this run — a timeline block
 * (thinking/tool/content), a thought, or a pending HITL interrupt?
 *
 * A live run with none of these is still in its transition phase: the UI shows
 * the pulsing bridge dot under the user's message and no thinking block yet.
 * Shared by the event fold and the optimistic paint below so the two can never
 * disagree about what counts as "started".
 *
 * A `user_interjection` block is not a signal: it is the user's own queued
 * words, which the agent can read before it has written anything (steering at
 * its first step). Counting it put the dot out while the agent was still
 * starting, so the answer looked stopped with the messages just sent.
 */
export const runHasAgentSignal = (run: InferenceRun, thoughts: string[]) =>
  thoughts.length > 0 ||
  (run.timeline?.blocks.some((block) => block.kind !== "user_interjection") ?? false) ||
  (run.pendingInterrupts ?? 0) > 0;

/** The thoughts a run currently carries, preferring its folded timeline. */
export const runThoughts = (run: InferenceRun): string[] =>
  run.timeline ? timelineThoughtStrings(run.timeline) : (run.thinking ?? []);

export const foldRunSnapshot = (run: InferenceRun): InferenceRun => ({
  ...run,
  timeline: foldTimeline(run.rawEvents, {
    status: String(run.status),
    legacyMessage: { content: run.content, thinking: run.thinking },
  }),
});

// One run state per conversation, folded incrementally. "events" frames carry
// only the new AG-UI events + run meta; "snapshot"/"terminal" frames carry the
// full state (rawEvents = the coalesced log) and are re-folded from scratch.
// "update" is the client-local merge of cancel/resume REST responses — meta
// only, so the in-progress timeline is preserved.
export const mergeRunEvent = (
  existing: InferenceRun | null | undefined,
  event: InferenceRunEvent,
): InferenceRun => {
  const incoming = event.run;
  const base = existing && existing.id === incoming.id ? existing : null;

  if (event.type === "events") {
    const fallback = base ?? { ...incoming, timeline: createTimeline() };
    const previousTimeline = fallback.timeline ?? createTimeline();
    return {
      ...fallback,
      status: incoming.status ?? fallback.status,
      pendingInterrupts: incoming.pendingInterrupts ?? fallback.pendingInterrupts,
      errorMessage: incoming.errorMessage ?? fallback.errorMessage ?? null,
      completedAt: incoming.completedAt ?? fallback.completedAt ?? null,
      cancelRequestedAt: incoming.cancelRequestedAt ?? fallback.cancelRequestedAt ?? null,
      updatedAt: incoming.updatedAt,
      timeline: event.events?.length
        ? reduceTimelineEvents(previousTimeline, event.events)
        : previousTimeline,
    };
  }

  if (event.type === "update" && base) {
    return {
      ...base,
      status: incoming.status ?? base.status,
      errorMessage: incoming.errorMessage ?? base.errorMessage ?? null,
      completedAt: incoming.completedAt ?? base.completedAt ?? null,
      cancelRequestedAt: incoming.cancelRequestedAt ?? base.cancelRequestedAt ?? null,
      updatedAt: incoming.updatedAt,
    };
  }

  return foldRunSnapshot(incoming);
};

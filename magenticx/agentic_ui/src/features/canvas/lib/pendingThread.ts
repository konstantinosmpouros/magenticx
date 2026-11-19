/**
 * "Show me the comment this came from" (plan 44 v2): the chat's card of a
 * message sent with `@agent` from a comment opens its document and asks the
 * canvas to open that thread's card.
 *
 * The same pattern as `pendingShine`: the canvas may not be open yet (it
 * mounts after the route changes) or may already be open on that document,
 * so the request is both kept (taken by a canvas that mounts for that path)
 * and announced (heard by one already open). Whoever handles it first clears it.
 */
export interface CanvasThreadRequest {
  path: string;
  /** The comment thread to open. */
  commentId: string;
}

const EVENT = "magenticx:canvas-thread";
let pending: CanvasThreadRequest | null = null;

/** Ask the canvas to open the card of thread `commentId` of `path`. */
export function requestCanvasThread(request: CanvasThreadRequest): void {
  pending = request;
  window.dispatchEvent(new CustomEvent<CanvasThreadRequest>(EVENT, { detail: request }));
}

/** The request for `path`, if one is waiting; taking it clears it. */
export function takeCanvasThread(path: string): CanvasThreadRequest | null {
  if (!pending || pending.path !== path) return null;
  const taken = pending;
  pending = null;
  return taken;
}

/** Hear requests while a canvas is open; returns the unsubscribe. */
export function onCanvasThread(listener: (request: CanvasThreadRequest) => void): () => void {
  const handle = (event: Event) => listener((event as CustomEvent<CanvasThreadRequest>).detail);
  window.addEventListener(EVENT, handle);
  return () => window.removeEventListener(EVENT, handle);
}

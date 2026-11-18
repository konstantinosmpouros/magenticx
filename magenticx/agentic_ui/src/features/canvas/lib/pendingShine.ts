/**
 * "Show me what that request changed" (plan 44, Phase 4.3): an Ask agent
 * card in the chat opens its document and asks the canvas to shine what the
 * agent wrote for that request — the change from the version the request was
 * made on to the agent's next version.
 *
 * The canvas may not be open yet (it mounts after the route changes) or may
 * already be open on that document, so the request is both kept (taken by a
 * canvas that mounts for that path) and announced (heard by one already
 * open). Whoever handles it first clears it.
 */
export interface CanvasShineRequest {
  path: string;
  /** The version the Ask agent request was made on. */
  afterVersion: number;
}

const EVENT = "magenticx:canvas-shine";
let pending: CanvasShineRequest | null = null;

/** Ask the canvas to shine what the agent changed after `afterVersion` of `path`. */
export function requestCanvasShine(request: CanvasShineRequest): void {
  pending = request;
  window.dispatchEvent(new CustomEvent<CanvasShineRequest>(EVENT, { detail: request }));
}

/** The request for `path`, if one is waiting; taking it clears it. */
export function takeCanvasShine(path: string): CanvasShineRequest | null {
  if (!pending || pending.path !== path) return null;
  const taken = pending;
  pending = null;
  return taken;
}

/** Hear requests while a canvas is open; returns the unsubscribe. */
export function onCanvasShine(listener: (request: CanvasShineRequest) => void): () => void {
  const handle = (event: Event) => listener((event as CustomEvent<CanvasShineRequest>).detail);
  window.addEventListener(EVENT, handle);
  return () => window.removeEventListener(EVENT, handle);
}

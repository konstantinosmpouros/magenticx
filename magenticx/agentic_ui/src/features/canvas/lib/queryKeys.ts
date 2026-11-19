/**
 * The TanStack Query keys of the canvas. Every query of one conversation
 * shares the prefix, so a finished run (or a save) can re-read them together;
 * a version's text is keyed by its number, or "latest".
 */
export const canvasKey = (userId: string, conversationId: string) =>
  ["canvas-documents", userId, conversationId] as const;

export const canvasListKey = (userId: string, conversationId: string) =>
  [...canvasKey(userId, conversationId), "list"] as const;

export const canvasVersionsKey = (userId: string, conversationId: string, path: string) =>
  [...canvasKey(userId, conversationId), "versions", path] as const;

export const canvasContentKey = (
  userId: string,
  conversationId: string,
  path: string,
  version: number | "latest",
) => [...canvasKey(userId, conversationId), "content", path, version] as const;

/** A document's comment threads and replies (Phase 4.4). */
export const canvasCommentsKey = (userId: string, conversationId: string, path: string) =>
  [...canvasKey(userId, conversationId), "comments", path] as const;

/**
 * The TanStack Query keys of the canvas. Every query of one conversation
 * shares the prefix, so a finished run (or a save) can re-read them together;
 * a version's text is keyed by its number, or "latest". Below the prefix,
 * each key names the message of the branch on screen (`messageId`): documents
 * are kept per branch, so another branch never reads this one's cache.
 */
export const canvasKey = (userId: string, conversationId: string) =>
  ["canvas-documents", userId, conversationId] as const;

export const canvasListKey = (userId: string, conversationId: string, messageId: string) =>
  [...canvasKey(userId, conversationId), messageId, "list"] as const;

export const canvasVersionsKey = (
  userId: string,
  conversationId: string,
  messageId: string,
  path: string,
) => [...canvasKey(userId, conversationId), messageId, "versions", path] as const;

export const canvasContentKey = (
  userId: string,
  conversationId: string,
  messageId: string,
  path: string,
  version: number | "latest",
) => [...canvasKey(userId, conversationId), messageId, "content", path, version] as const;

/** A document's comment threads and replies (Phase 4.4). */
export const canvasCommentsKey = (
  userId: string,
  conversationId: string,
  messageId: string,
  path: string,
) => [...canvasKey(userId, conversationId), messageId, "comments", path] as const;

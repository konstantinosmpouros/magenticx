/**
 * What the canvas remembers in this browser for Suggesting mode (plan 44,
 * Phase 4.6), like the app's other small `*Storage.ts` preferences:
 *
 * - the mode the user last picked from the mode menu, per user and per
 *   layout (a desktop that edits and a phone that reads keep their own);
 * - per document (user, conversation, path), the last version the user has
 *   reviewed: the base of the next suggestions (see `useCanvasSuggestions`).
 *
 * Every read and write is wrapped: storage can be missing (a private window,
 * blocked site data), and the canvas then works from its defaults.
 */
import type { CanvasMode } from "@/shared/lib/types";

const MODES: readonly CanvasMode[] = ["editing", "suggesting", "viewing"];

export type CanvasLayout = "desktop" | "phone";

const modeKey = (userId: string, layout: CanvasLayout) => `mx_canvas_mode:${userId}:${layout}`;

const reviewedKey = (userId: string, conversationId: string, path: string) =>
  `mx_canvas_reviewed:${userId}:${conversationId}:${path}`;

/** The mode last picked on this layout, or null (none, unknown, or no storage). */
export function loadCanvasMode(userId: string, layout: CanvasLayout): CanvasMode | null {
  try {
    const value = localStorage.getItem(modeKey(userId, layout));
    return MODES.find((mode) => mode === value) ?? null;
  } catch {
    return null;
  }
}

export function saveCanvasMode(userId: string, layout: CanvasLayout, mode: CanvasMode): void {
  try {
    localStorage.setItem(modeKey(userId, layout), mode);
  } catch {
    // No storage: the pick holds while the document is open.
  }
}

/** The last version of the document the user reviewed here, or null. */
export function loadReviewedVersion(
  userId: string,
  conversationId: string,
  path: string,
): number | null {
  try {
    const value = Number(localStorage.getItem(reviewedKey(userId, conversationId, path)));
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function saveReviewedVersion(
  userId: string,
  conversationId: string,
  path: string,
  version: number,
): void {
  try {
    localStorage.setItem(reviewedKey(userId, conversationId, path), String(version));
  } catch {
    // No storage: the review holds while the document is open.
  }
}

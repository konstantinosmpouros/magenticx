/**
 * The canvas mode the user last picked from the mode menu (plan 44 §3,
 * Phase 4.6) — Editing, Suggesting or Viewing — remembered in this browser
 * per user and per layout (a desktop that edits and a phone that reads keep
 * their own), like the app's other small `*Storage.ts` preferences. It is a
 * per-viewer choice: it only changes how this user's typing behaves.
 *
 * Every read and write is wrapped: storage can be missing (a private window,
 * blocked site data), and the canvas then works from its defaults.
 */
import type { CanvasMode } from "@/shared/lib/types";

const MODES: readonly CanvasMode[] = ["editing", "suggesting", "viewing"];

export type CanvasLayout = "desktop" | "phone";

const modeKey = (userId: string, layout: CanvasLayout) => `mx_canvas_mode:${userId}:${layout}`;

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

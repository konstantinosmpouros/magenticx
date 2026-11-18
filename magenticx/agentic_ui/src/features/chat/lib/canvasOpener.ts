/**
 * Opens a canvas document from inside the conversation (plan 44, Phase 4.1):
 * the artifact card of a presented `.md` reads this to offer "Open in
 * canvas". Provided by the chat page, which owns the canvas beside it; every
 * other place that renders messages (a public share, the agent builder's
 * Try it panel) provides nothing, so the card offers nothing there.
 */
import { createContext, useContext } from "react";

/**
 * Open `path` in the canvas. `anchor` is the element the user clicked: the
 * chat keeps it where it is on screen while the canvas narrows the column
 * (`keepInView`), instead of landing somewhere else.
 */
export type CanvasOpener = (
  path: string,
  anchor?: HTMLElement | null,
  options?: {
    /** From an Ask agent card: shine what the agent changed after this version. */
    shineAfterVersion?: number;
  },
) => void;

export const CanvasOpenerContext = createContext<CanvasOpener | null>(null);

/** The opener for the canvas beside this conversation, or null where there is none. */
export function useCanvasOpener(): CanvasOpener | null {
  return useContext(CanvasOpenerContext);
}

/**
 * Opens a canvas document from inside the conversation (plan 44, Phase 4.1):
 * the artifact card of a presented `.md` reads this to offer "Open in
 * canvas". Provided by the chat page, which owns the canvas beside it; every
 * other place that renders messages (a public share, the agent builder's
 * Try it panel) provides nothing, so the card offers nothing there.
 */
import { createContext, useContext } from "react";

export const CanvasOpenerContext = createContext<((path: string) => void) | null>(null);

/** The opener for the canvas beside this conversation, or null where there is none. */
export function useCanvasOpener(): ((path: string) => void) | null {
  return useContext(CanvasOpenerContext);
}

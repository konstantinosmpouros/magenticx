import { createContext, useContext } from "react";

/**
 * Which branch of the conversation the canvas shows (plan: branch-scoped
 * conversation files). The agent's documents, versions, comments and
 * suggestions are kept per branch, so every canvas call names a message of
 * the branch on screen and the bridge resolves the branch from it. The chat
 * provides the last saved message of the visible branch; the canvas hooks
 * read it here rather than taking it through every prop.
 */
export const CanvasBranchContext = createContext<string | null>(null);

/** The message whose branch the canvas reads and writes ("" outside a chat: every call then fails closed). */
export function useCanvasBranchMessage(): string {
  return useContext(CanvasBranchContext) ?? "";
}

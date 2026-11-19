/**
 * The agent's side of the comment cards (plan 44 v2) as a React context:
 * whether `@agent` is offered, which thread the agent is working on, and the
 * ask a saved `@agent` comment makes. The cards render inside popovers deep
 * under the margin marks; a context reaches them there without threading
 * props through every card. Outside the canvas the value is null: no
 * mention, no ask.
 */
import { createContext } from "react";

import type { CanvasCommentAgent } from "@/shared/lib/types";

export const CanvasCommentAgentContext = createContext<CanvasCommentAgent | null>(null);

import { CornerDownLeft } from "lucide-react";

import type { UserInterjectionBlock } from "@/shared/lib/types";

/**
 * Inside an answer: a message the user sent while the agent was working, drawn
 * at the step where the agent read it (USER_INTERJECTION, SSE plan phase 5).
 * It looks like the user's own bubble, only smaller and inside the answer, so
 * it reads as "you said this here" and the rest of the answer as the agent
 * taking it into account. Written from scratch: it is the chat's user bubble
 * (`ChatMessage`) at a smaller size, not a pattern shadcn/ui provides.
 */
export function UserInterjectionBlockView({ block }: { block: UserInterjectionBlock }) {
  return (
    <div className="flex flex-col items-end gap-1">
      <p className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
        <CornerDownLeft className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
        <span>You, while it worked</span>
      </p>
      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl border border-border bg-chat-user px-3.5 py-2 text-sm text-chat-user-foreground shadow-card [overflow-wrap:anywhere] md:max-w-[75%]">
        {block.text}
      </div>
    </div>
  );
}

/**
 * What a user message sent with Ask agent from the canvas was about (plan
 * 44, Phase 4.3): a small card above the bubble, like the attachment cards —
 *
 *   [✎]  brief
 *        “The first release covers markdown docu…”
 *
 * an icon tile, the document's name, and the start of the passage on its own
 * line, each cut with an ellipsis so the card keeps its size. Where the chat
 * has a canvas beside it, the card opens that document there; elsewhere (a
 * public share) it only says what the message was about.
 *
 * Sent with `@agent` from a comment (plan 44 v2, `commentId`): the second
 * line reads "Comment · <passage>" with a speech-bubble tile, and the click
 * also opens that thread's card in the canvas.
 *
 * A custom component because it is a reference card for a passage, which no
 * shadcn / AI Elements part covers; it borrows the attachment cards' shape
 * (a bordered, rounded tile with an icon) and the app's tokens.
 */
import { MessageSquareText, PencilLine } from "lucide-react";

import { canvasDocumentTitle } from "@/shared/lib/canvasDocuments";
import type { CanvasEditRef } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";
import { useCanvasOpener } from "@/features/chat/lib/canvasOpener";

/** The passage as one line of plain text (the card cuts it with an ellipsis). */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, 200);

export function CanvasEditChip({ edit }: { edit: CanvasEditRef }) {
  const openCanvas = useCanvasOpener();
  const title = canvasDocumentTitle(edit.path);
  const passage = oneLine(edit.selection);
  const fromComment = Boolean(edit.commentId);
  const Icon = fromComment ? MessageSquareText : PencilLine;

  const content = (
    <>
      <span
        aria-hidden="true"
        className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
      >
        <Icon className="size-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
        <span className="truncate text-[13px] font-medium leading-tight text-foreground">
          {title}
        </span>
        <span className="truncate text-xs leading-tight text-muted-foreground">
          {fromComment ? `Comment · ${passage}` : passage}
        </span>
      </span>
    </>
  );
  const card =
    "flex w-[min(20rem,100%)] items-center gap-2.5 rounded-xl border border-border/70 bg-card px-2.5 py-2";

  if (!openCanvas) {
    return <div className={card}>{content}</div>;
  }
  return (
    <button
      type="button"
      // Lands on the latest version, with this request's change shining.
      onClick={(event) =>
        openCanvas(edit.path, event.currentTarget, {
          shineAfterVersion: edit.version,
          ...(edit.commentId ? { commentId: edit.commentId } : {}),
        })
      }
      aria-label={
        fromComment
          ? `Open ${title} in the canvas, on the comment. The passage: ${passage}`
          : `Open ${title} in the canvas. The passage: ${passage}`
      }
      title={`Open ${title} · v${edit.version}`}
      className={cn(
        card,
        "transition-colors duration-150 hover:border-border hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      {content}
    </button>
  );
}

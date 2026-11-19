/**
 * The comments on the text (plan 44, Phase 4.4), the way Claude Docs shows
 * them: a speech bubble and a count in the reading column's right margin,
 * beside the line where commented passages start, and a card that opens
 * under it with that line's threads (`CanvasCommentThreads`). There is no
 * side panel: the mark is how the user sees how many threads there are and
 * where, and the card is where they are read, answered and resolved.
 *
 * Several threads starting on one line share one mark (its count the number
 * of threads) and one card. The open card's mark is tinted, as its passage
 * is. Threads with no line to sit on (their text changed, or resolved) are
 * reached from one more mark at the top of the margin
 * (`CanvasOtherComments`).
 *
 * Written from scratch around the app's Popover: margin annotations are
 * positioned from the text's own layout (DOM ranges measured by
 * `CanvasDocumentView`); no prebuilt component (shadcn, AI Elements, Radix)
 * places anything against text lines.
 */
import { useState, type ReactNode } from "react";
import { PiChatCircle, PiChatsCircle } from "react-icons/pi";

import type { CanvasCommentMarker, CanvasOtherCommentsMark } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";

import { CanvasHint } from "./CanvasHint";

const MARK =
  // In the right margin, centred on its line. A phone's margin is 24px: the
  // count goes under the bubble there.
  "absolute left-[calc(100%+3px)] z-10 flex -translate-y-1/2 flex-col items-center gap-px rounded-md px-0.5 py-0.5 text-[10px] font-medium tabular-nums leading-none transition-colors duration-150 " +
  "sm:left-[calc(100%+10px)] sm:flex-row sm:gap-1 sm:px-1.5 sm:text-xs " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring " +
  // A finger gets a bigger target than the mark it can see.
  "before:absolute before:-inset-x-1 before:-inset-y-2 before:content-[''] " +
  "data-[state=open]:bg-warning/15 data-[state=open]:text-foreground";

const CARD =
  "w-[min(22rem,calc(100vw-1.5rem))] max-h-[min(30rem,70vh)] overflow-y-auto overscroll-contain rounded-2xl p-0 shadow-xl shadow-foreground/10";

export function CanvasCommentMarkers({
  markers,
  activeId,
  onOpen,
  onClose,
  renderThreads,
  others,
}: {
  markers: CanvasCommentMarker[];
  /** The thread whose card is open (null: none). */
  activeId: string | null;
  /** Open the card of the line holding this thread. */
  onOpen: (id: string) => void;
  onClose: () => void;
  /** The card's content for a line's threads. */
  renderThreads: (ids: string[]) => ReactNode;
  others: CanvasOtherCommentsMark | null;
}) {
  const [othersOpen, setOthersOpen] = useState(false);

  return (
    <>
      {markers.map((marker) => {
        const count = marker.ids.length;
        const open = activeId !== null && marker.ids.includes(activeId);
        return (
          <Popover
            key={marker.ids[0]}
            open={open}
            onOpenChange={(next) => (next ? onOpen(marker.ids[0]) : onClose())}
          >
            <CanvasHint
              side="left"
              label={count === 1 ? "Open comment" : `Open ${count} comments`}
            >
              <PopoverTrigger
                aria-label={
                  count === 1 ? "1 comment on this line" : `${count} comments on this line`
                }
                // The column's own click handler reads clicks on passages.
                onClick={(event) => event.stopPropagation()}
                style={{ top: marker.top + marker.height / 2 }}
                className={cn(
                  MARK,
                  !open && "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <PiChatCircle className="size-3.5 shrink-0 sm:size-4" aria-hidden="true" />
                <span>{count}</span>
              </PopoverTrigger>
            </CanvasHint>
            <PopoverContent
              side="bottom"
              align="end"
              sideOffset={6}
              collisionPadding={12}
              className={CARD}
              aria-label={count === 1 ? "Comment" : `${count} comments`}
              // The caret stays where it was; the card is read, then clicked into.
              onOpenAutoFocus={(event) => event.preventDefault()}
              onCloseAutoFocus={(event) => event.preventDefault()}
            >
              {renderThreads(marker.ids)}
            </PopoverContent>
          </Popover>
        );
      })}

      {others && others.count > 0 ? (
        <Popover open={othersOpen} onOpenChange={setOthersOpen}>
          <CanvasHint side="left" label="Comments on changed text, and resolved">
            <PopoverTrigger
              aria-label={`${others.count} more ${others.count === 1 ? "comment" : "comments"}: on changed text or resolved`}
              onClick={(event) => event.stopPropagation()}
              style={{ top: 14 }}
              className={cn(
                MARK,
                !othersOpen && "text-muted-foreground/70 hover:bg-muted hover:text-foreground",
              )}
            >
              <PiChatsCircle className="size-3.5 shrink-0 sm:size-4" aria-hidden="true" />
              <span>{others.count}</span>
            </PopoverTrigger>
          </CanvasHint>
          <PopoverContent
            side="bottom"
            align="end"
            sideOffset={6}
            collisionPadding={12}
            className={CARD}
            aria-label="Other comments"
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            {others.render()}
          </PopoverContent>
        </Popover>
      ) : null}
    </>
  );
}

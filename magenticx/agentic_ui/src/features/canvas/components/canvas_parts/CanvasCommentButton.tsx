/**
 * Comment on a touch screen (plan 44, Phase 4.4), where there is no floating
 * selection menu: a Comment button shown only while text is selected — in
 * the pill toolbar beside Ask agent while editing, and on its own in a small
 * bar at the bottom while reading (a comment needs no editing). It acts on
 * the selection as it was when the button was pressed (a tap may collapse
 * it) and opens the composer in a popover above.
 */
import { useEffect, useRef, useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import type { TRange } from "platejs";
import { useEditorRef } from "platejs/react";

import type { CanvasAskPassage, CanvasCommentControl } from "@/shared/lib/types";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";

import { useCoarsePointer } from "../../hooks/useCoarsePointer";
import { useSelectedPassage } from "../../hooks/useSelectedPassage";
import { selectedPassage } from "../../lib/askAgent";
import { showAskHighlight } from "../../lib/askHighlight";
import { captureAnchor, type CanvasAnchorCapture } from "../../lib/commentAnchors";
import { rememberSelection, restoreSelection } from "../../lib/selectionMemory";
import { CanvasCommentForm } from "./CanvasCommentForm";
import { CanvasHint } from "./CanvasHint";

const keepSelection = (event: React.MouseEvent) => event.preventDefault();

export function CanvasCommentButton({
  comment,
  onHold,
}: {
  comment: CanvasCommentControl;
  /** Keeps the button shown from the tap until its popover closes. */
  onHold: (held: boolean) => void;
}) {
  const editor = useEditorRef();
  const [open, setOpen] = useState(false);
  const pressed = useRef<CanvasAskPassage | null>(null);
  const [target, setTarget] = useState<{
    range: TRange;
    capture: CanvasAnchorCapture | null;
  } | null>(null);
  const tinted = open && target?.capture?.kind === "anchor" ? target.range : null;
  useEffect(() => (tinted ? showAskHighlight(editor, tinted) : undefined), [editor, tinted]);

  // Sent once the popover has closed (its focus handed back first).
  const pending = useRef<(() => void) | null>(null);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          restoreSelection(editor);
          const passage = pressed.current ?? selectedPassage(editor);
          setTarget(
            passage
              ? { range: passage.range, capture: captureAnchor(editor, passage.range) }
              : null,
          );
        }
        onHold(next);
        setOpen(next);
      }}
    >
      <CanvasHint label="Comment on the selection" side="top">
        <PopoverTrigger
          aria-label="Comment"
          onPointerDown={() => {
            onHold(true);
            rememberSelection(editor);
            pressed.current = selectedPassage(editor);
          }}
          onMouseDown={keepSelection}
          className="flex h-9 shrink-0 items-center gap-1.5 rounded-full pl-2.5 pr-3 text-[13px] font-semibold text-foreground/85 transition-colors duration-150 [touch-action:manipulation] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted [@media(pointer:coarse)]:h-11 [@media(pointer:fine)]:h-8 [&_svg]:size-4"
        >
          <MessageSquarePlus aria-hidden="true" />
          Comment
        </PopoverTrigger>
      </CanvasHint>
      <PopoverContent
        side="top"
        align="start"
        collisionPadding={12}
        className="w-[min(22rem,calc(100vw-1.5rem))] p-2"
        onOpenAutoFocus={(event) => {
          if (target?.capture?.kind !== "anchor") event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const run = pending.current;
          pending.current = null;
          run?.();
        }}
      >
        {target?.capture?.kind === "anchor" ? (
          <CanvasCommentForm
            label="Comment on the selected text"
            placeholder="Add a comment…"
            onSubmit={(body) => {
              const anchor = target.capture?.kind === "anchor" ? target.capture.anchor : null;
              pending.current = anchor ? () => comment.onCreate(anchor, body) : null;
              setOpen(false);
            }}
            onCancel={() => setOpen(false)}
          />
        ) : (
          <p role="status" className="px-1.5 py-1 text-sm text-muted-foreground">
            {target?.capture?.kind === "problem"
              ? target.capture.message
              : "Select some text first"}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Reading on a touch screen: Comment alone, in a small bar at the bottom,
 * while text is selected. The pill toolbar is an editing tool, so it is not
 * there while reading.
 */
export function CanvasReadingCommentBar({ comment }: { comment: CanvasCommentControl }) {
  const coarse = useCoarsePointer();
  const selection = useSelectedPassage();
  const [held, setHeld] = useState(false);
  if (!coarse || (selection === null && !held)) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-6 z-20 flex justify-center px-3">
      <div
        role="toolbar"
        aria-label="Selection"
        className="pointer-events-auto flex items-center rounded-[22px] border border-border/70 bg-background/95 p-1 shadow-lg shadow-foreground/5 backdrop-blur-md animate-in fade-in-0 slide-in-from-bottom-2 duration-200 motion-reduce:animate-none"
      >
        <CanvasCommentButton comment={comment} onHold={setHeld} />
      </div>
    </div>
  );
}

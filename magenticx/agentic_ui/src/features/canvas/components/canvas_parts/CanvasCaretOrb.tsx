/**
 * The orb at the caret (plan 44 §3), Claude Docs' spark in our own mark:
 * while editing with a mouse, rest the caret in a block (nothing selected)
 * and the app's orb fades in at the right end of that line, just outside the
 * reading column — clear of the text and of the headings' fold chevrons,
 * which sit inside the column. Clicking it opens the Ask agent panel for the
 * whole block (input + presets); the request is the same as a selection's
 * (`blockPassage` → `buildCanvasEdit`).
 *
 * When it shows is `useCaretOrb`'s business (idle, focused, no selection);
 * the parent mounts it only where it can (editing, not touch, not while the
 * agent edits, with a conversation to send into). Under reduced motion the
 * orb holds still (`Orb`) and only fades.
 *
 * Custom: no prebuilt component places an action at the caret's line; it is
 * built from our Popover, tooltip and the shared `Orb`.
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import type { TElement } from "platejs";
import { useEditorRef } from "platejs/react";

import type { CanvasAskControl, CanvasAskPassage, CanvasEditPreset } from "@/shared/lib/types";
import { Orb } from "@/shared/ui/orb";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";

import { useCaretOrb, type CaretOrbSpot } from "../../hooks/useCaretOrb";
import { blockPassage } from "../../lib/askAgent";
import { showAskHighlight } from "../../lib/askHighlight";
import { blockNoun } from "../../lib/caretOrb";
import { CanvasAskCard } from "./CanvasAskPanel";
import { CanvasHint } from "./CanvasHint";

const holdFocus = (event: React.PointerEvent | React.MouseEvent) => event.preventDefault();

export function CanvasCaretOrb({
  ask,
  columnRef,
}: {
  ask: CanvasAskControl;
  /** The reading column the orb is placed in (it must be `position: relative`). */
  columnRef: RefObject<HTMLElement | null>;
}) {
  const editor = useEditorRef();
  const spot = useCaretOrb(ask.disabledReason === null, columnRef);
  const [open, setOpen] = useState(false);
  // The block the panel was opened for: it stays put while the focus is in the input.
  const [held, setHeld] = useState<{
    spot: CaretOrbSpot;
    passage: CanvasAskPassage;
    noun: string;
  } | null>(null);
  const tinted = open ? (held?.passage.range ?? null) : null;
  useEffect(() => (tinted ? showAskHighlight(editor, tinted) : undefined), [editor, tinted]);

  // Sent once the popover has closed (its focus handed back first): the
  // request may open the Save and send dialog.
  const pending = useRef<(() => void) | null>(null);
  const send = (instruction: string, preset?: CanvasEditPreset) => {
    const passage = held?.passage;
    pending.current = passage ? () => ask.onAsk({ passage, instruction, preset }) : null;
    setOpen(false);
  };

  const shown = open ? (held?.spot ?? null) : spot;
  if (!shown) return null;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          const passage = blockPassage(editor, shown.index);
          if (!passage) return;
          setHeld({
            spot: shown,
            passage,
            noun: blockNoun(editor.children[shown.index] as TElement | undefined),
          });
        }
        setOpen(next);
      }}
    >
      <CanvasHint label="Ask agent" side="right">
        <PopoverTrigger
          aria-label="Ask agent"
          data-canvas-caret-orb=""
          contentEditable={false}
          onPointerDown={holdFocus}
          onMouseDown={holdFocus}
          style={{ top: shown.top }}
          // Just outside the column's right edge, inside the editing
          // margin (sm:px-10 while editing); the heading chevrons are inside.
          className="absolute left-[calc(100%+2px)] z-10 flex size-7 -translate-y-1/2 select-none items-center justify-center rounded-full transition-colors animate-in fade-in-0 zoom-in-75 duration-200 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted motion-reduce:zoom-in-100 sm:left-[calc(100%+8px)]"
        >
          <Orb size={18} />
        </PopoverTrigger>
      </CanvasHint>
      <PopoverContent
        side="bottom"
        align="end"
        collisionPadding={12}
        className="w-[min(24rem,calc(100vw-1.5rem))] p-2"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const run = pending.current;
          pending.current = null;
          if (run) run();
          else editor.tf.focus();
        }}
      >
        <CanvasAskCard
          caption={`Ask about this ${held?.noun ?? "paragraph"}`}
          onSend={send}
          onClose={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * The floating pill toolbar at the bottom of the document while editing
 * (plan 44 §3, the Claude Docs bar): Ask agent (Phase 4.3) and Comment (Phase
 * 4.4) — on touch only, first and distinct: they act on the selection — text style, bold / italic /
 * strikethrough / code, bulleted / numbered / checklist, link, table, quote,
 * block actions. Undo / redo sit at the top, beside the outline button
 * (`CanvasDocBar`). No fixed toolbar in the header: the document owns the
 * panel.
 *
 * Adapted from Plate's shadcn registry (`toolbar`, `mark-toolbar-button`,
 * `list-toolbar-button`, `turn-into-toolbar-button`, `link-toolbar-button`,
 * `table-toolbar-button`) and driven by the same Plate hooks they use. The
 * registry's toolbar is built on `@radix-ui/react-toolbar`; this one is a
 * plain `role="toolbar"` row with the app's own button, menu, popover and
 * tooltip, so no new Radix package (and no second dismissable-layer copy)
 * comes in for one bar.
 * The controls themselves (text style, marks, lists, link) live in
 * `CanvasFormatControls`, shared with the floating selection bar.
 *
 * Every control keeps the editor's selection on a desktop *and* a phone:
 * `pointerdown` remembers the selection and (for plain buttons) prevents the
 * focus move, so the editor — and a phone's keyboard — stay put; the command
 * puts the remembered selection back first, in case a tap collapsed it
 * (`lib/selectionMemory.ts`). With blocks selected (block selection), marks
 * and styles apply to all of them. With a mouse every control is shown,
 * compact, wrapping to a second row in a narrow canvas (never a scrollbar);
 * on touch the pill scrolls sideways, and rises above the on-screen keyboard.
 */
import { useEffect, useRef, useState } from "react";
import { GripVertical, TextQuote } from "lucide-react";
import { KEYS } from "platejs";
import { useEditorRef, useEditorSelector } from "platejs/react";

import type {
  CanvasAskControl,
  CanvasAskPassage,
  CanvasCommentControl,
  CanvasEditPreset,
} from "@/shared/lib/types";
import { DropdownMenu, DropdownMenuTrigger } from "@/shared/ui/dropdown-menu";
import { Orb } from "@/shared/ui/orb";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";

import { useCoarsePointer } from "../../hooks/useCoarsePointer";
import { useNarrowWidth } from "../../hooks/useNarrowWidth";
import { useKeyboardInset } from "../../hooks/useKeyboardInset";
import { useSelectedPassage } from "../../hooks/useSelectedPassage";
import { passageProblem, selectedPassage } from "../../lib/askAgent";
import { showAskHighlight } from "../../lib/askHighlight";
import { isSelectingBlocks, targetBlocks, turnInto } from "../../lib/blockCommands";
import { inQuote, toggleQuote } from "../../lib/editorCommands";
import { rememberSelection, restoreSelection } from "../../lib/selectionMemory";
import { CANVAS_TOOL_BUTTON, keepSelection } from "../../lib/toolbarControls";
import { CanvasAskCard } from "./CanvasAskPanel";
import { CanvasBlockMenuContent } from "./CanvasBlockMenu";
import { CanvasCommentButton } from "./CanvasCommentButton";
import { CanvasHint } from "./CanvasHint";
import { CanvasTablePicker } from "./CanvasTablePicker";
import {
  LinkButton,
  ListButtons,
  MarkButtons,
  TextStyleMenu,
  ToolButton,
} from "./CanvasFormatControls";

/**
 * The block menu from the toolbar: the way to Delete / Duplicate / Move /
 * Turn into on a phone, where there is no hover handle — it acts on the
 * blocks the caret or the selection is in (or the selected blocks).
 */
function BlockMenuButton() {
  const editor = useEditorRef();
  return (
    <DropdownMenu modal={false}>
      <CanvasHint label="Block actions" side="top">
        <DropdownMenuTrigger
          aria-label="Block actions"
          onPointerDown={() => rememberSelection(editor)}
          onMouseDown={keepSelection}
          className={CANVAS_TOOL_BUTTON}
        >
          <GripVertical />
        </DropdownMenuTrigger>
      </CanvasHint>
      <CanvasBlockMenuContent side="top" align="center" />
    </DropdownMenu>
  );
}

/**
 * Ask agent in the pill (plan 44 §3): the way in on a touch screen, where
 * there is no floating selection menu, shown only while text is selected (a
 * mouse uses the floating menu over the selection instead). It acts on the
 * selection (or the selected blocks) as it was when the button was pressed —
 * a tap may collapse it — and opens the input with the presets under it.
 * Unusable (nothing selected, too much, a reply streaming) it stays
 * focusable, says why in its tooltip, and a tap shows the reason.
 */
function AskAgentButton({
  ask,
  onHold,
}: {
  ask: CanvasAskControl;
  /** Keeps the button shown from the tap until its popover closes (a tap may collapse the selection). */
  onHold: (held: boolean) => void;
}) {
  const editor = useEditorRef();
  const live = useSelectedPassage();
  const [open, setOpen] = useState(false);
  const [passage, setPassage] = useState<CanvasAskPassage | null>(null);
  const pressed = useRef<CanvasAskPassage | null>(null);
  const reason = ask.disabledReason ?? passageProblem(live);
  const shownReason = ask.disabledReason ?? passageProblem(passage);
  const tinted = open && !shownReason ? passage : null;
  useEffect(() => (tinted ? showAskHighlight(editor, tinted.range) : undefined), [editor, tinted]);

  // Sent once the popover has closed, not while it closes: the request may
  // open the Save and send dialog, and a dialog opening while the popover
  // hands its focus back would see that as a click outside and close again.
  const pending = useRef<(() => void) | null>(null);
  const send = (instruction: string, preset?: CanvasEditPreset) => {
    const picked = passage;
    pending.current = picked ? () => ask.onAsk({ passage: picked, instruction, preset }) : null;
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          restoreSelection(editor);
          setPassage(pressed.current ?? selectedPassage(editor));
        }
        onHold(next);
        setOpen(next);
      }}
    >
      <CanvasHint label={reason ?? "Ask the agent to change the selection"} side="top">
        <PopoverTrigger
          aria-label="Ask agent"
          aria-disabled={reason ? true : undefined}
          onPointerDown={() => {
            onHold(true);
            rememberSelection(editor);
            pressed.current = selectedPassage(editor);
          }}
          onMouseDown={keepSelection}
          className="flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-primary/10 pl-2.5 pr-3 text-[13px] font-semibold text-primary transition-colors duration-150 [touch-action:manipulation] hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-disabled:bg-transparent aria-disabled:text-muted-foreground data-[state=open]:bg-primary/15 [@media(pointer:coarse)]:h-11 [@media(pointer:fine)]:h-8 [&_svg]:size-4"
        >
          <Orb size={18} />
          Ask agent
        </PopoverTrigger>
      </CanvasHint>
      <PopoverContent
        side="top"
        align="start"
        className="w-[min(24rem,calc(100vw-1.5rem))] p-2"
        onOpenAutoFocus={(event) => {
          // The input focuses itself; with nothing to send, keep the focus put.
          if (shownReason) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const run = pending.current;
          pending.current = null;
          run?.();
        }}
      >
        {shownReason ? (
          <p role="status" className="px-1.5 py-1 text-sm text-muted-foreground">
            {shownReason}
          </p>
        ) : (
          <CanvasAskCard onSend={send} onClose={() => setOpen(false)} />
        )}
      </PopoverContent>
    </Popover>
  );
}

/** The canvas width under which the full pill no longer fits on one row. */
const NARROW_PILL_PX = 600;
/** Narrower still (a side panel open beside the document): no dividers, no gaps, so it still fits one row. */
const TIGHT_PILL_PX = 500;

const Divider = () => (
  <span
    aria-hidden="true"
    className="mx-1 h-5 w-px shrink-0 bg-border [@media(pointer:fine)]:mx-0.5 group-data-[tight]/pill:hidden"
  />
);

export function CanvasToolbar({
  ask,
  comment = null,
}: {
  ask?: CanvasAskControl | null;
  comment?: CanvasCommentControl | null;
}) {
  const editor = useEditorRef();
  const quoted = useEditorSelector((ed) => inQuote(ed), []);
  const anchorRef = useRef<HTMLDivElement>(null);
  const keyboard = useKeyboardInset(anchorRef);
  // Ask agent and Comment in the pill: touch only, and only while something
  // is selected (or one's popover is open). A mouse gets the floating menu
  // over the selection.
  const coarse = useCoarsePointer();
  const selection = useSelectedPassage();
  const [askHeld, setAskHeld] = useState(false);
  const [commentHeld, setCommentHeld] = useState(false);
  // Below this width the full pill would wrap: the style menu turns to an icon.
  const narrow = useNarrowWidth(anchorRef, NARROW_PILL_PX);
  const tight = useNarrowWidth(anchorRef, TIGHT_PILL_PX);
  const showSelectionTools = coarse && (selection !== null || askHeld || commentHeld);

  return (
    <div
      ref={anchorRef}
      data-canvas-toolbar=""
      className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-3 sm:bottom-6"
      // Above a phone's on-screen keyboard, which covers the canvas bottom.
      style={keyboard > 0 ? { transform: `translateY(-${keyboard}px)` } : undefined}
    >
      <div
        role="toolbar"
        aria-label="Formatting"
        aria-orientation="horizontal"
        data-tight={tight ? "" : undefined}
        className="group/pill pointer-events-auto flex max-w-full items-center gap-0.5 data-[tight]:gap-0 rounded-[22px] border [@media(pointer:coarse)]:overflow-x-auto [@media(pointer:fine)]:flex-wrap [@media(pointer:fine)]:justify-center border-border/70 bg-background/95 p-1 shadow-lg shadow-foreground/5 backdrop-blur-md [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [@media(pointer:coarse)]:pr-8 [@media(pointer:coarse)]:[mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)] animate-in fade-in-0 slide-in-from-bottom-2 duration-200 motion-reduce:animate-none"
      >
        {showSelectionTools && (ask || comment) ? (
          <>
            {ask ? <AskAgentButton ask={ask} onHold={setAskHeld} /> : null}
            {comment ? <CanvasCommentButton comment={comment} onHold={setCommentHeld} /> : null}
            <Divider />
          </>
        ) : null}
        <TextStyleMenu variant={narrow ? "icon" : "label"} />
        <Divider />
        <MarkButtons />
        <Divider />
        <ListButtons />
        <Divider />
        <LinkButton />
        <CanvasTablePicker triggerClassName={CANVAS_TOOL_BUTTON} />
        <ToolButton
          label="Quote"
          pressed={quoted}
          onClick={() => {
            if (!isSelectingBlocks(editor)) return toggleQuote(editor);
            // Selected blocks: all quotes already → back to text, else one quote.
            const allQuoted = targetBlocks(editor).every(([node]) => node.type === KEYS.blockquote);
            turnInto(editor, allQuoted ? KEYS.p : KEYS.blockquote);
          }}
        >
          <TextQuote />
        </ToolButton>
        <BlockMenuButton />
      </div>
    </div>
  );
}

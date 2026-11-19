/**
 * The floating pill at the bottom of the document while editing (plan 44
 * §3), Claude Docs' bottom bar in our tokens: block-level tools, icon-only,
 * and a filled Ask agent at the end —
 *
 *   Tт▾ · table · checklist · quote · ⋯ · comment   (◉ Ask agent)
 *
 * The ⋯ menu holds the bulleted and numbered lists, the code block and the
 * block actions (Duplicate, Move up / down, Turn into, Delete) — the way to
 * them on a phone, where there is no hover handle. Bold / italic /
 * strikethrough / code and link live in the floating bar over a selection
 * (`CanvasSelectionMenu`; their shortcuts work everywhere). A touch screen
 * has no such bar, so there, while text is selected, the pill shows the marks
 * and link in place of table / checklist / quote. **Ask agent** acts on the
 * selection or, with only a caret, on the caret's whole block (the same
 * block the orb at the caret offers). Undo / redo sit at the top, in the
 * document's row (`CanvasDocBar`).
 *
 * Adapted from Plate's shadcn registry (`toolbar`, `turn-into-toolbar-button`,
 * `table-toolbar-button`, `more-toolbar-button`) and driven by the same
 * Plate hooks. The registry's toolbar is built on `@radix-ui/react-toolbar`;
 * this one is a plain `role="toolbar"` row with the app's own button, menu,
 * popover and tooltip, so no new Radix package (and no second
 * dismissable-layer copy) comes in for one bar.
 *
 * Every control keeps the editor's selection on a desktop *and* a phone:
 * `pointerdown` remembers the selection and (for plain buttons) prevents the
 * focus move, so the editor — and a phone's keyboard — stay put; the command
 * puts the remembered selection back first, in case a tap collapsed it
 * (`lib/selectionMemory.ts`). With blocks selected (block selection), styles
 * apply to all of them. The pill is one row at every canvas width: in a
 * narrow canvas Ask agent drops its label (the orb alone), and narrower still
 * (a side panel open in a small window) checklist and quote move into ⋯; on
 * touch the tools scroll sideways under a fade while Ask agent stays in view,
 * and the pill rises above the on-screen keyboard. In Suggesting mode
 * (Phase 4.6) the pill keeps only Comment and Ask agent: the user's typing
 * becomes suggestions, but a block style or a table would not.
 */
import { useEffect, useRef, useState } from "react";
import type { IconType } from "react-icons";
import { PiCheck, PiCodeBlock, PiDotsThree, PiQuotes } from "react-icons/pi";
import { KEYS, type TElement } from "platejs";
import { useEditorRef, useEditorSelector } from "platejs/react";

import type {
  CanvasAskControl,
  CanvasAskPassage,
  CanvasCommentControl,
  CanvasEditPreset,
} from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";
import { DropdownMenu, DropdownMenuItem, DropdownMenuTrigger } from "@/shared/ui/dropdown-menu";
import { Orb } from "@/shared/ui/orb";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";

import { useCoarsePointer } from "../../hooks/useCoarsePointer";
import { useKeyboardInset } from "../../hooks/useKeyboardInset";
import { useNarrowWidth } from "../../hooks/useNarrowWidth";
import { useSelectedPassage } from "../../hooks/useSelectedPassage";
import { caretPassage, passageProblem, selectedPassage } from "../../lib/askAgent";
import { showAskHighlight } from "../../lib/askHighlight";
import {
  blockKind,
  blocksById,
  idsOf,
  isSelectingBlocks,
  targetBlocks,
  turnInto,
} from "../../lib/blockCommands";
import { blockNoun } from "../../lib/caretOrb";
import { inQuote, toggleQuote } from "../../lib/editorCommands";
import { rememberSelection, restoreSelection } from "../../lib/selectionMemory";
import { CANVAS_TOOL_BUTTON, keepSelection } from "../../lib/toolbarControls";
import { CanvasAskCard } from "./CanvasAskPanel";
import { CanvasBlockMenuContent } from "./CanvasBlockMenu";
import { CanvasCommentButton } from "./CanvasCommentButton";
import {
  LinkButton,
  ListMenuItems,
  MarkButtons,
  TextStyleMenu,
  TodoButton,
  ToolButton,
} from "./CanvasFormatControls";
import { CanvasHint } from "./CanvasHint";
import { CanvasTablePicker } from "./CanvasTablePicker";

/**
 * A ⋯ menu row that turns the target blocks into one kind (code block,
 * quote), or back into text when they all are that kind already.
 */
function TurnIntoItem({
  kind,
  label,
  icon: Icon,
}: {
  kind: typeof KEYS.codeBlock | typeof KEYS.blockquote;
  label: string;
  icon: IconType;
}) {
  const editor = useEditorRef();
  // Taken as the menu opens (it mounts then), like the block actions below it.
  const [targets] = useState(() => {
    restoreSelection(editor);
    const entries = targetBlocks(editor);
    return {
      ids: idsOf(entries),
      asBlocks: isSelectingBlocks(editor),
      already: entries.length > 0 && entries.every(([node]) => blockKind(node) === kind),
    };
  });
  return (
    <DropdownMenuItem
      className="gap-2 [@media(pointer:coarse)]:min-h-11"
      onSelect={() =>
        turnInto(
          editor,
          targets.already ? KEYS.p : kind,
          blocksById(editor, targets.ids),
          targets.asBlocks,
        )
      }
    >
      <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
      <span className="flex-1">{label}</span>
      {targets.already ? <PiCheck className="size-4 text-primary" aria-label="Current" /> : null}
    </DropdownMenuItem>
  );
}

/**
 * ⋯ More: the lists the pill has no room for, the code block, and the block
 * actions — on the blocks the caret or the selection is in (or the selected
 * blocks). In a tight pill the checklist and quote come in here too.
 */
function MoreMenu({ tight }: { tight: boolean }) {
  const editor = useEditorRef();
  return (
    <DropdownMenu modal={false}>
      <CanvasHint label="More" side="top">
        <DropdownMenuTrigger
          aria-label="More"
          onPointerDown={() => rememberSelection(editor)}
          onMouseDown={keepSelection}
          className={CANVAS_TOOL_BUTTON}
        >
          <PiDotsThree />
        </DropdownMenuTrigger>
      </CanvasHint>
      <CanvasBlockMenuContent
        side="top"
        align="center"
        label="More"
        leading={
          <>
            <ListMenuItems kinds={tight ? undefined : [KEYS.ul, KEYS.ol]} />
            {tight ? <TurnIntoItem kind={KEYS.blockquote} label="Quote" icon={PiQuotes} /> : null}
            <TurnIntoItem kind={KEYS.codeBlock} label="Code block" icon={PiCodeBlock} />
          </>
        }
      />
    </DropdownMenu>
  );
}

/**
 * Ask agent in the pill (plan 44 §3): a filled button at the end, the orb
 * and its name (the orb alone in a narrow canvas). It acts on the selection
 * (or the selected blocks) as it was when the button was pressed — a tap may
 * collapse it — or, with only a caret, on the caret's whole block, and opens
 * the input with the presets under it. Unusable (nothing to act on, too
 * much, a reply streaming) it stays focusable, says why in its tooltip, and a
 * press shows the reason.
 */
function AskAgentButton({ ask, compact }: { ask: CanvasAskControl; compact: boolean }) {
  const editor = useEditorRef();
  const selected = useSelectedPassage();
  const live = useSelectedPassage({ caretBlock: true });
  const [open, setOpen] = useState(false);
  const [held, setHeld] = useState<{ passage: CanvasAskPassage | null; caption?: string }>({
    passage: null,
  });
  const pressed = useRef<{ passage: CanvasAskPassage | null; caption?: string } | null>(null);
  const reason = ask.disabledReason ?? (live ? passageProblem(live) : NOTHING_TO_ASK);
  const shownReason =
    ask.disabledReason ?? (held.passage ? passageProblem(held.passage) : NOTHING_TO_ASK);
  const tinted = open && !shownReason ? held.passage : null;
  useEffect(() => (tinted ? showAskHighlight(editor, tinted.range) : undefined), [editor, tinted]);

  /** The passage now: the selection, else the caret's block (with a caption naming it). */
  const take = () => {
    const passage = selectedPassage(editor);
    if (passage) return { passage };
    const block = caretPassage(editor);
    if (!block) return { passage: null };
    const node = editor.children[block.range.anchor.path[0]] as TElement | undefined;
    return { passage: block, caption: `Ask about this ${blockNoun(node)}` };
  };

  // Sent once the popover has closed, not while it closes: the request may
  // open the Save and send dialog, and a dialog opening while the popover
  // hands its focus back would see that as a click outside and close again.
  const pending = useRef<(() => void) | null>(null);
  const send = (instruction: string, preset?: CanvasEditPreset) => {
    const picked = held.passage;
    pending.current = picked ? () => ask.onAsk({ passage: picked, instruction, preset }) : null;
    setOpen(false);
  };

  const hint =
    reason ??
    (selected ? "Ask the agent to change the selection" : "Ask the agent to change this block");

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          restoreSelection(editor);
          setHeld(pressed.current ?? take());
          pressed.current = null;
        }
        setOpen(next);
      }}
    >
      <CanvasHint label={hint} side="top">
        <PopoverTrigger
          aria-label="Ask agent"
          aria-disabled={reason ? true : undefined}
          onPointerDown={() => {
            rememberSelection(editor);
            pressed.current = take();
          }}
          onMouseDown={keepSelection}
          className={cn(
            "flex shrink-0 items-center justify-center gap-1.5 rounded-full bg-foreground text-[13px] font-medium text-background shadow-sm transition-[background-color,opacity] duration-150 motion-reduce:transition-none [touch-action:manipulation] hover:bg-foreground/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background aria-disabled:bg-muted aria-disabled:text-muted-foreground aria-disabled:shadow-none aria-disabled:hover:bg-muted data-[state=open]:bg-foreground/85",
            "h-9 [@media(pointer:coarse)]:h-11 [@media(pointer:fine)]:h-8",
            compact
              ? "w-9 [@media(pointer:coarse)]:w-11 [@media(pointer:fine)]:w-8"
              : "pl-1.5 pr-3 [@media(pointer:coarse)]:pl-2 [@media(pointer:coarse)]:pr-3.5",
          )}
        >
          <Orb size={compact ? 20 : 18} />
          {compact ? null : <span className="whitespace-nowrap">Ask agent</span>}
        </PopoverTrigger>
      </CanvasHint>
      <PopoverContent
        side="top"
        align="end"
        collisionPadding={12}
        className="w-[min(24rem,calc(100vw-1.5rem))] p-2"
        onOpenAutoFocus={(event) => {
          // The input focuses itself; with nothing to send, keep the focus put.
          if (shownReason) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const run = pending.current;
          pending.current = null;
          if (run) run();
          // Back to the text with a mouse; on touch the keyboard stays as it was.
          else if (!window.matchMedia?.("(pointer: coarse)").matches) editor.tf.focus();
        }}
      >
        {shownReason ? (
          <p role="status" className="px-1.5 py-1 text-sm text-muted-foreground">
            {shownReason}
          </p>
        ) : (
          <CanvasAskCard caption={held.caption} onSend={send} onClose={() => setOpen(false)} />
        )}
      </PopoverContent>
    </Popover>
  );
}

const NOTHING_TO_ASK = "Select some text, or put the caret in a paragraph";

/** Under this canvas width Ask agent drops its label, so the pill stays one row. */
const COMPACT_PILL_PX = 440;
/** Narrower still: checklist and quote move into ⋯ (a mouse only; touch scrolls). */
const TIGHT_PILL_PX = 330;

export function CanvasToolbar({
  ask,
  comment = null,
  suggesting = false,
}: {
  ask?: CanvasAskControl | null;
  comment?: CanvasCommentControl | null;
  /** Suggesting mode: only Comment and Ask agent (the block tools would change the text directly). */
  suggesting?: boolean;
}) {
  const editor = useEditorRef();
  const quoted = useEditorSelector((ed) => inQuote(ed), []);
  const anchorRef = useRef<HTMLDivElement>(null);
  const keyboard = useKeyboardInset(anchorRef);
  const compact = useNarrowWidth(anchorRef, COMPACT_PILL_PX);
  const narrowest = useNarrowWidth(anchorRef, TIGHT_PILL_PX);
  // Touch has no selection bar: while text is selected (or Comment's popover
  // is open on it) the marks and link take the block tools' place.
  const coarse = useCoarsePointer();
  const selection = useSelectedPassage();
  const [commentHeld, setCommentHeld] = useState(false);
  const touchMarks = coarse && (selection !== null || commentHeld);
  const tight = narrowest && !coarse;

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
        className="pointer-events-auto flex max-w-full items-center gap-0.5 rounded-2xl border border-border/70 bg-popover/95 p-1 text-popover-foreground shadow-lg shadow-foreground/5 backdrop-blur-md animate-in fade-in-0 slide-in-from-bottom-2 duration-200 motion-reduce:animate-none"
      >
        {suggesting ? null : (
          <div
            data-canvas-toolbar-tools=""
            className="flex min-w-0 items-center gap-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [@media(pointer:coarse)]:overflow-x-auto [@media(pointer:coarse)]:pr-3 [@media(pointer:coarse)]:[mask-image:linear-gradient(to_right,black_calc(100%-1rem),transparent)]"
          >
            <TextStyleMenu />
            {touchMarks ? (
              <>
                <MarkButtons />
                <LinkButton />
              </>
            ) : (
              <>
                <CanvasTablePicker triggerClassName={CANVAS_TOOL_BUTTON} />
                {tight ? null : <TodoButton />}
                {tight ? null : (
                  <ToolButton
                    label="Quote"
                    pressed={quoted}
                    onClick={() => {
                      if (!isSelectingBlocks(editor)) return toggleQuote(editor);
                      // Selected blocks: all quotes already → back to text, else one quote.
                      const allQuoted = targetBlocks(editor).every(
                        ([node]) => node.type === KEYS.blockquote,
                      );
                      turnInto(editor, allQuoted ? KEYS.p : KEYS.blockquote);
                    }}
                  >
                    <PiQuotes />
                  </ToolButton>
                )}
              </>
            )}
            <MoreMenu tight={tight} />
          </div>
        )}
        {/* The selection's own actions stay in view while the tools scroll (touch). */}
        {comment ? (
          <CanvasCommentButton comment={comment} onHold={setCommentHeld} iconOnly />
        ) : null}
        {ask ? (
          <span className="ml-0.5 flex shrink-0">
            <AskAgentButton ask={ask} compact={compact} />
          </span>
        ) : null}
      </div>
    </div>
  );
}

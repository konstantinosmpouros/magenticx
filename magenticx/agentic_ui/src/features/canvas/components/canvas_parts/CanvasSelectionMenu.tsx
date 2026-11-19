/**
 * The selection bar (plan 44 §3, Phases 4.3–4.4): select text with a mouse
 * and a small bar floats above it, like Claude Docs' —
 *
 *   Comment · (orb) Ask agent | Tt▾  B  I  S  {} | list▾  link
 *
 * **Comment** opens a small composer and starts a thread on the passage
 * (editing or reading: a comment changes nothing in the document). **Ask
 * agent** opens the Ask panel in place — the input with the presets
 * (Shorter, Longer, Formal, Simpler, Polish) as chips under it — and asks the
 * agent to change only that passage. The formatting controls are the pill's
 * own (`CanvasFormatControls`): text style, bold / italic / strikethrough /
 * code, the lists, link. No underline and no colour: markdown keeps neither.
 * While reading (or while the agent edits) the bar is Comment alone.
 *
 * Adapted from Plate's registry `floating-toolbar`: the same
 * `@platejs/floating` positioning (a virtual element on the selection's
 * rect, `offset` / `flip` / `shift`, kept in place by `autoUpdate`), with
 * its own open rule instead of `useFloatingToolbar`'s — the bar must stay
 * open while the focus is in its own input or in one of its menus, which the
 * registry's rule (tied to the editor's focus) does not allow. A touch screen
 * keeps its own selection handles and callout: there the pill holds the
 * formatting, and this bar offers Ask agent and Comment only.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MessageSquarePlus } from "lucide-react";
import { RangeApi } from "platejs";
import { useEditorReadOnly, useEditorRef, useEditorSelector } from "platejs/react";
import {
  flip,
  getRangeBoundingClientRect,
  hide,
  offset,
  shift,
  useVirtualFloating,
} from "@platejs/floating";

import type {
  CanvasAskControl,
  CanvasAskPassage,
  CanvasCommentControl,
  CanvasEditPreset,
} from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";
import { Orb } from "@/shared/ui/orb";

import { useCoarsePointer } from "../../hooks/useCoarsePointer";
import { useSelectedPassage } from "../../hooks/useSelectedPassage";
import { passageProblem } from "../../lib/askAgent";
import { showAskHighlight } from "../../lib/askHighlight";
import { captureAnchor, type CanvasAnchorCapture } from "../../lib/commentAnchors";
import { FORMAT_LAYER_ATTR } from "../../lib/toolbarControls";
import { CanvasAskCard } from "./CanvasAskPanel";
import { CanvasCommentForm } from "./CanvasCommentForm";
import { LinkButton, ListMenu, MarkButtons, TextStyleMenu } from "./CanvasFormatControls";
import { CanvasHint } from "./CanvasHint";

const holdFocus = (event: React.PointerEvent | React.MouseEvent) => event.preventDefault();

/** The input the bar holds open for a passage: Ask agent's, or a comment's. */
type Held =
  | { kind: "ask"; passage: CanvasAskPassage }
  | { kind: "comment"; passage: CanvasAskPassage; capture: CanvasAnchorCapture | null };

const textButton =
  "flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-foreground/90 transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-disabled:cursor-not-allowed aria-disabled:opacity-45";

const Divider = () => <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-border" />;

export function CanvasSelectionMenu({
  ask = null,
  comment = null,
}: {
  /** Ask agent, while the document can be edited. */
  ask?: CanvasAskControl | null;
  /** Comment, wherever the canvas can keep comments. */
  comment?: CanvasCommentControl | null;
}) {
  const editor = useEditorRef();
  const readOnly = useEditorReadOnly();
  const coarse = useCoarsePointer();
  const passage = useSelectedPassage();
  // The passage an input was opened for: the bar stays on it while the
  // focus is in the input (the editor's selection is kept, but blurred).
  const [held, setHeld] = useState<Held | null>(null);
  // A drag that is still selecting shows no bar yet (it would chase the mouse).
  const [pointerDown, setPointerDown] = useState(false);
  // Closed with Esc or a click elsewhere: hidden until the selection changes.
  const [dismissed, setDismissed] = useState<CanvasAskPassage | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // The text changes under the bar (a line turned into a heading): it follows.
  const value = useEditorSelector((ed) => ed.children, []);

  useEffect(() => {
    const down = (event: PointerEvent) => {
      const node = event.target as Node | null;
      if (menuRef.current?.contains(node)) return;
      // The bar's own menus and popovers are portalled elsewhere: still the bar.
      if (node instanceof Element && node.closest(`[${FORMAT_LAYER_ATTR}]`)) return;
      // A press anywhere else ends an open input; a new selection starts.
      setHeld(null);
      setPointerDown(true);
    };
    const up = () => setPointerDown(false);
    document.addEventListener("pointerdown", down);
    document.addEventListener("pointerup", up);
    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("pointerup", up);
    };
  }, []);

  // The focus is in the input now, so the browser no longer paints the selection.
  useEffect(
    () => (held ? showAskHighlight(editor, held.passage.range) : undefined),
    [editor, held],
  );

  // Ask agent and formatting need a writable editor; Comment works on any text.
  const askHere = ask !== null && !readOnly;
  // A mouse formats from the bar; on touch the pill does it.
  const formatHere = !readOnly && !coarse;
  const target = held?.passage ?? passage;
  const isDismissed =
    dismissed !== null && target !== null && RangeApi.equals(dismissed.range, target.range);
  const open =
    (askHere || formatHere || comment !== null) &&
    target !== null &&
    !isDismissed &&
    (held !== null || !pointerDown);

  const getRect = useCallback(
    () => getRangeBoundingClientRect(editor, target?.range ?? null),
    [editor, target],
  );
  const floating = useVirtualFloating({
    getBoundingClientRect: getRect,
    open,
    placement: "top-start",
    strategy: "fixed",
    middleware: [offset(10), flip({ padding: 12 }), shift({ padding: 8 }), hide()],
  });
  const { update } = floating;
  useEffect(() => {
    if (open) update();
  }, [open, update, value]);
  const setFloating = floating.refs.setFloating;
  const setMenu = useCallback(
    (node: HTMLDivElement | null) => {
      menuRef.current = node;
      setFloating(node);
    },
    [setFloating],
  );

  if (!open || !target) return null;

  const close = () => {
    setHeld(null);
    setDismissed(target);
    editor.tf.focus();
  };
  const send = (instruction: string, preset?: CanvasEditPreset) => {
    setHeld(null);
    setDismissed(target);
    if (ask) ask.onAsk({ passage: target, instruction, preset });
  };
  const askBlocked = askHere && ask ? (ask.disabledReason ?? passageProblem(target)) : null;

  let content: React.ReactNode;
  if (held?.kind === "comment") {
    const capture = held.capture;
    content =
      capture?.kind === "anchor" ? (
        <CanvasCommentForm
          className="w-[min(22rem,calc(100vw-2rem))] p-1"
          label="Comment on the selected text"
          placeholder="Add a comment…"
          onSubmit={(body) => {
            setHeld(null);
            setDismissed(target);
            comment?.onCreate(capture.anchor, body);
          }}
          onCancel={close}
        />
      ) : (
        <p role="status" className="px-3 py-1.5 text-[13px] text-muted-foreground">
          {capture?.kind === "problem" ? capture.message : "Select some text first"}
        </p>
      );
  } else if (held?.kind === "ask") {
    content = (
      <CanvasAskCard className="w-[min(24rem,calc(100vw-2rem))] p-1" onSend={send} onClose={close} />
    );
  } else {
    content = (
      <>
        {comment ? (
          <CanvasHint label="Comment on the selection" side="top">
            <button
              type="button"
              onPointerDown={holdFocus}
              onMouseDown={holdFocus}
              onClick={() =>
                setHeld({
                  kind: "comment",
                  passage: target,
                  capture: captureAnchor(editor, target.range),
                })
              }
              className={textButton}
            >
              <MessageSquarePlus className="size-4 text-muted-foreground" aria-hidden="true" />
              Comment
            </button>
          </CanvasHint>
        ) : null}
        {askHere && ask ? (
          <CanvasHint label={askBlocked ?? "Ask the agent to change this"} side="top">
            <button
              type="button"
              aria-disabled={askBlocked ? true : undefined}
              onPointerDown={holdFocus}
              onMouseDown={holdFocus}
              onClick={() => {
                if (!askBlocked) setHeld({ kind: "ask", passage: target });
              }}
              className={textButton}
            >
              <Orb size={18} />
              Ask agent
            </button>
          </CanvasHint>
        ) : null}
        {formatHere ? (
          <>
            {comment || askHere ? <Divider /> : null}
            <TextStyleMenu variant="glyph" />
            <MarkButtons />
            <Divider />
            <ListMenu />
            <LinkButton />
          </>
        ) : null}
      </>
    );
  }

  // Portalled to the body: `position: fixed` inside the canvas would follow
  // any transform an ancestor has (the dock's entrance animation).
  return createPortal(
    <div
      ref={setMenu}
      role="toolbar"
      aria-label="Selection actions"
      data-canvas-selection-menu=""
      style={floating.style}
      onKeyDown={(event) => {
        if (event.key === "Escape") close();
      }}
      className={cn(
        "z-50 flex max-w-[min(44rem,calc(100vw-1rem))] items-center gap-0.5 border border-border/70 bg-popover p-1 text-popover-foreground shadow-lg shadow-foreground/5 animate-in fade-in-0 zoom-in-95 duration-150 motion-reduce:animate-none",
        held ? "rounded-2xl" : "rounded-xl",
      )}
    >
      {content}
    </div>,
    document.body,
  );
}

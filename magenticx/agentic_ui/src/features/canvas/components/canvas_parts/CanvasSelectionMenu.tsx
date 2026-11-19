/**
 * The selection bar (plan 44 §3, Phases 4.3–4.4): select text with a mouse
 * and a small bar floats above it, like Claude Docs' — icon-only, compact,
 * small group gaps instead of heavy dividers, a tooltip with the name and
 * shortcut on every button:
 *
 *   comment · (orb) | Aa▾  B  I  S  {} | list▾  link
 *
 * **Comment** opens a small composer and starts a thread on the passage
 * (editing or reading: a comment changes nothing in the document). **Ask
 * agent** opens the Ask panel in place — the input with the presets
 * (Shorter, Longer, Formal, Simpler, Polish) as chips under it — and asks the
 * agent to change only that passage. The formatting controls are the pill's
 * own (`CanvasFormatControls`): text style, bold / italic / strikethrough /
 * code, the lists, link. No underline and no colour: markdown keeps neither.
 * While reading (or while the agent edits) the bar is Comment alone; while
 * suggesting (Phase 4.6) it has no formatting (block styles and links would
 * change the text directly, not as suggestions).
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
import { PiChatCircle } from "react-icons/pi";
import { RangeApi } from "platejs";
import { useEditorReadOnly, useEditorRef, useEditorSelector, usePluginOption } from "platejs/react";
import { SuggestionPlugin } from "@platejs/suggestion/react";
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
import { CANVAS_TOOL_BUTTON, FORMAT_LAYER_ATTR } from "../../lib/toolbarControls";
import { CanvasAskCard } from "./CanvasAskPanel";
import { CanvasCommentForm } from "./CanvasCommentForm";
import { LinkButton, ListMenu, MarkButtons, TextStyleMenu } from "./CanvasFormatControls";
import { CanvasHint } from "./CanvasHint";

const holdFocus = (event: React.PointerEvent | React.MouseEvent) => event.preventDefault();

/** The input the bar holds open for a passage: Ask agent's, or a comment's. */
type Held =
  | { kind: "ask"; passage: CanvasAskPassage }
  | { kind: "comment"; passage: CanvasAskPassage; capture: CanvasAnchorCapture | null };

/** A group break: a short hairline with a little air, not a heavy rule. */
const Divider = () => (
  <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 rounded-full bg-border/80" />
);

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
  const suggesting = usePluginOption(SuggestionPlugin, "isSuggesting");
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
  // A mouse formats from the bar; on touch the pill does it. Not while
  // suggesting: block styles and links would change the text directly.
  const formatHere = !readOnly && !coarse && !suggesting;
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
          placeholder={
            comment?.mentions ? "Comment, or @agent to ask the agent…" : "Add a comment…"
          }
          mentions={Boolean(comment?.mentions)}
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
      <CanvasAskCard
        className="w-[min(24rem,calc(100vw-2rem))] p-1"
        onSend={send}
        onClose={close}
      />
    );
  } else {
    content = (
      <>
        {comment ? (
          <CanvasHint label="Comment" side="top">
            <button
              type="button"
              aria-label="Comment"
              onPointerDown={holdFocus}
              onMouseDown={holdFocus}
              onClick={() =>
                setHeld({
                  kind: "comment",
                  passage: target,
                  capture: captureAnchor(editor, target.range),
                })
              }
              className={CANVAS_TOOL_BUTTON}
            >
              <PiChatCircle aria-hidden="true" />
            </button>
          </CanvasHint>
        ) : null}
        {askHere && ask ? (
          <CanvasHint label={askBlocked ?? "Ask agent"} side="top">
            <button
              type="button"
              aria-label="Ask agent"
              aria-disabled={askBlocked ? true : undefined}
              onPointerDown={holdFocus}
              onMouseDown={holdFocus}
              onClick={() => {
                if (!askBlocked) setHeld({ kind: "ask", passage: target });
              }}
              className={cn(
                CANVAS_TOOL_BUTTON,
                "aria-disabled:cursor-not-allowed aria-disabled:opacity-45",
              )}
            >
              <Orb size={18} />
            </button>
          </CanvasHint>
        ) : null}
        {formatHere ? (
          <>
            {comment || askHere ? <Divider /> : null}
            <TextStyleMenu />
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
        "z-50 flex max-w-[min(44rem,calc(100vw-1rem))] items-center gap-0.5 border border-border/70 bg-popover p-1 text-popover-foreground shadow-lg shadow-foreground/10 animate-in fade-in-0 zoom-in-95 duration-150 motion-reduce:animate-none",
        held ? "rounded-2xl" : "rounded-xl",
      )}
    >
      {content}
    </div>,
    document.body,
  );
}

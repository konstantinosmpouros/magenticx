/**
 * The selection menu (plan 44 §3, Phase 4.3): select text while editing on
 * a desktop and a small menu floats above it — **Ask agent** (opens a
 * compact input) and the presets Shorter, Longer, Formal, Simpler, Polish.
 * Whatever is picked asks the agent to change only that passage.
 *
 * Adapted from Plate's registry `floating-toolbar`: the same
 * `@platejs/floating` positioning (a virtual element on the selection's
 * rect, `offset` / `flip` / `shift`, kept in place by `autoUpdate`), with
 * its own open rule instead of `useFloatingToolbar`'s — the menu must stay
 * open while the focus is in its own input, which the registry's rule
 * (tied to the editor's focus) does not allow. A phone has no floating menu:
 * its own selection handles and callout live there, so the pill toolbar's
 * Ask agent button does the same job.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Sparkles } from "lucide-react";
import { RangeApi } from "platejs";
import { useEditorReadOnly, useEditorRef } from "platejs/react";
import {
  flip,
  getRangeBoundingClientRect,
  hide,
  offset,
  shift,
  useVirtualFloating,
} from "@platejs/floating";

import type { CanvasAskControl, CanvasAskPassage, CanvasEditPreset } from "@/shared/lib/types";

import { useSelectedPassage } from "../../hooks/useSelectedPassage";
import { passageProblem } from "../../lib/askAgent";
import { showAskHighlight } from "../../lib/askHighlight";
import { CanvasAskForm, CanvasAskPresets } from "./CanvasAskPanel";
import { CanvasHint } from "./CanvasHint";

const holdFocus = (event: React.PointerEvent | React.MouseEvent) => event.preventDefault();

export function CanvasAskMenu({ ask }: { ask: CanvasAskControl }) {
  const editor = useEditorRef();
  const readOnly = useEditorReadOnly();
  const passage = useSelectedPassage();
  // The passage the input was opened for: the menu stays on it while the
  // focus is in the input (the editor's selection is kept, but blurred).
  const [asking, setAsking] = useState<CanvasAskPassage | null>(null);
  // A drag that is still selecting shows no menu yet (it would chase the mouse).
  const [pointerDown, setPointerDown] = useState(false);
  // Closed with Esc or a click elsewhere: hidden until the selection changes.
  const [dismissed, setDismissed] = useState<CanvasAskPassage | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const down = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      // A press anywhere else ends an open input; a new selection starts.
      setAsking(null);
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
  useEffect(() => (asking ? showAskHighlight(editor, asking.range) : undefined), [editor, asking]);

  const target = asking ?? passage;
  const isDismissed =
    dismissed !== null && target !== null && RangeApi.equals(dismissed.range, target.range);
  const open = !readOnly && target !== null && !isDismissed && (asking !== null || !pointerDown);

  const getRect = useCallback(
    () => getRangeBoundingClientRect(editor, target?.range ?? null),
    [editor, target],
  );
  const floating = useVirtualFloating({
    getBoundingClientRect: getRect,
    open,
    placement: "top",
    strategy: "fixed",
    middleware: [offset(10), flip({ padding: 12 }), shift({ padding: 8 }), hide()],
  });
  const setFloating = floating.refs.setFloating;
  const setMenu = useCallback(
    (node: HTMLDivElement | null) => {
      menuRef.current = node;
      setFloating(node);
    },
    [setFloating],
  );

  if (!open || !target) return null;

  const problem = passageProblem(target);
  const close = () => {
    setAsking(null);
    setDismissed(target);
    editor.tf.focus();
  };
  const send = (instruction: string, preset?: CanvasEditPreset) => {
    setAsking(null);
    setDismissed(target);
    ask.onAsk({ passage: target, instruction, preset });
  };

  // Portalled to the body: `position: fixed` inside the canvas would follow
  // any transform an ancestor has (the dock's entrance animation).
  return createPortal(
    <div
      ref={setMenu}
      role="toolbar"
      aria-label="Ask the agent about the selection"
      data-canvas-ask-menu=""
      style={floating.style}
      onKeyDown={(event) => {
        if (event.key === "Escape") close();
      }}
      className="z-50 flex max-w-[min(34rem,calc(100vw-1rem))] items-center gap-0.5 rounded-full border border-border/70 bg-popover p-1 text-popover-foreground shadow-lg shadow-foreground/5 animate-in fade-in-0 zoom-in-95 duration-150 motion-reduce:animate-none"
    >
      {problem ? (
        <p role="status" className="px-3 py-1.5 text-[13px] text-muted-foreground">
          {problem}
        </p>
      ) : asking ? (
        <CanvasAskForm
          className="w-[min(26rem,calc(100vw-2rem))]"
          onSubmit={(instruction) => send(instruction)}
          onClose={close}
        />
      ) : (
        <>
          <CanvasHint label={ask.disabledReason ?? "Ask the agent to change this"} side="top">
            <button
              type="button"
              aria-disabled={ask.disabledReason ? true : undefined}
              onPointerDown={holdFocus}
              onMouseDown={holdFocus}
              onClick={() => {
                if (!ask.disabledReason) setAsking(target);
              }}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold text-primary transition-colors duration-150 hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-disabled:cursor-not-allowed aria-disabled:opacity-45"
            >
              <Sparkles className="size-4" aria-hidden="true" />
              Ask agent
            </button>
          </CanvasHint>
          <span aria-hidden="true" className="mx-0.5 h-5 w-px shrink-0 bg-border" />
          <CanvasAskPresets
            disabledReason={ask.disabledReason}
            onPick={(preset, instruction) => send(instruction, preset)}
          />
        </>
      )}
    </div>,
    document.body,
  );
}

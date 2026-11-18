/**
 * The two halves of Ask agent (plan 44 §3, Phase 4.3), shared by the
 * desktop's floating selection menu and the pill toolbar's Ask agent
 * popover: the one-tap presets (Shorter, Longer, Formal, Simpler, Polish)
 * and the compact input ("Ask the agent to change this…", Enter sends, Esc
 * closes).
 *
 * Built on the app's own Button and Input (shadcn) rather than a new
 * prompt-input component: one line and a send button is all the canvas
 * needs, and AI Elements' PromptInput brings attachments and a model picker
 * that have no place here.
 */
import { useState } from "react";
import { ArrowUp } from "lucide-react";

import type { CanvasEditPreset } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";

import { CANVAS_ASK_PRESETS } from "../../lib/askAgent";
import { CanvasHint } from "./CanvasHint";

/** Keeps the editor's focus and selection when a menu button is pressed. */
const holdFocus = (event: React.PointerEvent | React.MouseEvent) => event.preventDefault();

export function CanvasAskPresets({
  onPick,
  disabledReason = null,
  className,
  buttonClassName,
}: {
  onPick: (preset: CanvasEditPreset, instruction: string) => void;
  /** Why the presets can't be used now (a reply is streaming); shown as their tooltip. */
  disabledReason?: string | null;
  className?: string;
  buttonClassName?: string;
}) {
  return (
    <div role="group" aria-label="Quick changes" className={cn("flex items-center", className)}>
      {CANVAS_ASK_PRESETS.map((item) => (
        <CanvasHint key={item.preset} label={disabledReason ?? item.instruction} side="top">
          <button
            type="button"
            aria-disabled={disabledReason ? true : undefined}
            onPointerDown={holdFocus}
            onMouseDown={holdFocus}
            onClick={() => {
              if (!disabledReason) onPick(item.preset, item.instruction);
            }}
            className={cn(
              "flex h-8 aria-disabled:cursor-not-allowed aria-disabled:opacity-45 shrink-0 items-center rounded-full px-2.5 text-[13px] font-medium text-foreground/85 transition-colors duration-150 [touch-action:manipulation] hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:px-3.5",
              buttonClassName,
            )}
          >
            {item.label}
          </button>
        </CanvasHint>
      ))}
    </div>
  );
}

export function CanvasAskForm({
  onSubmit,
  onClose,
  className,
}: {
  onSubmit: (instruction: string) => void;
  /** Esc: back to the document, nothing sent. */
  onClose: () => void;
  className?: string;
}) {
  const [draft, setDraft] = useState("");
  const ready = draft.trim().length > 0;

  return (
    <form
      className={cn("flex items-center gap-1.5", className)}
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) onSubmit(draft.trim());
      }}
    >
      <label htmlFor="canvas-ask-input" className="sr-only">
        Ask the agent to change the selected text
      </label>
      <input
        id="canvas-ask-input"
        autoFocus
        autoComplete="off"
        maxLength={2000}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }}
        placeholder="Ask the agent to change this…"
        className="h-9 min-w-0 flex-1 rounded-full border border-input bg-background px-3.5 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm [@media(pointer:coarse)]:h-11"
      />
      <CanvasHint label="Send to the agent" keys="Enter" side="top">
        <button
          type="submit"
          aria-label="Send to the agent"
          aria-disabled={!ready}
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity duration-150 hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background aria-disabled:opacity-40 [@media(pointer:coarse)]:size-11"
        >
          <ArrowUp className="size-4" aria-hidden="true" />
        </button>
      </CanvasHint>
    </form>
  );
}

/**
 * Suggesting mode's controls (plan 44, Phase 4.6): the bar at the top of the
 * document — "N suggestions from the agent", that the document is read-only
 * until they are reviewed, **Reject all** / **Accept all** — and the small
 * ✓ / ✕ pill on each suggestion, at the bottom right of its last block (below
 * the text it is about — usually over the short end of its last line — and
 * clear of a heading's fold chevron at the top right).
 *
 * A pill shows while its suggestion is hovered or tapped (`activeId`), or
 * while one of its buttons has the keyboard focus; hidden, it is still in
 * the tab order (and shows on focus), so every suggestion is reachable by
 * keyboard, in document order, after the bar. Touch gets 44px buttons.
 *
 * Built from the app's `Button` and the canvas's `CanvasHint` tooltips;
 * Plate's registry has no suggestion bar to start from (its accept / reject
 * lives in the discussion popover, see `lib/suggestions.ts`).
 */
import { PiCheck, PiNotePencil, PiX } from "react-icons/pi";

import type { CanvasSuggestion } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";
import { Button } from "@/shared/ui/button";

import { CanvasHint } from "./CanvasHint";

export function CanvasSuggestionBar({
  count,
  onAcceptAll,
  onRejectAll,
}: {
  count: number;
  onAcceptAll: () => void;
  onRejectAll: () => void;
}) {
  return (
    <div className="sticky top-12 z-20 bg-background px-3 pb-2 sm:px-4">
      <section
        aria-label="Suggestions from the agent"
        className="mx-auto flex max-w-[760px] flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border/80 bg-muted/40 px-3 py-2 animate-in fade-in-0 duration-200 motion-reduce:animate-none"
      >
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
        >
          <PiNotePencil className="size-[18px]" />
        </span>
        <div className="min-w-[11rem] flex-1">
          <p role="status" className="text-[13px] font-medium leading-5 text-foreground">
            {count} {count === 1 ? "suggestion" : "suggestions"} from the agent
          </p>
          <p className="text-xs leading-4 text-muted-foreground">
            Read-only until you accept or reject them
          </p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={onRejectAll}
            className="h-8 gap-1.5 px-3 [@media(pointer:coarse)]:h-11"
          >
            <PiX className="size-4" aria-hidden="true" />
            Reject all
          </Button>
          <Button
            size="sm"
            onClick={onAcceptAll}
            className="h-8 gap-1.5 px-3 [@media(pointer:coarse)]:h-11"
          >
            <PiCheck className="size-4" aria-hidden="true" />
            Accept all
          </Button>
        </div>
      </section>
    </div>
  );
}

/** Where a suggestion's pill sits: the bottom of its last block, in the column (px). */
export interface CanvasSuggestionSpot {
  suggestion: CanvasSuggestion;
  top: number;
}

const KIND_NAME: Record<CanvasSuggestion["kind"], string> = {
  insert: "addition",
  remove: "deletion",
  replace: "edit",
};

const pillButton =
  "flex size-8 items-center justify-center rounded-full transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:size-11";

export function CanvasSuggestionControls({
  spots,
  activeId,
  onAccept,
  onReject,
}: {
  spots: CanvasSuggestionSpot[];
  /** The suggestion under the pointer (or last tapped); its pill shows. */
  activeId: string | null;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
}) {
  return (
    <>
      {spots.map(({ suggestion, top }) => {
        const name = `${KIND_NAME[suggestion.kind]}${suggestion.summary ? ` “${suggestion.summary}”` : ""}`;
        return (
          <div
            key={suggestion.id}
            role="group"
            aria-label={`Suggested ${name}`}
            data-canvas-suggestion-id={suggestion.id}
            data-canvas-suggestion-pill=""
            style={{ top }}
            className={cn(
              "absolute right-0 z-10 flex -translate-y-1/2 items-center gap-0.5 rounded-full border border-border/80 bg-background p-0.5 shadow-md shadow-foreground/10 transition-opacity duration-150 motion-reduce:transition-none",
              activeId === suggestion.id
                ? "opacity-100"
                : "pointer-events-none opacity-0 focus-within:pointer-events-auto focus-within:opacity-100",
            )}
          >
            <CanvasHint label="Accept" side="top">
              <button
                type="button"
                aria-label={`Accept the ${name}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onAccept(suggestion.id)}
                className={cn(pillButton, "text-success hover:bg-success/15")}
              >
                <PiCheck className="size-4" />
              </button>
            </CanvasHint>
            <CanvasHint label="Reject" side="top">
              <button
                type="button"
                aria-label={`Reject the ${name}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onReject(suggestion.id)}
                className={cn(pillButton, "text-destructive hover:bg-destructive/10")}
              >
                <PiX className="size-4" />
              </button>
            </CanvasHint>
          </div>
        );
      })}
    </>
  );
}

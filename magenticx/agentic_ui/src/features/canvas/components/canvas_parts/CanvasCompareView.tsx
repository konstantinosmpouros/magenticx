/**
 * Two versions of a document side by side in one column (plan 44, Phase
 * 4.2): the markdown, line by line, with inserted words marked in the
 * success tone and underlined, deleted words in the destructive tone and
 * struck through — each also named for screen readers, so colour is never
 * the only sign. Long unchanged stretches fold into a row that expands.
 *
 * Used from History (any two versions) and from the conflict dialog (the
 * version that won against the user's unsaved text, with Keep theirs / Keep
 * mine above the diff).
 *
 * Both texts go through the editor's markdown round trip first: an agent's
 * version and a saved one spell the same table or escape differently
 * (`| - |`, `\_`), and that is not a change the reader made.
 */
import { useMemo, useState, type ReactNode } from "react";
import { ChevronsUpDown, GitCompareArrows, Minus, Plus, X } from "lucide-react";

import type { CanvasDiffRow as DiffRow } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";
import { Skeleton } from "@/shared/ui/skeleton";

import { diffDocuments } from "../../lib/documentDiff";
import { normalizeMarkdown } from "../../lib/markdown";

function Row({ row }: { row: DiffRow }) {
  const only =
    row.pieces.length > 0 && row.pieces.every((piece) => piece.kind === row.pieces[0].kind)
      ? row.pieces[0].kind
      : null;
  return (
    <div
      className={cn(
        "relative min-h-[1.75em] whitespace-pre-wrap break-words py-px pl-6 pr-2",
        only === "added" && "bg-success/10",
        only === "removed" && "bg-destructive/10",
      )}
    >
      {row.kind === "changed" ? (
        <span aria-hidden="true" className="absolute left-1.5 top-[0.35em] text-muted-foreground">
          {only === "added" ? (
            <Plus className="size-3.5" />
          ) : only === "removed" ? (
            <Minus className="size-3.5" />
          ) : (
            <span className="block size-3.5 text-center text-[11px] leading-[0.875rem]">~</span>
          )}
        </span>
      ) : null}
      {row.pieces.length === 0 ? " " : null}
      {row.pieces.map((piece, index) =>
        piece.kind === "same" ? (
          <span key={index}>{piece.text}</span>
        ) : piece.kind === "added" ? (
          <ins
            key={index}
            className="rounded-[3px] bg-success/20 text-foreground underline decoration-success/70 decoration-2 underline-offset-[3px] [text-decoration-skip-ink:none]"
          >
            <span className="sr-only">[added: </span>
            {piece.text}
            <span className="sr-only">]</span>
          </ins>
        ) : (
          <del
            key={index}
            className="rounded-[3px] bg-destructive/15 text-foreground/70 line-through decoration-destructive/70"
          >
            <span className="sr-only">[removed: </span>
            {piece.text}
            <span className="sr-only">]</span>
          </del>
        ),
      )}
    </div>
  );
}

function Fold({ rows }: { rows: DiffRow[] }) {
  const [open, setOpen] = useState(false);
  if (open)
    return (
      <>
        {rows.map((row, index) => (
          <Row key={index} row={row} />
        ))}
      </>
    );
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="my-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-11"
    >
      <ChevronsUpDown className="size-3.5" aria-hidden="true" />
      {rows.length} unchanged lines
    </button>
  );
}

export function CanvasCompareView({
  fromLabel,
  toLabel,
  before,
  after,
  actions,
  onClose,
}: {
  fromLabel: string;
  toLabel: string;
  /** The older text, or null while it loads. */
  before: string | null;
  after: string | null;
  /** Buttons above the diff (the conflict's Keep theirs / Keep mine). */
  actions?: ReactNode;
  onClose: () => void;
}) {
  const diff = useMemo(
    () =>
      before !== null && after !== null
        ? diffDocuments(normalizeMarkdown(before), normalizeMarkdown(after))
        : null,
    [before, after],
  );

  return (
    <section
      aria-label={`Compare ${fromLabel} with ${toLabel}`}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/70 bg-muted/40 px-4 py-2.5">
        <GitCompareArrows className="size-4 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
          {fromLabel} <span className="text-muted-foreground">→</span> {toLabel}
        </span>
        {diff ? (
          <span className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Plus className="size-3 text-success" aria-hidden="true" />
              {diff.added} added
            </span>
            <span className="flex items-center gap-1">
              <Minus className="size-3 text-destructive" aria-hidden="true" />
              {diff.removed} removed
            </span>
          </span>
        ) : null}
        <button
          type="button"
          aria-label="Close compare"
          onClick={onClose}
          className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:size-11"
        >
          <X className="size-4" />
        </button>
        {actions ? <div className="flex w-full flex-wrap gap-2">{actions}</div> : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto w-full max-w-[720px] px-3 py-6 font-mono text-[13px] leading-relaxed text-foreground/90 sm:px-6">
          {diff === null ? (
            <div className="space-y-2" aria-busy="true" aria-label="Loading the versions">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
            </div>
          ) : diff.added === 0 && diff.removed === 0 ? (
            <p className="py-8 text-center font-sans text-sm text-muted-foreground">
              The two versions have the same text.
            </p>
          ) : (
            diff.items.map((item, index) =>
              item.type === "row" ? (
                <Row key={index} row={item.row} />
              ) : (
                <Fold key={index} rows={item.rows} />
              ),
            )
          )}
        </div>
      </div>
    </section>
  );
}

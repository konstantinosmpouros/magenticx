/**
 * The toolbar's table button: a size grid to pick the table from (plan 44,
 * Phase 4.2). Pointing at a cell previews rows × columns, pressing it
 * inserts that table with the caret in its first cell — so a press always
 * says what it inserts, and never stacks empty 3 × 3 tables silently.
 *
 * Plate's registry `table-toolbar-button` `TablePicker`, adapted: every cell
 * is a real button (keyboard and screen reader reach it, the label says the
 * size), the grid is 6 × 6 with cells a finger can hit on a phone, and the
 * cells use the app's tokens.
 */
import { useState } from "react";
import { Table } from "lucide-react";
import { useEditorRef } from "platejs/react";

import { cn } from "@/shared/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";

import { insertCanvasTable } from "../../lib/blockCommands";
import { rememberSelection, restoreSelection } from "../../lib/selectionMemory";

const SIZE = 6;

export function CanvasTablePicker({ triggerClassName }: { triggerClassName: string }) {
  const editor = useEditorRef();
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState({ rows: 3, cols: 3 });

  const insert = (rows: number, cols: number) => {
    setOpen(false);
    restoreSelection(editor);
    insertCanvasTable(editor, rows, cols);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setHover({ rows: 3, cols: 3 });
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger
            aria-label="Table"
            aria-haspopup="dialog"
            onPointerDown={() => rememberSelection(editor)}
            onMouseDown={(event) => event.preventDefault()}
            className={triggerClassName}
          >
            <Table />
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          Table
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        side="top"
        align="center"
        className="w-auto p-3"
        aria-label="Table size"
        onOpenAutoFocus={(event) => {
          // Start on the 3 × 3 the preview shows, not on 1 × 1. On a touch
          // screen focus stays in the text, so the keyboard does not close.
          event.preventDefault();
          if (window.matchMedia?.("(pointer: coarse)").matches) return;
          (event.currentTarget as HTMLElement | null)
            ?.querySelector<HTMLButtonElement>('[data-cell="3x3"]')
            ?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          editor.tf.focus();
        }}
      >
        <div
          role="group"
          aria-label="Pick a table size"
          className="grid grid-cols-6 gap-1"
          onMouseLeave={() => setHover({ rows: 3, cols: 3 })}
        >
          {Array.from({ length: SIZE * SIZE }, (_, cell) => {
            const row = Math.floor(cell / SIZE) + 1;
            const col = (cell % SIZE) + 1;
            const lit = row <= hover.rows && col <= hover.cols;
            return (
              <button
                key={cell}
                type="button"
                data-cell={`${row}x${col}`}
                aria-label={`Insert a table, ${row} by ${col}`}
                onPointerEnter={(event) => {
                  if (event.pointerType === "mouse") setHover({ rows: row, cols: col });
                }}
                onFocus={() => setHover({ rows: row, cols: col })}
                // A press keeps the focus (and a phone's keyboard) where it is.
                onPointerDown={(event) => event.preventDefault()}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insert(row, col)}
                className={cn(
                  "size-6 rounded-[5px] border transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none [@media(pointer:coarse)]:size-11",
                  lit ? "border-primary/60 bg-primary/15" : "border-border bg-muted/50",
                )}
              />
            );
          })}
        </div>
        <p className="mt-2 text-center text-xs tabular-nums text-muted-foreground" aria-live="polite">
          {hover.rows} × {hover.cols}
        </p>
      </PopoverContent>
    </Popover>
  );
}

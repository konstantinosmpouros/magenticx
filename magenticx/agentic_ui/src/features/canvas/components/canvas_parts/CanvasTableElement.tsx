/**
 * A table in the canvas editor: the document's table (`shared/ui/plate/
 * table-node`) with a floating toolbar while the caret is in it (plan 44,
 * Phase 4.2): insert a row above / below, a column left / right, delete the
 * row, the column, or the whole table.
 *
 * The toolbar is Plate's registry `table-node` floating toolbar (a popover
 * anchored on the table, open while the table holds the selection, the same
 * table transforms), adapted: no cell colours, borders, merge or split — a
 * markdown table cannot store them — and buttons a finger can hit on a
 * phone. It lives in the canvas feature, not in `shared/ui`, because its
 * commands (`lib/blockCommands.ts`) are the canvas's.
 */
import type { ReactNode } from "react";
import type { TTableElement } from "platejs";
import {
  BetweenHorizontalEnd,
  BetweenHorizontalStart,
  BetweenVerticalEnd,
  BetweenVerticalStart,
  ListX,
  Trash2,
} from "lucide-react";
import {
  useEditorRef,
  useEditorSelector,
  useReadOnly,
  useSelected,
  type PlateElementProps,
} from "platejs/react";

import { Popover, PopoverAnchor, PopoverContent } from "@/shared/ui/popover";
import { TableElement } from "@/shared/ui/plate/table-node";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";

import { isSelectingBlocks, tableAction, type CanvasTableAction } from "../../lib/blockCommands";
import { rememberSelection, restoreSelection } from "../../lib/selectionMemory";

const button =
  "flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:size-11 [&_svg]:size-4";

function TableButton({
  action,
  label,
  destructive,
  children,
}: {
  action: CanvasTableAction;
  label: string;
  destructive?: boolean;
  children: ReactNode;
}) {
  const editor = useEditorRef();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          // Keep the caret in its cell (see lib/selectionMemory.ts).
          onPointerDown={(event) => {
            rememberSelection(editor);
            event.preventDefault();
          }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            restoreSelection(editor);
            tableAction(editor, action);
          }}
          className={
            destructive
              ? `${button} hover:bg-destructive/10 hover:text-destructive`
              : button
          }
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

const Group = ({ label, children }: { label: string; children: ReactNode }) => (
  <div role="group" aria-label={label} className="flex items-center gap-0.5">
    <span className="px-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80 max-sm:sr-only">
      {label}
    </span>
    {children}
  </div>
);

const Divider = () => <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-border" />;

export function CanvasTableToolbar() {
  return (
    <div
      role="toolbar"
      aria-label="Table"
      className="flex max-w-[calc(100vw-1.5rem)] items-center overflow-x-auto p-1 [scrollbar-width:none] [touch-action:manipulation] [&::-webkit-scrollbar]:hidden"
    >
      <Group label="Row">
        <TableButton action="rowAbove" label="Insert row above">
          <BetweenHorizontalStart />
        </TableButton>
        <TableButton action="rowBelow" label="Insert row below">
          <BetweenHorizontalEnd />
        </TableButton>
        <TableButton action="deleteRow" label="Delete row" destructive>
          <ListX />
        </TableButton>
      </Group>
      <Divider />
      <Group label="Column">
        <TableButton action="colLeft" label="Insert column left">
          <BetweenVerticalStart />
        </TableButton>
        <TableButton action="colRight" label="Insert column right">
          <BetweenVerticalEnd />
        </TableButton>
        <TableButton action="deleteCol" label="Delete column" destructive>
          {/* The row icon turned on its side: a column with a cross. */}
          <ListX className="-rotate-90" />
        </TableButton>
      </Group>
      <Divider />
      <TableButton action="deleteTable" label="Delete table" destructive>
        <Trash2 />
      </TableButton>
    </div>
  );
}

export function CanvasTableElement(props: PlateElementProps<TTableElement>) {
  const readOnly = useReadOnly();
  const selected = useSelected();
  const selectingBlocks = useEditorSelector((ed) => isSelectingBlocks(ed), []);
  const open = !readOnly && selected && !selectingBlocks;

  return (
    <Popover open={open} modal={false}>
      <PopoverAnchor asChild>
        <div>
          <TableElement {...props} />
        </div>
      </PopoverAnchor>
      {open ? (
        <PopoverContent
          side="top"
          align="start"
          sideOffset={4}
          contentEditable={false}
          // The caret stays in the cell: the toolbar never takes focus.
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          className="w-auto rounded-full border-border/70 bg-background/95 shadow-lg shadow-foreground/5 backdrop-blur-md print:hidden"
        >
          <CanvasTableToolbar />
        </PopoverContent>
      ) : null}
    </Popover>
  );
}

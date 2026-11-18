/**
 * Tables, from Plate's shadcn registry (`platejs.org/r/table-node`, its static
 * variant), adapted for a document rather than a spreadsheet: a rounded,
 * bordered box that scrolls sideways on a phone, a tinted header row and
 * compact cell paragraphs. The registry's interactive table (column resize,
 * cell selection, border and colour menus, drag handles) is left out — a
 * markdown table cannot store any of it.
 */
import type { TTableCellElement, TTableElement } from "platejs";
import { TablePlugin } from "@platejs/table/react";
import { PlateElement, type PlateElementProps } from "platejs/react";

import { cn } from "@/shared/lib/utils";

export function TableElement(props: PlateElementProps<TTableElement>) {
  return (
    <PlateElement {...props} className="my-5">
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[420px] border-collapse text-[14px] leading-snug">
          <tbody>{props.children}</tbody>
        </table>
      </div>
    </PlateElement>
  );
}

export function TableRowElement(props: PlateElementProps) {
  return (
    <PlateElement {...props} as="tr" className="border-b border-border last:border-b-0">
      {props.children}
    </PlateElement>
  );
}

function TableCell({
  isHeader,
  ...props
}: PlateElementProps<TTableCellElement> & { isHeader?: boolean }) {
  const { api } = props.editor.getPlugin(TablePlugin);

  return (
    <PlateElement
      {...props}
      as={isHeader ? "th" : "td"}
      className={cn(
        "border-r border-border px-3 py-2 align-top last:border-r-0 [&_p]:m-0 [&_p]:py-0",
        isHeader ? "bg-muted/70 text-left font-semibold text-foreground" : "text-foreground/90",
      )}
      attributes={{
        ...props.attributes,
        colSpan: api.table.getColSpan(props.element),
        rowSpan: api.table.getRowSpan(props.element),
      }}
    >
      {props.children}
    </PlateElement>
  );
}

export const TableCellElement = (props: PlateElementProps<TTableCellElement>) => (
  <TableCell {...props} />
);
export const TableCellHeaderElement = (props: PlateElementProps<TTableCellElement>) => (
  <TableCell {...props} isHeader />
);

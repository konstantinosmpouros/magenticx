/**
 * Lists, from Plate's shadcn registry (`platejs.org/r/block-list`), adapted:
 * Plate's lists are indented paragraphs, so ordered and to-do items get their
 * `<ol>/<li>` wrapper here (bullets are a `display: list-item` on the block,
 * set by the list plugin's `inject`), muted markers, and a native checkbox in
 * the app's accent instead of the registry's shadcn Checkbox.
 */
import type * as React from "react";
import type { TListElement } from "platejs";
import { isOrderedList } from "@platejs/list";
import { useTodoListElement, useTodoListElementState } from "@platejs/list/react";
import { useReadOnly, type PlateElementProps, type RenderNodeWrapper } from "platejs/react";

import { cn } from "@/shared/lib/utils";

type ListItemProps = PlateElementProps & { lineBreakBadge?: React.ReactNode };

export const BlockList: RenderNodeWrapper = (props) => {
  if (!props.element.listStyleType) return;
  // Bullets render through `display: list-item`; only numbered and to-do
  // items need a real list element around them.
  if (!isOrderedList(props.element)) return;

  return (listProps) => <List {...listProps} />;
};

function List(props: ListItemProps) {
  const { listStart, listStyleType } = props.element as TListElement;
  const isTodo = listStyleType === "todo";
  const ListTag = isTodo ? "ul" : "ol";

  return (
    <ListTag
      className="relative m-0 p-0 marker:text-muted-foreground"
      style={{ listStyleType: isTodo ? "none" : listStyleType }}
      start={listStart}
    >
      {isTodo ? <TodoMarker {...props} /> : null}
      <li
        className={cn(
          "pl-1",
          isTodo && "list-none",
          isTodo && Boolean(props.element.checked) && "text-muted-foreground line-through",
        )}
      >
        {props.children}
        {props.lineBreakBadge}
      </li>
    </ListTag>
  );
}

function TodoMarker(props: PlateElementProps) {
  const state = useTodoListElementState({ element: props.element });
  const { checkboxProps } = useTodoListElement(state);
  const readOnly = useReadOnly();

  return (
    // On a touch screen the box keeps its place but its hit area grows to
    // 44px (a label around it), so a tap toggles it instead of moving the caret.
    <label
      contentEditable={false}
      className="absolute -left-6 top-[0.55rem] flex [@media(pointer:coarse)]:-left-[2.375rem] [@media(pointer:coarse)]:top-[-0.325rem] [@media(pointer:coarse)]:size-11 [@media(pointer:coarse)]:items-center [@media(pointer:coarse)]:justify-center"
    >
      <input
        type="checkbox"
        aria-label="Done"
        checked={Boolean(checkboxProps.checked)}
        onChange={(event) => checkboxProps.onCheckedChange(event.target.checked)}
        onMouseDown={checkboxProps.onMouseDown}
        disabled={readOnly}
        className="size-4 cursor-pointer rounded border-border accent-primary disabled:cursor-default"
      />
    </label>
  );
}

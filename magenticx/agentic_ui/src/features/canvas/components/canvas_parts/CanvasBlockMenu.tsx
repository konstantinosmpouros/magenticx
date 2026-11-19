/**
 * The block menu (plan 44, Phase 4.2): Delete, Duplicate, Move up / down and
 * Turn into, for the target blocks (the selected blocks, or the blocks the
 * text selection touches — see `lib/blockCommands.ts`).
 *
 * Adapted from Plate's registry `block-context-menu` (same actions, same
 * BlockSelection transforms), but opened from a ⋮⋮ handle beside the block
 * on a desktop (`CanvasBlockHandle`) and from the pill's ⋯ More menu
 * everywhere, instead of a right-click menu: a phone has no right click, and
 * the registry turns its menu off on touch. The registry's context menu
 * needs `@radix-ui/react-context-menu`; this is the app's dropdown, so no
 * second Radix layer stack comes in.
 */
import { useState, type ReactNode } from "react";
import {
  PiArrowDown,
  PiArrowUp,
  PiArrowsClockwise,
  PiCaretLeft,
  PiCaretRight,
  PiCheck,
  PiCopy,
  PiDotsSixVertical,
  PiTrash,
} from "react-icons/pi";
import { BlockMenuPlugin, BlockSelectionPlugin } from "@platejs/selection/react";
import { useEditorRef } from "platejs/react";
import type { SlateEditor } from "platejs";

import { cn } from "@/shared/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";

import {
  blockKind,
  blocksById,
  CANVAS_BLOCK_KINDS,
  canMoveBlocks,
  deleteBlocks,
  duplicateBlocks,
  idsOf,
  isSelectingBlocks,
  moveBlocks,
  targetBlocks,
  turnInto,
} from "../../lib/blockCommands";
import { restoreSelection } from "../../lib/selectionMemory";
import { CanvasHint } from "./CanvasHint";

/** Menu rows tall enough for a finger on a phone. */
const row = "[@media(pointer:coarse)]:min-h-11";

/** After an action: back to the blocks (still selected) or to the text. */
function refocus(editor: SlateEditor) {
  if (isSelectingBlocks(editor)) editor.getApi(BlockSelectionPlugin).blockSelection.focus();
  else editor.tf.focus();
}

/**
 * The menu's rows; rendered inside a `DropdownMenuContent`, so they mount
 * when the menu opens. The target blocks are taken then, by id: once the
 * focus is in the menu the editor may drop its block selection (a selection
 * change outside the editor clears it), and the menu must still act on the
 * blocks it was opened for. Selected blocks are selected again after the
 * action. `leading` rows (the pill's ⋯ menu: lists, code block) come first,
 * above a separator, in the main view only.
 */
export function CanvasBlockMenuItems({ leading }: { leading?: ReactNode }) {
  const editor = useEditorRef();
  const [{ ids, asBlocks }] = useState(() => {
    // A tap may have collapsed the text selection: put it back first.
    restoreSelection(editor);
    return { ids: idsOf(targetBlocks(editor)), asBlocks: isSelectingBlocks(editor) };
  });
  const entries = () => blocksById(editor, ids);
  const current = entries();
  const count = current.length;
  const kind = blockKind(current[0]?.[0]);
  const canUp = canMoveBlocks(editor, "up", current);
  const canDown = canMoveBlocks(editor, "down", current);
  const plural = count > 1 ? `${count} blocks` : "block";

  const run = (action: (targets: ReturnType<typeof entries>) => void) => () => action(entries());
  // A phone has no room for a submenu beside the menu: "Turn into" opens its
  // list in place of the menu, with a way back.
  const [touch] = useState(() => window.matchMedia?.("(pointer: coarse)").matches ?? false);
  const [view, setView] = useState<"main" | "turnInto">("main");

  const kinds = CANVAS_BLOCK_KINDS.map((item) => (
    <DropdownMenuItem
      key={item.kind}
      className={row}
      onSelect={run((targets) => turnInto(editor, item.kind, targets, asBlocks))}
    >
      <span className="flex-1">{item.label}</span>
      {count === 1 && item.kind === kind ? (
        <PiCheck className="text-primary" aria-label="Current" />
      ) : null}
    </DropdownMenuItem>
  ));

  if (view === "turnInto") {
    return (
      <>
        <DropdownMenuItem
          className={cn(row, "text-muted-foreground")}
          onSelect={(event) => {
            event.preventDefault();
            setView("main");
          }}
        >
          <PiCaretLeft aria-hidden="true" />
          Turn into
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {kinds}
      </>
    );
  }

  return (
    <>
      {leading ? (
        <>
          {leading}
          <DropdownMenuSeparator />
        </>
      ) : null}
      <DropdownMenuItem
        className={row}
        onSelect={run((targets) => duplicateBlocks(editor, targets, asBlocks))}
      >
        <PiCopy aria-hidden="true" />
        Duplicate
      </DropdownMenuItem>
      <DropdownMenuItem
        className={row}
        disabled={!canUp}
        onSelect={run((targets) => moveBlocks(editor, "up", targets, asBlocks))}
      >
        <PiArrowUp aria-hidden="true" />
        Move up
      </DropdownMenuItem>
      <DropdownMenuItem
        className={row}
        disabled={!canDown}
        onSelect={run((targets) => moveBlocks(editor, "down", targets, asBlocks))}
      >
        <PiArrowDown aria-hidden="true" />
        Move down
      </DropdownMenuItem>
      {touch ? (
        <DropdownMenuItem
          className={row}
          onSelect={(event) => {
            event.preventDefault();
            setView("turnInto");
          }}
        >
          <PiArrowsClockwise aria-hidden="true" />
          <span className="flex-1">Turn into</span>
          <PiCaretRight className="text-muted-foreground" aria-hidden="true" />
        </DropdownMenuItem>
      ) : (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className={row}>
            <PiArrowsClockwise className="size-4" aria-hidden="true" />
            Turn into
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-48">{kinds}</DropdownMenuSubContent>
        </DropdownMenuSub>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem
        className={row}
        variant="destructive"
        disabled={count === 0}
        onSelect={run((targets) => deleteBlocks(editor, targets))}
      >
        <PiTrash aria-hidden="true" />
        Delete {plural}
      </DropdownMenuItem>
    </>
  );
}

/** The menu's content, shared by the handle and the pill's ⋯ menu. */
export function CanvasBlockMenuContent({
  side,
  align,
  leading,
  label,
}: {
  side: "top" | "bottom" | "left" | "right";
  align: "start" | "center" | "end";
  /** Rows above the block actions (see `CanvasBlockMenuItems`). */
  leading?: ReactNode;
  label?: string;
}) {
  const editor = useEditorRef();
  return (
    <DropdownMenuContent
      side={side}
      align={align}
      className="w-52"
      aria-label={label}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        refocus(editor);
      }}
    >
      <CanvasBlockMenuItems leading={leading} />
    </DropdownMenuContent>
  );
}

/**
 * The ⋮⋮ handle at the left of a top-level block (desktop, while editing).
 * Pressing it selects the block (Shift adds it to the selection instead, and
 * opens nothing) and opens the block menu.
 */
export function CanvasBlockHandle({ id }: { id: string }) {
  const editor = useEditorRef();
  const blockSelection = editor.getApi(BlockSelectionPlugin).blockSelection;
  const blockMenu = editor.getApi(BlockMenuPlugin).blockMenu;

  return (
    <DropdownMenu
      modal={false}
      onOpenChange={(open) => {
        // While the menu is open, block selection must survive the focus move.
        if (open) blockMenu.show(id);
        else blockMenu.hide();
      }}
    >
      <CanvasHint label="Click to open the menu · Shift+click to select more" side="left">
        <DropdownMenuTrigger
          aria-label="Block actions"
          // The editor's own mousedown would drop the block selection.
          data-plate-prevent-deselect="true"
          onPointerDown={(event) => {
            if (event.shiftKey) {
              // Shift+click: add (or drop) this block, no menu.
              event.preventDefault();
              if (blockSelection.has(id)) blockSelection.delete(id);
              else {
                editor.tf.deselect();
                blockSelection.add(id);
              }
              blockSelection.focus();
              return;
            }
            if (!blockSelection.has(id)) {
              editor.tf.deselect();
              blockSelection.set(id);
            }
          }}
          className={cn(
            "flex h-7 w-6 items-center justify-center rounded-md text-muted-foreground/70 opacity-0 transition-opacity duration-150",
            "hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "group-hover/block:opacity-100 data-[state=open]:bg-muted data-[state=open]:opacity-100 motion-reduce:transition-none",
          )}
        >
          <PiDotsSixVertical className="pointer-events-none size-4" aria-hidden="true" />
        </DropdownMenuTrigger>
      </CanvasHint>
      <CanvasBlockMenuContent side="bottom" align="start" />
    </DropdownMenu>
  );
}

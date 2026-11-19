/**
 * The row at the top of the document: the outline toggle (≡), Find and,
 * while editing, undo / redo on the left (the user asked for them here, not
 * in the floating pill); on the right the mode menu — Editing, Suggesting
 * (Phase 4.6: the agent's changes arrive as suggestions to accept or reject)
 * or Viewing (plan 44 §3). Comments on a line have
 * their marks in the text's margin, as in Claude Docs; the ones with no line
 * (resolved, or their text changed) have a button just left of the mode
 * menu (`CanvasOtherCommentsButton`, plan 44 v2). Find moved here
 * from the header, which keeps only the title, the save status, Export,
 * full screen and close. An earlier version is always read-only, so there the
 * menu is a plain "Viewing" label. The row stays at the top as the document
 * scrolls (sticky), on the panel's own background so the text slides under
 * it cleanly.
 */
import type { IconType } from "react-icons";
import {
  PiArrowClockwise,
  PiArrowCounterClockwise,
  PiCaretDown,
  PiCheck,
  PiEye,
  PiListDashes,
  PiMagnifyingGlass,
  PiNotePencil,
  PiPencilSimpleLine,
} from "react-icons/pi";
import { useEditorRef, useEditorSelector } from "platejs/react";

import type { CanvasMode, CanvasOtherCommentsMark } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";

import { isApplePlatform, modKeyLabel } from "../../lib/shortcuts";
import { CanvasOtherCommentsButton } from "./CanvasCommentMarkers";
import { CanvasHint } from "./CanvasHint";

const pill =
  "flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-muted-foreground [@media(pointer:coarse)]:h-10";

const MODES: { mode: CanvasMode; label: string; hint: string; Icon: IconType }[] = [
  {
    mode: "editing",
    label: "Editing",
    hint: "Edit the document directly",
    Icon: PiPencilSimpleLine,
  },
  {
    mode: "suggesting",
    label: "Suggesting",
    hint: "Review the agent's changes before they stay",
    Icon: PiNotePencil,
  },
  { mode: "viewing", label: "Viewing", hint: "Read without changing it", Icon: PiEye },
];

export function CanvasDocBar({
  showOutlineButton,
  outlineOpen,
  onToggleOutline,
  findOpen,
  onToggleFind,
  mode,
  canEdit,
  onModeChange,
  showUndoRedo,
  others = null,
}: {
  showOutlineButton: boolean;
  outlineOpen: boolean;
  onToggleOutline: () => void;
  findOpen: boolean;
  onToggleFind: () => void;
  mode: CanvasMode;
  /** False on an earlier version: those are read-only. */
  canEdit: boolean;
  onModeChange: (mode: CanvasMode) => void;
  /** While editing: undo / redo beside the outline button. */
  showUndoRedo: boolean;
  /** The comments with no line (resolved, detached); null or none: no button. */
  others?: CanvasOtherCommentsMark | null;
}) {
  const current = MODES.find((item) => item.mode === mode) ?? MODES[2];

  return (
    <div className="sticky top-0 z-20 flex h-12 items-center gap-1 bg-background px-3 sm:px-4">
      {showOutlineButton ? (
        <CanvasHint label={outlineOpen ? "Hide outline" : "Outline"}>
          <button
            type="button"
            aria-label="Outline"
            aria-pressed={outlineOpen}
            onClick={onToggleOutline}
            className={cn(
              pill,
              "w-8 justify-center px-0 transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:w-10",
              outlineOpen && "bg-muted text-foreground",
            )}
          >
            <PiListDashes className="size-[18px] shrink-0" />
          </button>
        </CanvasHint>
      ) : null}
      <CanvasHint label={findOpen ? "Close find" : "Find in document"} keys={`${modKeyLabel()}F`}>
        <button
          type="button"
          aria-label="Find in document"
          aria-pressed={findOpen}
          onClick={onToggleFind}
          className={cn(
            pill,
            "w-8 justify-center px-0 transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:w-10",
            findOpen && "bg-muted text-foreground",
          )}
        >
          <PiMagnifyingGlass className="size-[18px] shrink-0" />
        </button>
      </CanvasHint>
      {showUndoRedo ? <UndoRedo /> : null}

      <span className="ml-auto" />
      <CanvasOtherCommentsButton others={others} />

      {canEdit ? (
        <DropdownMenu>
          <CanvasHint label="Change mode">
            <DropdownMenuTrigger
              aria-label={`Mode: ${current.label}. Change mode`}
              className={cn(
                pill,
                "transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted data-[state=open]:text-foreground",
                mode !== "viewing" && "text-foreground",
              )}
            >
              <current.Icon className="size-4" aria-hidden="true" />
              {current.label}
              <PiCaretDown className="size-3" aria-hidden="true" />
            </DropdownMenuTrigger>
          </CanvasHint>
          <DropdownMenuContent align="end" className="w-60">
            {MODES.map(({ mode: value, label, hint, Icon }) => (
              <DropdownMenuItem
                key={value}
                onSelect={() => onModeChange(value)}
                className="items-start gap-2.5 py-2"
              >
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium text-foreground">{label}</span>
                  <span className="text-xs text-muted-foreground">{hint}</span>
                </span>
                {value === mode ? (
                  <PiCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-label="Current" />
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <span className={pill} title="Earlier versions are read-only">
          <PiEye className="size-4" aria-hidden="true" />
          Viewing
        </span>
      )}
    </div>
  );
}

const historyButton = cn(
  pill,
  "w-8 justify-center px-0 transition-colors duration-150 [touch-action:manipulation] hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-35 [@media(pointer:coarse)]:w-10",
);

/** Undo / redo of the editor's history (Ctrl/Cmd+Z and redo also work from the keyboard). */
function UndoRedo() {
  const editor = useEditorRef();
  const canUndo = useEditorSelector((ed) => ed.history.undos.length > 0, []);
  const canRedo = useEditorSelector((ed) => ed.history.redos.length > 0, []);
  const mod = modKeyLabel();
  const items = [
    {
      label: "Undo",
      keys: `${mod}Z`,
      Icon: PiArrowCounterClockwise,
      enabled: canUndo,
      run: () => editor.undo(),
    },
    {
      label: "Redo",
      keys: isApplePlatform() ? "⇧⌘Z" : "Ctrl+Y",
      Icon: PiArrowClockwise,
      enabled: canRedo,
      run: () => editor.redo(),
    },
  ];
  return (
    <>
      {items.map(({ label, keys, Icon, enabled, run }) => (
        <CanvasHint key={label} label={label} keys={keys}>
          <button
            type="button"
            aria-label={label}
            disabled={!enabled}
            // Keep the editor's focus and caret.
            onMouseDown={(event) => event.preventDefault()}
            onClick={run}
            className={historyButton}
          >
            <Icon className="size-[18px] shrink-0" />
          </button>
        </CanvasHint>
      ))}
    </>
  );
}

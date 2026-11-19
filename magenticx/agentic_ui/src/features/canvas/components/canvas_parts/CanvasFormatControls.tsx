/**
 * The formatting controls of the canvas (plan 44 §3), shared by the pill at
 * the bottom of the document (`CanvasToolbar`) and the floating bar over a
 * selection (`CanvasSelectionMenu`): text style, bold / italic /
 * strikethrough / code, lists, link.
 *
 * Adapted from Plate's shadcn registry (`mark-toolbar-button`,
 * `list-toolbar-button`, `turn-into-toolbar-button`, `link-toolbar-button`)
 * and driven by the same Plate hooks, on the app's own menu, popover and
 * tooltip. No underline and no text colour: documents are stored as
 * markdown, which has neither, so they would be lost on save and export.
 *
 * Every control keeps the editor's selection (`lib/toolbarControls.ts`,
 * `lib/selectionMemory.ts`); with blocks selected, marks and styles apply to
 * all of them. Icon-only, like Claude Docs' bars: Phosphor regular icons
 * (`react-icons/pi`, imported one by one so the lazy canvas chunk keeps only
 * these), each with a tooltip naming it and its shortcut.
 */
import { useRef, useState, type ReactNode } from "react";
import type { IconType } from "react-icons";
import {
  PiCaretDown,
  PiCheck,
  PiCode,
  PiLinkBreak,
  PiLinkSimple,
  PiListBullets,
  PiListChecks,
  PiListNumbers,
  PiTextAa,
  PiTextB,
  PiTextItalic,
  PiTextStrikethrough,
} from "react-icons/pi";
import { KEYS } from "platejs";
import {
  useEditorRef,
  useEditorSelector,
  useMarkToolbarButton,
  useMarkToolbarButtonState,
} from "platejs/react";
import {
  useIndentTodoToolBarButton,
  useIndentTodoToolBarButtonState,
  useListToolbarButton,
  useListToolbarButtonState,
} from "@platejs/list/react";

import { cn } from "@/shared/lib/utils";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { Input } from "@/shared/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";

import {
  blocksById,
  CANVAS_BLOCK_KINDS,
  currentBlockKind,
  idsOf,
  isSelectingBlocks,
  targetBlocks,
  turnInto,
  type CanvasBlockKind,
} from "../../lib/blockCommands";
import { applyLink, normalizeLinkUrl, removeLink, selectedLinkUrl } from "../../lib/editorCommands";
import { rememberSelection, restoreSelection } from "../../lib/selectionMemory";
import { modKeyLabel } from "../../lib/shortcuts";
import {
  CANVAS_TOOL_BUTTON,
  CANVAS_TOOL_MENU_BUTTON,
  FORMAT_LAYER_ATTR,
  holdSelection,
  keepSelection,
  refocus,
} from "../../lib/toolbarControls";
import { CanvasHint } from "./CanvasHint";

type Side = "top" | "bottom";

const layer = { [FORMAT_LAYER_ATTR]: "" };

export function ToolButton({
  label,
  keys,
  pressed,
  disabled,
  onClick,
  children,
}: {
  label: string;
  keys?: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const editor = useEditorRef();
  return (
    <CanvasHint label={label} keys={keys} side="top">
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onPointerDown={holdSelection(editor)}
        onMouseDown={keepSelection}
        onClick={() => {
          restoreSelection(editor);
          onClick();
        }}
        className={CANVAS_TOOL_BUTTON}
      >
        {children}
      </button>
    </CanvasHint>
  );
}

/** Bold, italic, …: Plate's mark toggle (block selection applies it to every selected block). */
function MarkButton({
  nodeType,
  label,
  keys,
  children,
}: {
  nodeType: string;
  label: string;
  keys?: string;
  children: ReactNode;
}) {
  const state = useMarkToolbarButtonState({ nodeType });
  const { props } = useMarkToolbarButton(state);
  return (
    <ToolButton label={label} keys={keys} pressed={props.pressed} onClick={props.onClick}>
      {children}
    </ToolButton>
  );
}

/** The four marks markdown keeps: bold, italic, strikethrough, inline code. */
export function MarkButtons() {
  const mod = modKeyLabel();
  return (
    <>
      <MarkButton nodeType={KEYS.bold} label="Bold" keys={`${mod}B`}>
        <PiTextB />
      </MarkButton>
      <MarkButton nodeType={KEYS.italic} label="Italic" keys={`${mod}I`}>
        <PiTextItalic />
      </MarkButton>
      <MarkButton nodeType={KEYS.strikethrough} label="Strikethrough" keys={`${mod}Shift+X`}>
        <PiTextStrikethrough />
      </MarkButton>
      <MarkButton nodeType={KEYS.code} label="Code" keys={`${mod}E`}>
        <PiCode />
      </MarkButton>
    </>
  );
}

/** Checklist: Plate's to-do toggle (the pill has it as its own button). */
export function TodoButton() {
  const editor = useEditorRef();
  const state = useIndentTodoToolBarButtonState({ nodeType: KEYS.listTodo });
  const { props } = useIndentTodoToolBarButton(state);
  return (
    <ToolButton
      label="Checklist"
      pressed={props.pressed}
      onClick={() =>
        isSelectingBlocks(editor) ? turnInto(editor, KEYS.listTodo) : props.onClick()
      }
    >
      <PiListChecks />
    </ToolButton>
  );
}

type ListKind = typeof KEYS.ul | typeof KEYS.ol | typeof KEYS.listTodo;
type ListToggle = { pressed: boolean; toggle: () => void };

const LIST_KINDS: { kind: ListKind; label: string; icon: IconType }[] = [
  { kind: KEYS.ul, label: "Bulleted list", icon: PiListBullets },
  { kind: KEYS.ol, label: "Numbered list", icon: PiListNumbers },
  { kind: KEYS.listTodo, label: "Checklist", icon: PiListChecks },
];

/** Which list the selection is in, and each kind's toggle (Plate's list hooks). */
function useListToggles(): Record<ListKind, ListToggle> {
  const ul = useListToolbarButton(useListToolbarButtonState({ nodeType: KEYS.ul })).props;
  const ol = useListToolbarButton(useListToolbarButtonState({ nodeType: KEYS.ol })).props;
  const todo = useIndentTodoToolBarButton(
    useIndentTodoToolBarButtonState({ nodeType: KEYS.listTodo }),
  ).props;
  return {
    [KEYS.ul]: { pressed: Boolean(ul.pressed), toggle: ul.onClick },
    [KEYS.ol]: { pressed: Boolean(ol.pressed), toggle: ol.onClick },
    [KEYS.listTodo]: { pressed: Boolean(todo.pressed), toggle: todo.onClick },
  } as Record<ListKind, ListToggle>;
}

/**
 * The list kinds as menu items, a check on the current one; picking the
 * current one turns the list back into text. Rendered inside a menu's
 * content, so it mounts as the menu opens and takes its targets then (the
 * menu takes the focus, the blocks stay put), as `CanvasBlockMenuItems`
 * does. Shared by the selection bar's list menu and the pill's ⋯ menu.
 */
export function ListMenuItems({ kinds }: { kinds?: ListKind[] }) {
  const editor = useEditorRef();
  const toggles = useListToggles();
  const [targets] = useState(() => {
    restoreSelection(editor);
    const taken = { ids: idsOf(targetBlocks(editor)), asBlocks: isSelectingBlocks(editor) };
    // Kept for the pick: a menu item's select may come after the blur.
    rememberSelection(editor);
    return taken;
  });

  const pick = (kind: ListKind) => {
    const { pressed, toggle } = toggles[kind];
    if (targets.asBlocks) {
      turnInto(editor, pressed ? KEYS.p : kind, blocksById(editor, targets.ids), true);
      return;
    }
    restoreSelection(editor);
    toggle();
  };

  return (
    <>
      {LIST_KINDS.filter((item) => !kinds || kinds.includes(item.kind)).map((item) => (
        <DropdownMenuItem
          key={item.kind}
          onSelect={() => pick(item.kind)}
          className="gap-2 [@media(pointer:coarse)]:min-h-11"
        >
          <item.icon className="size-4 text-muted-foreground" aria-hidden="true" />
          <span className="flex-1">{item.label}</span>
          {toggles[item.kind].pressed ? (
            <PiCheck className="size-4 text-primary" aria-label="Current" />
          ) : null}
        </DropdownMenuItem>
      ))}
    </>
  );
}

/**
 * The selection bar's list menu (one ▾ button for the three lists): the
 * current kind's icon on the trigger, tinted while the selection is in a
 * list; the kinds as menu items (`ListMenuItems`).
 */
export function ListMenu({ side = "top" }: { side?: Side }) {
  const editor = useEditorRef();
  const toggles = useListToggles();
  const current = LIST_KINDS.find((item) => toggles[item.kind].pressed) ?? null;
  const Icon = current?.icon ?? PiListBullets;

  return (
    <DropdownMenu modal={false}>
      <CanvasHint label={current ? current.label : "List"} side="top">
        <DropdownMenuTrigger
          // No preventDefault on pointerdown: Radix opens the menu on it.
          onPointerDown={() => rememberSelection(editor)}
          onMouseDown={keepSelection}
          aria-label={current ? `List: ${current.label}` : "List"}
          data-active={current ? "" : undefined}
          className={CANVAS_TOOL_MENU_BUTTON}
        >
          <Icon aria-hidden="true" />
          <PiCaretDown aria-hidden="true" />
        </DropdownMenuTrigger>
      </CanvasHint>
      <DropdownMenuContent
        {...layer}
        side={side}
        align="start"
        className="w-48"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          refocus(editor);
        }}
      >
        <ListMenuItems />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The text-style menu's four styles (the block menu offers every kind). */
const TEXT_STYLES = CANVAS_BLOCK_KINDS.slice(0, 4);

/**
 * Text / Title / Heading / Subheading: an Aa icon and a small ▾ (both bars),
 * tinted while the block is a title or a heading; the current style is in
 * its name and tooltip, and checked in the menu.
 */
export function TextStyleMenu({ side = "top" }: { side?: Side }) {
  const editor = useEditorRef();
  const style = useEditorSelector((ed) => currentBlockKind(ed), []);
  const label = CANVAS_BLOCK_KINDS.find((item) => item.kind === style)?.label ?? "Text";
  const heading = style === KEYS.h1 || style === KEYS.h2 || style === KEYS.h3;
  // The targets are taken as the menu opens (see CanvasBlockMenuItems).
  const targets = useRef<{ ids: string[]; asBlocks: boolean } | null>(null);
  const pick = (kind: CanvasBlockKind) => {
    const taken = targets.current;
    if (!taken) return;
    turnInto(editor, kind, blocksById(editor, taken.ids), taken.asBlocks);
  };
  return (
    <DropdownMenu
      modal={false}
      onOpenChange={(open) => {
        if (!open) return;
        restoreSelection(editor);
        targets.current = { ids: idsOf(targetBlocks(editor)), asBlocks: isSelectingBlocks(editor) };
      }}
    >
      <CanvasHint label={`Text style: ${label}`} side="top">
        <DropdownMenuTrigger
          // No preventDefault here: Radix opens the menu on this pointerdown.
          onPointerDown={() => rememberSelection(editor)}
          onMouseDown={keepSelection}
          aria-label={`Text style: ${label}`}
          data-active={heading ? "" : undefined}
          className={CANVAS_TOOL_MENU_BUTTON}
        >
          <PiTextAa aria-hidden="true" />
          <PiCaretDown aria-hidden="true" />
        </DropdownMenuTrigger>
      </CanvasHint>
      <DropdownMenuContent
        {...layer}
        side={side}
        align="start"
        className="w-48"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          refocus(editor);
        }}
      >
        {TEXT_STYLES.map((item) => (
          <DropdownMenuItem
            key={item.kind}
            onSelect={() => pick(item.kind)}
            className="gap-2 [@media(pointer:coarse)]:min-h-11"
          >
            <span
              className={cn(
                "flex-1",
                item.kind === KEYS.h1 && "font-serif text-lg font-semibold",
                item.kind === KEYS.h2 && "font-serif text-base font-semibold",
                item.kind === KEYS.h3 && "font-semibold",
              )}
            >
              {item.label}
            </span>
            {item.kind === style ? (
              <PiCheck className="size-4 text-primary" aria-label="Current" />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Add, edit or remove the link on the selection: web and mail addresses only. */
export function LinkButton({ side = "top" }: { side?: Side }) {
  const editor = useEditorRef();
  const current = useEditorSelector((ed) => selectedLinkUrl(ed), []);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [invalid, setInvalid] = useState(false);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const url = normalizeLinkUrl(draft);
    if (!url) {
      setInvalid(true);
      return;
    }
    setOpen(false);
    restoreSelection(editor);
    applyLink(editor, url);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setDraft(current ?? "");
          setInvalid(false);
        }
      }}
    >
      <CanvasHint label={current ? "Edit link" : "Link"} side="top">
        <PopoverTrigger
          aria-label={current ? "Edit link" : "Link"}
          aria-pressed={Boolean(current)}
          onPointerDown={() => rememberSelection(editor)}
          onMouseDown={keepSelection}
          className={CANVAS_TOOL_BUTTON}
        >
          <PiLinkSimple />
        </PopoverTrigger>
      </CanvasHint>
      <PopoverContent
        {...layer}
        side={side}
        align="center"
        className="w-[min(22rem,calc(100vw-2rem))] p-3"
        onCloseAutoFocus={(event) => event.preventDefault()}
        // The link's own Esc: the selection bar under it stays.
        onKeyDown={(event) => {
          if (event.key === "Escape") event.stopPropagation();
        }}
      >
        <form onSubmit={submit} className="space-y-2">
          <label htmlFor="canvas-link-url" className="text-xs font-medium text-muted-foreground">
            Link address
          </label>
          <Input
            id="canvas-link-url"
            autoFocus
            inputMode="url"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setInvalid(false);
            }}
            placeholder="https://"
            aria-invalid={invalid}
            aria-describedby={invalid ? "canvas-link-error" : undefined}
            className="h-9"
          />
          {invalid ? (
            <p id="canvas-link-error" className="text-xs text-destructive">
              Enter a web address (https://…) or an email link (mailto:…).
            </p>
          ) : null}
          <div className="flex justify-end gap-2 pt-1">
            {current ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mr-auto gap-1.5"
                onClick={() => {
                  setOpen(false);
                  restoreSelection(editor);
                  removeLink(editor);
                }}
              >
                <PiLinkBreak className="size-4" aria-hidden="true" />
                Remove
              </Button>
            ) : null}
            <Button type="submit" size="sm">
              {current ? "Update" : "Add link"}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

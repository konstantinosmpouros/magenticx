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
 * all of them.
 */
import { useRef, useState, type ReactNode } from "react";
import {
  Bold,
  Check,
  ChevronDown,
  Code,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Strikethrough,
  Type,
  Unlink,
  type LucideIcon,
} from "lucide-react";
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
import {
  applyLink,
  normalizeLinkUrl,
  removeLink,
  selectedLinkUrl,
} from "../../lib/editorCommands";
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
        <Bold />
      </MarkButton>
      <MarkButton nodeType={KEYS.italic} label="Italic" keys={`${mod}I`}>
        <Italic />
      </MarkButton>
      <MarkButton nodeType={KEYS.strikethrough} label="Strikethrough" keys={`${mod}Shift+X`}>
        <Strikethrough />
      </MarkButton>
      <MarkButton nodeType={KEYS.code} label="Code" keys={`${mod}E`}>
        <Code />
      </MarkButton>
    </>
  );
}

/**
 * Lists: Plate's list toggle on the text selection; with blocks selected,
 * every selected block becomes an item (turn-into), since the toggle reads
 * only the text selection.
 */
function ListButton({
  nodeType,
  label,
  children,
}: {
  nodeType: typeof KEYS.ul | typeof KEYS.ol;
  label: string;
  children: ReactNode;
}) {
  const editor = useEditorRef();
  const state = useListToolbarButtonState({ nodeType });
  const { props } = useListToolbarButton(state);
  return (
    <ToolButton
      label={label}
      pressed={props.pressed}
      onClick={() => (isSelectingBlocks(editor) ? turnInto(editor, nodeType) : props.onClick())}
    >
      {children}
    </ToolButton>
  );
}

function TodoButton() {
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
      <ListChecks />
    </ToolButton>
  );
}

/** The pill's three list buttons side by side. */
export function ListButtons() {
  return (
    <>
      <ListButton nodeType={KEYS.ul} label="Bulleted list">
        <List />
      </ListButton>
      <ListButton nodeType={KEYS.ol} label="Numbered list">
        <ListOrdered />
      </ListButton>
      <TodoButton />
    </>
  );
}

/**
 * The selection bar's list menu (one ▾ button for the three lists): the
 * current kind's icon on the trigger, each kind a menu item with a check on
 * the current one; picking the current one turns the list back into text.
 */
export function ListMenu({ side = "top" }: { side?: Side }) {
  const editor = useEditorRef();
  const ul = useListToolbarButton(useListToolbarButtonState({ nodeType: KEYS.ul })).props;
  const ol = useListToolbarButton(useListToolbarButtonState({ nodeType: KEYS.ol })).props;
  const todo = useIndentTodoToolBarButton(
    useIndentTodoToolBarButtonState({ nodeType: KEYS.listTodo }),
  ).props;
  // Taken as the menu opens: the menu takes the focus, the blocks stay put.
  const targets = useRef<{ ids: string[]; asBlocks: boolean } | null>(null);

  const kinds: {
    kind: CanvasBlockKind;
    label: string;
    icon: LucideIcon;
    pressed: boolean;
    toggle: () => void;
  }[] = [
    { kind: KEYS.ul, label: "Bulleted list", icon: List, pressed: ul.pressed, toggle: ul.onClick },
    {
      kind: KEYS.ol,
      label: "Numbered list",
      icon: ListOrdered,
      pressed: ol.pressed,
      toggle: ol.onClick,
    },
    {
      kind: KEYS.listTodo,
      label: "Checklist",
      icon: ListChecks,
      pressed: Boolean(todo.pressed),
      toggle: todo.onClick,
    },
  ];
  const current = kinds.find((item) => item.pressed) ?? null;
  const Icon = current?.icon ?? List;

  const pick = (item: (typeof kinds)[number]) => {
    const taken = targets.current;
    if (taken?.asBlocks) {
      turnInto(editor, item.pressed ? KEYS.p : item.kind, blocksById(editor, taken.ids), true);
      return;
    }
    restoreSelection(editor);
    item.toggle();
  };

  return (
    <DropdownMenu
      modal={false}
      onOpenChange={(open) => {
        if (!open) return;
        restoreSelection(editor);
        targets.current = { ids: idsOf(targetBlocks(editor)), asBlocks: isSelectingBlocks(editor) };
        // Kept for the pick: a menu item's select may come after the blur.
        rememberSelection(editor);
      }}
    >
      <CanvasHint label={current ? current.label : "List"} side="top">
        <DropdownMenuTrigger
          // No preventDefault on pointerdown: Radix opens the menu on it.
          onPointerDown={() => rememberSelection(editor)}
          onMouseDown={keepSelection}
          aria-label={current ? `List: ${current.label}` : "List"}
          aria-pressed={current ? true : undefined}
          className={CANVAS_TOOL_MENU_BUTTON}
        >
          <Icon aria-hidden="true" />
          <ChevronDown className="!size-3 opacity-70" aria-hidden="true" />
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
        {kinds.map((item) => (
          <DropdownMenuItem
            key={item.kind}
            onSelect={() => pick(item)}
            className="gap-2 [@media(pointer:coarse)]:min-h-11"
          >
            <item.icon className="size-4 text-muted-foreground" aria-hidden="true" />
            <span className="flex-1">{item.label}</span>
            {item.pressed ? <Check className="size-4 text-primary" aria-label="Current" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The text-style menu's four styles (the block menu offers every kind). */
const TEXT_STYLES = CANVAS_BLOCK_KINDS.slice(0, 4);

/**
 * Text / Title / Heading / Subheading. The trigger shows the current style's
 * name (`label`), a T icon (`icon`, a narrow pill) or the Tт glyph (`glyph`,
 * the selection bar).
 */
export function TextStyleMenu({
  variant = "label",
  side = "top",
}: {
  variant?: "label" | "icon" | "glyph";
  side?: Side;
}) {
  const editor = useEditorRef();
  const style = useEditorSelector((ed) => currentBlockKind(ed), []);
  const label = CANVAS_BLOCK_KINDS.find((item) => item.kind === style)?.label ?? "Text";
  // The targets are taken as the menu opens (see CanvasBlockMenuItems).
  const targets = useRef<{ ids: string[]; asBlocks: boolean } | null>(null);
  const pick = (kind: CanvasBlockKind) => {
    const taken = targets.current;
    if (!taken) return;
    turnInto(editor, kind, blocksById(editor, taken.ids), taken.asBlocks);
  };
  const trigger = (
    <DropdownMenuTrigger
      // No preventDefault here: Radix opens the menu on this pointerdown.
      onPointerDown={() => rememberSelection(editor)}
      onMouseDown={keepSelection}
      aria-label={`Text style: ${label}`}
      className={cn(
        "flex h-9 shrink-0 items-center gap-1 rounded-full text-[13px] font-medium text-foreground transition-colors duration-150 [touch-action:manipulation] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted [@media(pointer:coarse)]:h-11 [@media(pointer:fine)]:h-8",
        variant === "glyph" ? "px-2" : "pl-3 pr-2 [@media(pointer:fine)]:pl-2.5",
      )}
    >
      {variant === "icon" ? (
        <Type className="size-4 text-muted-foreground" aria-hidden="true" />
      ) : variant === "glyph" ? (
        <span aria-hidden="true" className="font-serif text-[15px] font-semibold leading-none">
          T<span className="text-[11px]">t</span>
        </span>
      ) : (
        <span className="w-[5.5rem] truncate text-left [@media(pointer:fine)]:w-[4.75rem]">
          {label}
        </span>
      )}
      <ChevronDown className="size-3 text-muted-foreground" aria-hidden="true" />
    </DropdownMenuTrigger>
  );
  return (
    <DropdownMenu
      modal={false}
      onOpenChange={(open) => {
        if (!open) return;
        restoreSelection(editor);
        targets.current = { ids: idsOf(targetBlocks(editor)), asBlocks: isSelectingBlocks(editor) };
      }}
    >
      {variant === "label" ? (
        trigger
      ) : (
        <CanvasHint label={`Text style: ${label}`} side="top">
          {trigger}
        </CanvasHint>
      )}
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
              <Check className="size-4 text-primary" aria-label="Current" />
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
          <Link2 />
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
                <Unlink className="size-4" aria-hidden="true" />
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

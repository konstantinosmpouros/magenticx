/**
 * The floating pill toolbar at the bottom of the document while editing
 * (plan 44 §3, the Claude Docs bar): text style, bold / italic /
 * strikethrough / code, bulleted / numbered / checklist, link, table, quote,
 * block actions. Undo / redo sit at the top, beside the outline button
 * (`CanvasDocBar`). No fixed toolbar in the header: the document owns the
 * panel.
 *
 * Adapted from Plate's shadcn registry (`toolbar`, `mark-toolbar-button`,
 * `list-toolbar-button`, `turn-into-toolbar-button`, `link-toolbar-button`,
 * `table-toolbar-button`) and driven by the same Plate hooks they use. The
 * registry's toolbar is built on `@radix-ui/react-toolbar`; this one is a
 * plain `role="toolbar"` row with the app's own button, menu, popover and
 * tooltip, so no new Radix package (and no second dismissable-layer copy)
 * comes in for one bar.
 *
 * Every control keeps the editor's selection on a desktop *and* a phone:
 * `pointerdown` remembers the selection and (for plain buttons) prevents the
 * focus move, so the editor — and a phone's keyboard — stay put; the command
 * puts the remembered selection back first, in case a tap collapsed it
 * (`lib/selectionMemory.ts`). With blocks selected (block selection), marks
 * and styles apply to all of them. With a mouse every control is shown,
 * compact, wrapping to a second row in a narrow canvas (never a scrollbar);
 * on touch the pill scrolls sideways, and rises above the on-screen keyboard.
 */
import { useRef, useState, type ReactNode } from "react";
import {
  Bold,
  Check,
  ChevronDown,
  Code,
  GripVertical,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Strikethrough,
  TextQuote,
  Unlink,
} from "lucide-react";
import { KEYS, type SlateEditor } from "platejs";
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
import { BlockSelectionPlugin } from "@platejs/selection/react";

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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";

import { useKeyboardInset } from "../../hooks/useKeyboardInset";
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
  inQuote,
  normalizeLinkUrl,
  removeLink,
  selectedLinkUrl,
  toggleQuote,
} from "../../lib/editorCommands";
import { rememberSelection, restoreSelection } from "../../lib/selectionMemory";
import { modKeyLabel } from "../../lib/shortcuts";
import { CanvasBlockMenuContent } from "./CanvasBlockMenu";
import { CanvasTablePicker } from "./CanvasTablePicker";

const toolButton =
  "flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 [touch-action:manipulation] hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-35 aria-pressed:bg-primary/12 aria-pressed:text-primary data-[state=open]:bg-muted [@media(pointer:coarse)]:size-11 [@media(pointer:fine)]:size-8 [&_svg]:size-[18px] [@media(pointer:fine)]:[&_svg]:size-4";

/** Keep the editor's focus when a toolbar control is pressed with a mouse. */
const keepSelection = (event: React.MouseEvent) => event.preventDefault();

/**
 * A plain button's pointerdown: remember the selection and keep the focus
 * where it is (on touch too: a prevented pointerdown sends no compat
 * mousedown, so no blur and the keyboard stays open). The click still fires.
 */
const holdSelection = (editor: SlateEditor) => (event: React.PointerEvent) => {
  rememberSelection(editor);
  event.preventDefault();
};

/** The text-style menu's four styles (the block menu offers every kind). */
const TEXT_STYLES = CANVAS_BLOCK_KINDS.slice(0, 4);

/** Back to the text, or to the selected blocks, after a menu closes. */
function refocus(editor: SlateEditor) {
  if (isSelectingBlocks(editor)) editor.getApi(BlockSelectionPlugin).blockSelection.focus();
  else editor.tf.focus();
}

function Hint({ label, keys, children }: { label: string; keys?: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top" className="flex items-center gap-2 text-xs">
        {label}
        {keys ? <kbd className="font-sans text-muted-foreground">{keys}</kbd> : null}
      </TooltipContent>
    </Tooltip>
  );
}

function ToolButton({
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
    <Hint label={label} keys={keys}>
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
        className={toolButton}
      >
        {children}
      </button>
    </Hint>
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

function TextStyleMenu() {
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
  return (
    <DropdownMenu
      modal={false}
      onOpenChange={(open) => {
        if (!open) return;
        restoreSelection(editor);
        targets.current = { ids: idsOf(targetBlocks(editor)), asBlocks: isSelectingBlocks(editor) };
      }}
    >
      <DropdownMenuTrigger
        // No preventDefault here: Radix opens the menu on this pointerdown.
        onPointerDown={() => rememberSelection(editor)}
        onMouseDown={keepSelection}
        aria-label={`Text style: ${label}`}
        className="flex h-9 shrink-0 items-center gap-1 rounded-full pl-3 pr-2 text-[13px] [@media(pointer:fine)]:h-8 [@media(pointer:fine)]:pl-2.5 font-medium text-foreground transition-colors duration-150 [touch-action:manipulation] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted [@media(pointer:coarse)]:h-11"
      >
        <span className="w-[5.5rem] truncate text-left [@media(pointer:fine)]:w-[4.75rem]">
          {label}
        </span>
        <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
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

function LinkButton() {
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
      <Hint label={current ? "Edit link" : "Link"}>
        <PopoverTrigger
          aria-label={current ? "Edit link" : "Link"}
          aria-pressed={Boolean(current)}
          onPointerDown={() => rememberSelection(editor)}
          onMouseDown={keepSelection}
          className={toolButton}
        >
          <Link2 />
        </PopoverTrigger>
      </Hint>
      <PopoverContent
        side="top"
        align="center"
        className="w-[min(22rem,calc(100vw-2rem))] p-3"
        onCloseAutoFocus={(event) => event.preventDefault()}
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

/**
 * The block menu from the toolbar: the way to Delete / Duplicate / Move /
 * Turn into on a phone, where there is no hover handle — it acts on the
 * blocks the caret or the selection is in (or the selected blocks).
 */
function BlockMenuButton() {
  const editor = useEditorRef();
  return (
    <DropdownMenu modal={false}>
      <Hint label="Block actions">
        <DropdownMenuTrigger
          aria-label="Block actions"
          onPointerDown={() => rememberSelection(editor)}
          onMouseDown={keepSelection}
          className={toolButton}
        >
          <GripVertical />
        </DropdownMenuTrigger>
      </Hint>
      <CanvasBlockMenuContent side="top" align="center" />
    </DropdownMenu>
  );
}

const Divider = () => (
  <span
    aria-hidden="true"
    className="mx-1 h-5 w-px shrink-0 bg-border [@media(pointer:fine)]:mx-0.5"
  />
);

export function CanvasToolbar() {
  const editor = useEditorRef();
  const quoted = useEditorSelector((ed) => inQuote(ed), []);
  const mod = modKeyLabel();
  const anchorRef = useRef<HTMLDivElement>(null);
  const keyboard = useKeyboardInset(anchorRef);

  return (
    <div
      ref={anchorRef}
      data-canvas-toolbar=""
      className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-3 sm:bottom-6"
      // Above a phone's on-screen keyboard, which covers the canvas bottom.
      style={keyboard > 0 ? { transform: `translateY(-${keyboard}px)` } : undefined}
    >
      <div
        role="toolbar"
        aria-label="Formatting"
        aria-orientation="horizontal"
        className="pointer-events-auto flex max-w-full items-center gap-0.5 rounded-[22px] border [@media(pointer:coarse)]:overflow-x-auto [@media(pointer:fine)]:flex-wrap [@media(pointer:fine)]:justify-center border-border/70 bg-background/95 p-1 shadow-lg shadow-foreground/5 backdrop-blur-md [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [@media(pointer:coarse)]:pr-8 [@media(pointer:coarse)]:[mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)] animate-in fade-in-0 slide-in-from-bottom-2 duration-200 motion-reduce:animate-none"
      >
        <TextStyleMenu />
        <Divider />
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
        <Divider />
        <ListButton nodeType={KEYS.ul} label="Bulleted list">
          <List />
        </ListButton>
        <ListButton nodeType={KEYS.ol} label="Numbered list">
          <ListOrdered />
        </ListButton>
        <TodoButton />
        <Divider />
        <LinkButton />
        <CanvasTablePicker triggerClassName={toolButton} />
        <ToolButton
          label="Quote"
          pressed={quoted}
          onClick={() => {
            if (!isSelectingBlocks(editor)) return toggleQuote(editor);
            // Selected blocks: all quotes already → back to text, else one quote.
            const allQuoted = targetBlocks(editor).every(([node]) => node.type === KEYS.blockquote);
            turnInto(editor, allQuoted ? KEYS.p : KEYS.blockquote);
          }}
        >
          <TextQuote />
        </ToolButton>
        <BlockMenuButton />
      </div>
    </div>
  );
}

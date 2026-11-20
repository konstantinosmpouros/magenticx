import * as React from "react";
import {
  Archive,
  ArrowRight,
  Flag,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useReducedMotion } from "framer-motion";

import type { ConversationSummary } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";
import { Loader } from "@/shared/ui/shadcn-io/loader";
import { SidebarMenuAction, SidebarMenuItem } from "@/shared/ui/sidebar";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/shared/ui/context-menu";
import { useTouchMenuTrigger } from "@/shared/hooks/useTouchMenuTrigger";
import { RADIX_MOTION } from "@/shared/lib/motion/panels";
import { rowMotion } from "@/features/chat/lib/sidebarMotion";
import {
  MotionMenuItem,
  SidebarListRow,
  SidebarListRowTitle,
} from "@/features/chat/components/SidebarListRow";

/**
 * One conversation in the sidebar (Pinned and Chats): its title, the rename
 * field in place, the "⋯" menu, the right-click menu with the same actions,
 * and the spinner while it runs.
 *
 * Split out of ChatSidebar and memoized for plan 45 (Phase 6): with hundreds
 * of chats the Chats list is virtualized, and every scroll that moves the
 * window re-renders the list — a row whose props did not change (all
 * primitives or stable callbacks) now skips it. The props say which row is
 * active, being renamed or has a menu open as booleans, and only the row
 * being renamed receives the rename draft, so a keystroke re-renders one row.
 */

/** Which part of a row held focus when it unmounted, to give it back on remount. */
export type RowFocusHandoff = { id: string; part: string };

// A conversation row's two menus ("⋯" and right-click) share one look, so they
// read as the same menu. The items carry `focus:` beside `data-[highlighted]:`
// so they replace the shared context-menu item's own focus fill instead of
// stacking on it (a Radix menu's highlighted item is also the focused one).
const ROW_MENU_CONTENT =
  "z-50 w-48 rounded-lg border border-border bg-background p-1.5 text-sm text-foreground shadow-lg focus:outline-none";
const ROW_MENU_ITEM =
  "flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1 text-sm text-foreground transition-colors focus:bg-muted focus:text-foreground data-[highlighted]:bg-muted data-[highlighted]:text-foreground focus-visible:outline-none data-[highlighted]:outline-none";
const ROW_MENU_ITEM_DESTRUCTIVE =
  "flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1 text-sm text-destructive transition-colors focus:bg-destructive/10 focus:text-destructive data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive focus-visible:outline-none data-[highlighted]:outline-none";
const ROW_MENU_ICON = "flex h-7 w-7 items-center justify-center rounded-md bg-transparent";
const ROW_MENU_SEPARATOR = "mx-0 my-1 h-px bg-border/60";

/**
 * A conversation's actions, rendered by both its row's "⋯" menu and its
 * right-click menu so the two never drift apart. Each menu passes its own
 * Radix Item and Separator (a dropdown item cannot live in a context menu).
 */
function ConversationActionItems({
  isPinned,
  isReported,
  Item,
  Separator,
  onRename,
  onTogglePin,
  onArchive,
  onReport,
  onDelete,
}: {
  isPinned: boolean;
  isReported: boolean;
  // Optional props, as Radix declares them, so both menus' parts fit.
  Item: React.ComponentType<{
    onSelect?: (event: Event) => void;
    className?: string;
    children?: React.ReactNode;
  }>;
  Separator: React.ComponentType<{ className?: string }>;
  onRename: () => void;
  onTogglePin: () => void;
  onArchive: () => void;
  onReport: () => void;
  onDelete: () => void;
}) {
  return (
    <>
      <Item onSelect={onRename} className={ROW_MENU_ITEM}>
        <div className={cn(ROW_MENU_ICON, "text-muted-foreground")}>
          <Pencil size={15} />
        </div>
        <span>Rename</span>
      </Item>
      <Item onSelect={onTogglePin} className={ROW_MENU_ITEM}>
        <div className={cn(ROW_MENU_ICON, "text-muted-foreground")}>
          {isPinned ? <PinOff size={15} /> : <Pin size={15} />}
        </div>
        <span>{isPinned ? "Unpin" : "Pin"}</span>
      </Item>
      <Item onSelect={onArchive} className={ROW_MENU_ITEM}>
        <div className={cn(ROW_MENU_ICON, "text-muted-foreground")}>
          <Archive size={15} />
        </div>
        <span>Archive</span>
      </Item>
      {!isReported && (
        <Item onSelect={onReport} className={ROW_MENU_ITEM}>
          <div className={cn(ROW_MENU_ICON, "text-muted-foreground")}>
            <Flag size={15} />
          </div>
          <span>Report</span>
        </Item>
      )}
      <Separator className={ROW_MENU_SEPARATOR} />
      <Item onSelect={onDelete} className={ROW_MENU_ITEM_DESTRUCTIVE}>
        <div className={cn(ROW_MENU_ICON, "text-destructive")}>
          <Trash2 size={15} />
        </div>
        <span>Delete</span>
      </Item>
    </>
  );
}

type ConversationRowProps = {
  conversation: ConversationSummary;
  /** Its place in its list: the entrance stagger, and `data-index` when virtualized. */
  index: number;
  isActive: boolean;
  isRenaming: boolean;
  isActionMenuOpen: boolean;
  isContextMenuOpen: boolean;
  /** Bumped by the sidebar to remount (and so close) every right-click menu. */
  contextMenuEpoch: number;
  /** The rename field's text: "" on every row but the one being renamed. */
  renameDraft: string;
  isSubmittingRename: boolean;
  /**
   * Set on a virtualized list: the row's offset in px. The row is then placed
   * absolutely and does not animate (no entrance, slide or exit), since its
   * mount and unmount follow the scroll.
   */
  virtualOffset?: number;
  /** The virtualizer's measuring ref (virtualized list only). */
  measureRef?: (element: Element | null) => void;
  renameInputRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  renameContainerRef: React.MutableRefObject<HTMLDivElement | null>;
  /** Shared by every row: hands focus to the same chat's row when it remounts. */
  focusHandoffRef: React.MutableRefObject<RowFocusHandoff | null>;
  onSelect: (conversation: ConversationSummary) => void;
  onStartRename: (conversationId: string, currentTitle: string) => void;
  onRenameDraftChange: (value: string) => void;
  onSubmitRename: () => void | Promise<void>;
  onCancelRename: () => void;
  onActionMenuOpenChange: (conversationId: string, open: boolean) => void;
  onActionMenuToggle: (conversationId: string) => void;
  onContextMenuOpenChange: (conversationId: string, open: boolean) => void;
  onTogglePin?: (conversation: ConversationSummary) => void;
  onArchive?: (conversationId: string) => void;
  onReport?: (conversationId: string) => void;
  onDelete: (conversationId: string) => void;
  /** Warm the conversation's data on hover or focus (plan 45, Phase 5). */
  onPrefetch?: (conversationId: string) => void;
};

function ConversationRowImpl({
  conversation,
  index,
  isActive,
  isRenaming,
  isActionMenuOpen,
  isContextMenuOpen,
  contextMenuEpoch,
  renameDraft,
  isSubmittingRename,
  virtualOffset,
  measureRef,
  renameInputRef,
  renameContainerRef,
  focusHandoffRef,
  onSelect,
  onStartRename,
  onRenameDraftChange,
  onSubmitRename,
  onCancelRename,
  onActionMenuOpenChange,
  onActionMenuToggle,
  onContextMenuOpenChange,
  onTogglePin,
  onArchive,
  onReport,
  onDelete,
  onPrefetch,
}: ConversationRowProps) {
  const reduceMotion = useReducedMotion();
  // A finger opens the "⋯" menu on the tap's click (see the hook).
  const touchMenuTrigger = useTouchMenuTrigger();
  // Set when Rename is picked from the right-click menu: its close must not
  // hand focus back, or it would pull focus out of the rename field.
  const contextRenameRef = React.useRef(false);
  const itemRef = React.useRef<HTMLLIElement | null>(null);
  const setItemRef = React.useCallback(
    (element: HTMLLIElement | null) => {
      itemRef.current = element;
      measureRef?.(element);
    },
    [measureRef],
  );

  // Focus survives a remount of the row: the Chats list switching between its
  // animated and virtualized forms (plan 45) mounts every row afresh. A layout
  // cleanup runs before React removes the row's DOM, so the focused part is
  // still known here; the remounted row takes it back in the same commit.
  React.useLayoutEffect(() => {
    const item = itemRef.current;
    const handoff = focusHandoffRef.current;
    if (item && handoff?.id === conversation.id) {
      focusHandoffRef.current = null;
      const target =
        handoff.part === "rename"
          ? item.querySelector<HTMLElement>("textarea")
          : item.querySelector<HTMLElement>(`[data-sidebar="${handoff.part}"]`);
      target?.focus({ preventScroll: true });
    }
    return () => {
      const active = typeof document !== "undefined" ? document.activeElement : null;
      if (!item || !active || !item.contains(active)) return;
      const part =
        active.tagName === "TEXTAREA"
          ? "rename"
          : (active.closest("[data-sidebar]")?.getAttribute("data-sidebar") ?? "menu-button");
      const record = { id: conversation.id, part };
      focusHandoffRef.current = record;
      // Only good for the commit that unmounted the row: a mount later on
      // (the chat scrolled back into view, say) must not grab focus.
      requestAnimationFrame(() => {
        if (focusHandoffRef.current === record) focusHandoffRef.current = null;
      });
    };
  }, [conversation.id, focusHandoffRef]);

  const agent = conversation.agent;
  const rawTitle = typeof conversation.title === "string" ? conversation.title.trim() : "";
  const lastMessage = (conversation.lastMessage ?? "").trim();
  const fallbackTitle = lastMessage || agent?.name || "Untitled chat";
  const resolvedTitle = rawTitle || fallbackTitle;
  const canSubmitRename = renameDraft.trim().length > 0;
  // A busy row shows a spinner instead of its "⋯" menu; the right-click menu
  // follows it, so a running chat cannot be deleted or archived from either.
  const isBusy = Boolean(conversation.isStreaming || conversation.hasActiveTasks);
  const actionItemProps = {
    isPinned: Boolean(conversation.isPinned),
    isReported: Boolean(conversation.isReported),
    onRename: () => onStartRename(conversation.id, resolvedTitle),
    onTogglePin: () => onTogglePin?.(conversation),
    onArchive: () => onArchive?.(conversation.id),
    onReport: () => onReport?.(conversation.id),
    onDelete: () => onDelete(conversation.id),
  };
  const prefetch = onPrefetch ? () => onPrefetch(conversation.id) : undefined;

  const content = (
    <ContextMenu
      key={contextMenuEpoch}
      onOpenChange={(isOpen) => onContextMenuOpenChange(conversation.id, isOpen)}
    >
      {/* `contents`: the wrapper adds no box, so the row and its "⋯" stay
          siblings (the action is placed by `peer-*` on the row). Disabled
          while renaming, so the rename field keeps the browser's own menu. */}
      <ContextMenuTrigger asChild disabled={isRenaming || isBusy}>
        <div className="contents">
          <SidebarListRow
            isActive={isActive}
            className={cn(isContextMenuOpen && "bg-[hsl(var(--hover-surface))] text-foreground")}
            onClick={(event) => {
              if (isRenaming) {
                event.stopPropagation();
                return;
              }
              onSelect(conversation);
            }}
            tooltip={{
              children: (
                <div className="flex max-w-xs flex-col gap-0.5">
                  <span className="text-sm font-medium">{resolvedTitle}</span>
                  {lastMessage && (
                    <span
                      className="text-xs text-muted-foreground leading-snug"
                      style={{
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                    >
                      {lastMessage}
                    </span>
                  )}
                </div>
              ),
            }}
          >
            {isRenaming ? (
              <div
                ref={renameContainerRef}
                className="relative z-[1] flex w-full items-center gap-2 rounded-xl border border-border/60 bg-background/80 px-2 py-1"
                onClick={(event) => event.stopPropagation()}
              >
                <textarea
                  ref={renameInputRef}
                  rows={1}
                  value={renameDraft}
                  onChange={(event) => onRenameDraftChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void onSubmitRename();
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      onCancelRename();
                    }
                  }}
                  className="h-5 min-h-[1.25rem] w-full resize-none overflow-hidden border-none bg-transparent px-1 py-0 text-sm font-medium leading-5 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-0"
                  placeholder="Rename conversation"
                  spellCheck={false}
                />
                <button
                  type="button"
                  aria-label="Confirm rename"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void onSubmitRename();
                  }}
                  disabled={!canSubmitRename || isSubmittingRename}
                  className="grid size-7 flex-shrink-0 place-items-center rounded-full bg-primary text-primary-foreground shadow-md transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isSubmittingRename ? (
                    <Loader size={14} className="text-primary-foreground" />
                  ) : (
                    <ArrowRight className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            ) : (
              <SidebarListRowTitle>{resolvedTitle}</SidebarListRowTitle>
            )}
          </SidebarListRow>
          {!isRenaming &&
            (isBusy ? (
              <SidebarMenuAction
                aria-label={
                  conversation.isStreaming
                    ? "Conversation is streaming"
                    : "Background sub-agents are working"
                }
                onClick={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:!bg-transparent hover:!text-muted-foreground active:!bg-transparent focus-visible:!bg-transparent focus-visible:text-foreground peer-data-[size=lg]/menu-button:!top-1/2 peer-data-[size=lg]/menu-button:-translate-y-1/2"
              >
                <Loader size={14} />
              </SidebarMenuAction>
            ) : (
              <DropdownMenu.Root
                open={isActionMenuOpen}
                onOpenChange={(isOpen) => onActionMenuOpenChange(conversation.id, isOpen)}
              >
                <DropdownMenu.Trigger
                  asChild
                  {...touchMenuTrigger(() => onActionMenuToggle(conversation.id))}
                >
                  <SidebarMenuAction
                    aria-label="Conversation actions"
                    onClick={(event) => event.stopPropagation()}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    showOnHover
                    className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:!bg-transparent hover:!text-muted-foreground active:!bg-transparent focus-visible:!bg-transparent focus-visible:text-foreground peer-data-[size=lg]/menu-button:!top-1/2 peer-data-[size=lg]/menu-button:-translate-y-1/2"
                  >
                    <MoreHorizontal size={14} />
                  </SidebarMenuAction>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    side="right"
                    sideOffset={8}
                    align="end"
                    className={`${ROW_MENU_CONTENT} origin-[--radix-dropdown-menu-content-transform-origin] ${RADIX_MOTION.popover}`}
                    onCloseAutoFocus={(event) => event.preventDefault()}
                  >
                    <ConversationActionItems
                      {...actionItemProps}
                      Item={DropdownMenu.Item}
                      Separator={DropdownMenu.Separator}
                    />
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            ))}
        </div>
      </ContextMenuTrigger>
      {/* The same actions on right-click, opened at the pointer. */}
      <ContextMenuContent
        className={ROW_MENU_CONTENT}
        aria-label={`Actions for ${resolvedTitle}`}
        onCloseAutoFocus={(event) => {
          // After Rename the field takes focus; otherwise focus goes back
          // where it was, which keeps the menu usable from the keyboard.
          if (contextRenameRef.current) {
            contextRenameRef.current = false;
            event.preventDefault();
          }
        }}
      >
        <ConversationActionItems
          {...actionItemProps}
          onRename={() => {
            contextRenameRef.current = true;
            actionItemProps.onRename();
          }}
          Item={ContextMenuItem}
          Separator={ContextMenuSeparator}
        />
      </ContextMenuContent>
    </ContextMenu>
  );

  if (virtualOffset !== undefined) {
    return (
      <SidebarMenuItem
        ref={setItemRef}
        data-index={index}
        data-conversation-id={conversation.id}
        onPointerEnter={prefetch}
        onFocus={prefetch}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          transform: `translateY(${virtualOffset}px)`,
        }}
      >
        {content}
      </SidebarMenuItem>
    );
  }
  return (
    <MotionMenuItem
      ref={setItemRef}
      data-motion="row"
      data-conversation-id={conversation.id}
      onPointerEnter={prefetch}
      onFocus={prefetch}
      {...rowMotion(reduceMotion, index)}
    >
      {content}
    </MotionMenuItem>
  );
}

export const ConversationRow = React.memo(ConversationRowImpl);

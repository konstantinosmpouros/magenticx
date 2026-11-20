import * as React from "react";
import { motion, useReducedMotion } from "framer-motion";

import { cn } from "@/shared/lib/utils";
import { SidebarMenuButton, SidebarMenuItem } from "@/shared/ui/sidebar";
import { ROW_SPRING, SIDEBAR_ROW_LAYOUT_ID } from "@/features/chat/lib/sidebarMotion";

/**
 * The row primitives of the main sidebar's lists (Workflows, Pinned, Chats),
 * in their own module since plan 45 split the conversation row out of
 * ChatSidebar: both ChatSidebar (workflow rows) and ConversationRow use them.
 */

// List rows are motion <li>s: they fade in with a short stagger (also when the
// rail opens and the list mounts), slide to their new place when the list
// reorders (a pin, a new chat on top), and the selected row's highlight glides
// from row to row.
export const MotionMenuItem = motion.create(SidebarMenuItem);

/**
 * The one row of the sidebar's lists (Workflows, Pinned, Chats): the same
 * chrome, hover/press/focus surfaces, nudge-on-hover title, and the selected
 * row's highlight. The highlight shares one layoutId across every list, so it
 * glides between a chat and a workflow exactly as it does between two chats.
 *
 * `reserveActionSpace` keeps a row with no actions menu (a workflow) aligned
 * with the rows that have one: SidebarMenuButton pads itself (pr-8) only when
 * its item holds a SidebarMenuAction.
 */
export const SidebarListRow = React.forwardRef<
  HTMLButtonElement,
  Omit<React.ComponentProps<typeof SidebarMenuButton>, "size" | "isActive"> & {
    isActive: boolean;
    reserveActionSpace?: boolean;
  }
>(({ isActive, reserveActionSpace = false, className, children, ...props }, ref) => {
  const reduceMotion = useReducedMotion();
  return (
    <SidebarMenuButton
      ref={ref}
      size="lg"
      isActive={isActive}
      // Overflow stays visible so the gliding highlight is not clipped while
      // it moves in; titles sit above it (z-[1]) in every row it passes.
      className={cn(
        "group/row relative !h-auto min-h-[2rem] items-center !overflow-visible rounded-xl bg-transparent px-2.5 py-1 text-left text-muted-foreground shadow-none transition-colors duration-150 supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))] supports-[hover:hover]:hover:text-foreground active:bg-[hsl(var(--hover-surface-strong))] focus-visible:bg-[hsl(var(--hover-surface))] focus-visible:text-foreground focus-visible:ring-2 data-[active=true]:font-medium data-[active=true]:text-foreground",
        reserveActionSpace && "pr-8",
        className,
      )}
      {...props}
    >
      {isActive && (
        // The selected row's highlight, shared across rows (and sections), so it
        // glides to the newly selected row; a short bar of the brand gradient
        // marks it.
        <motion.span
          layoutId={SIDEBAR_ROW_LAYOUT_ID}
          data-layout-id={SIDEBAR_ROW_LAYOUT_ID}
          aria-hidden
          data-indicator="row"
          className="absolute inset-0 z-0 rounded-xl bg-[hsl(var(--hover-surface))]"
          transition={reduceMotion ? { duration: 0 } : ROW_SPRING}
        >
          <span
            className="absolute left-[3px] top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full"
            style={{ background: "var(--gradient-primary)" }}
          />
        </motion.span>
      )}
      {children}
    </SidebarMenuButton>
  );
});
SidebarListRow.displayName = "SidebarListRow";

/** A list row's title: truncated, above the highlight, nudged right on hover. */
export function SidebarListRowTitle({ children }: { children: React.ReactNode }) {
  return (
    <span className="relative z-[1] truncate text-[13px] transition-transform duration-200 ease-out motion-safe:supports-[hover:hover]:group-hover/row:translate-x-[3px]">
      {children}
    </span>
  );
}

import * as React from "react";
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import { Check, ChevronRight, Circle } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { RADIX_MOTION } from "@/shared/lib/motion/panels";

/**
 * The shadcn wrapper over Radix's context menu (right-click menu), styled to
 * match `dropdown-menu.tsx` so a row's right-click menu and its "⋯" menu read
 * as one menu.
 *
 * `@radix-ui/react-context-menu` is pinned to 2.2.16: it is built on the same
 * `@radix-ui/react-menu` (2.1.16) as the pinned dropdown menu, so both resolve
 * one `@radix-ui/react-dismissable-layer` — two copies break the page's
 * pointer-events after a menu opens a dialog (see CLAUDE.md, Components & UI
 * Library). Upgrade the two together.
 */

const ContextMenu = ContextMenuPrimitive.Root;
const ContextMenuGroup = ContextMenuPrimitive.Group;
const ContextMenuPortal = ContextMenuPrimitive.Portal;
const ContextMenuSub = ContextMenuPrimitive.Sub;
const ContextMenuRadioGroup = ContextMenuPrimitive.RadioGroup;

/**
 * The area that opens the menu on right-click (and on Shift+F10 / the Menu key
 * from the keyboard).
 *
 * A finger's long-press is ignored unless `allowTouch` is set. Radix opens a
 * touch context menu on a 700 ms timer while the finger is still down; the
 * modal menu then switches pointer events off outside it, and the lift's
 * click lands on whatever lies beneath — the same tap-through that
 * `useTouchMenuTrigger` exists to stop for the dropdown menus. Touch users
 * reach the same actions from the row's visible "⋯" button instead.
 */
const ContextMenuTrigger = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Trigger> & { allowTouch?: boolean }
>(
  (
    { allowTouch = false, onPointerDown, onPointerUp, onPointerCancel, onContextMenu, ...props },
    ref,
  ) => {
    // True while a finger or pen is down: the `contextmenu` event a long-press
    // fires (Android) arrives before the lift, so it can be told apart from a
    // right-click or the keyboard's menu key.
    const fingerDownRef = React.useRef(false);

    if (allowTouch) {
      return (
        <ContextMenuPrimitive.Trigger
          ref={ref}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onContextMenu={onContextMenu}
          {...props}
        />
      );
    }

    const releaseFinger = () => {
      fingerDownRef.current = false;
    };

    return (
      <ContextMenuPrimitive.Trigger
        ref={ref}
        onPointerDown={(event) => {
          onPointerDown?.(event);
          if (event.pointerType !== "mouse") {
            fingerDownRef.current = true;
            // Radix skips its long-press timer once the event is prevented.
            event.preventDefault();
          }
        }}
        onPointerUp={(event) => {
          onPointerUp?.(event);
          releaseFinger();
        }}
        onPointerCancel={(event) => {
          onPointerCancel?.(event);
          releaseFinger();
        }}
        onContextMenu={(event) => {
          onContextMenu?.(event);
          if (fingerDownRef.current) event.preventDefault();
        }}
        {...props}
      />
    );
  },
);
ContextMenuTrigger.displayName = ContextMenuPrimitive.Trigger.displayName;

const ContextMenuSubTrigger = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubTrigger> & { inset?: boolean }
>(({ className, inset, children, ...props }, ref) => (
  <ContextMenuPrimitive.SubTrigger
    ref={ref}
    className={cn(
      "flex cursor-default select-none items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-none focus:bg-accent data-[state=open]:bg-accent",
      inset && "pl-8",
      className,
    )}
    {...props}
  >
    {children}
    <ChevronRight className="ml-auto h-4 w-4" aria-hidden />
  </ContextMenuPrimitive.SubTrigger>
));
ContextMenuSubTrigger.displayName = ContextMenuPrimitive.SubTrigger.displayName;

const ContextMenuSubContent = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubContent>
>(({ className, ...props }, ref) => (
  // In its own portal, like the dropdown's: inside the parent content it is
  // clipped by that content's `overflow-hidden`.
  <ContextMenuPrimitive.Portal>
    <ContextMenuPrimitive.SubContent
      ref={ref}
      className={cn(
        "z-50 min-w-[8rem] overflow-hidden rounded-xl border border-border/60 bg-popover p-1 text-popover-foreground shadow-lg origin-[--radix-context-menu-content-transform-origin]",
        RADIX_MOTION.popover,
        className,
      )}
      {...props}
    />
  </ContextMenuPrimitive.Portal>
));
ContextMenuSubContent.displayName = ContextMenuPrimitive.SubContent.displayName;

const ContextMenuContent = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Portal>
    <ContextMenuPrimitive.Content
      ref={ref}
      className={cn(
        "z-50 min-w-[10rem] overflow-hidden rounded-xl border border-border/60 bg-popover p-1 text-popover-foreground shadow-lg origin-[--radix-context-menu-content-transform-origin]",
        RADIX_MOTION.popover,
        className,
      )}
      {...props}
    />
  </ContextMenuPrimitive.Portal>
));
ContextMenuContent.displayName = ContextMenuPrimitive.Content.displayName;

const ContextMenuItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> & {
    inset?: boolean;
    /** Destructive actions read in the destructive colour, hover included. */
    variant?: "default" | "destructive";
  }
>(({ className, inset, variant = "default", ...props }, ref) => (
  <ContextMenuPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex cursor-pointer select-none items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-none transition-colors",
      "focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      "[&>svg]:h-4 [&>svg]:w-4 [&>svg]:shrink-0",
      variant === "destructive"
        ? "text-destructive focus:bg-destructive/10 focus:text-destructive"
        : "text-foreground",
      inset && "pl-8",
      className,
    )}
    {...props}
  />
));
ContextMenuItem.displayName = ContextMenuPrimitive.Item.displayName;

const ContextMenuCheckboxItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.CheckboxItem>
>(({ className, children, checked, ...props }, ref) => (
  <ContextMenuPrimitive.CheckboxItem
    ref={ref}
    checked={checked}
    className={cn(
      "relative flex cursor-pointer select-none items-center rounded-lg py-1.5 pl-8 pr-2 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className,
    )}
    {...props}
  >
    <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
      <ContextMenuPrimitive.ItemIndicator>
        <Check className="h-4 w-4" aria-hidden />
      </ContextMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </ContextMenuPrimitive.CheckboxItem>
));
ContextMenuCheckboxItem.displayName = ContextMenuPrimitive.CheckboxItem.displayName;

const ContextMenuRadioItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.RadioItem>
>(({ className, children, ...props }, ref) => (
  <ContextMenuPrimitive.RadioItem
    ref={ref}
    className={cn(
      "relative flex cursor-pointer select-none items-center rounded-lg py-1.5 pl-8 pr-2 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className,
    )}
    {...props}
  >
    <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
      <ContextMenuPrimitive.ItemIndicator>
        <Circle className="h-2 w-2 fill-current" aria-hidden />
      </ContextMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </ContextMenuPrimitive.RadioItem>
));
ContextMenuRadioItem.displayName = ContextMenuPrimitive.RadioItem.displayName;

const ContextMenuLabel = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Label> & { inset?: boolean }
>(({ className, inset, ...props }, ref) => (
  <ContextMenuPrimitive.Label
    ref={ref}
    className={cn(
      "px-2 py-1.5 text-xs font-semibold text-muted-foreground",
      inset && "pl-8",
      className,
    )}
    {...props}
  />
));
ContextMenuLabel.displayName = ContextMenuPrimitive.Label.displayName;

const ContextMenuSeparator = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Separator
    ref={ref}
    className={cn("-mx-1 my-1 h-px bg-border/60", className)}
    {...props}
  />
));
ContextMenuSeparator.displayName = ContextMenuPrimitive.Separator.displayName;

/** A keyboard-shortcut hint at an item's right edge. */
const ContextMenuShortcut = ({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) => (
  <span
    className={cn("ml-auto text-xs tracking-widest text-muted-foreground", className)}
    {...props}
  />
);
ContextMenuShortcut.displayName = "ContextMenuShortcut";

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuRadioItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuGroup,
  ContextMenuPortal,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuRadioGroup,
};

/**
 * Queue — a list of things waiting their turn (queued messages, pending todos).
 *
 * Our copy of the AI Elements `Queue` (ai-sdk.dev/elements/components/queue):
 * the same parts — section with a collapsible trigger, list, item with an
 * indicator, content and hover actions. Written here rather than pulled with
 * `npx shadcn add`, because the registry is not reachable from the build
 * machine; it follows the AI Elements part names so a later pull lines up.
 * Ours differs in that the indicator can carry the item's place in line (a
 * number) and the actions stay visible on touch screens, which have no hover.
 */
import { forwardRef, type ComponentProps, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/shared/ui/collapsible";

/** The outer box. */
export function Queue({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("min-w-0 text-xs", className)} {...props} />;
}

/** A titled group of items that can fold away. */
export const QueueSection = Collapsible;

/** The section's header button: its label, then a chevron that turns when folded. */
export function QueueSectionTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof CollapsibleTrigger>) {
  return (
    <CollapsibleTrigger
      className={cn(
        "group/queue-trigger flex min-w-0 items-center gap-1.5 rounded-full px-1.5 py-1 text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
        className,
      )}
      {...props}
    >
      {children}
      <ChevronDown
        className="h-3.5 w-3.5 flex-shrink-0 transition-transform duration-200 group-data-[state=closed]/queue-trigger:-rotate-90"
        aria-hidden="true"
      />
    </CollapsibleTrigger>
  );
}

/** The header's text: an optional icon, the label, an optional count. */
export function QueueSectionLabel({
  icon,
  label,
  count,
  className,
}: {
  icon?: ReactNode;
  label: ReactNode;
  count?: number;
  className?: string;
}) {
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5 font-medium", className)}>
      {icon}
      <span className="truncate">{label}</span>
      {count !== undefined ? (
        <span className="rounded-full bg-primary/15 px-1.5 text-[10px] font-semibold tabular-nums leading-4 text-primary">
          {count}
        </span>
      ) : null}
    </span>
  );
}

export const QueueSectionContent = CollapsibleContent;

/**
 * The items, in order, joined by a thin line through their indicators so the
 * list reads as a sequence. The line runs from the first indicator's centre to
 * the last one's; with one item it is shorter than the indicator and hidden.
 */
export function QueueList({ className, ...props }: ComponentProps<"ol">) {
  return (
    <ol
      className={cn(
        "relative flex flex-col gap-1 before:absolute before:bottom-4 before:left-[1.125rem] before:top-4 before:w-px before:bg-gradient-to-b before:from-primary/40 before:to-border before:content-['']",
        className,
      )}
      {...props}
    />
  );
}

/**
 * One item: a row whose actions show on hover or focus (always on touch).
 * Forwards its ref so a caller can animate it (`motion.create(QueueItem)`).
 */
export const QueueItem = forwardRef<HTMLLIElement, ComponentProps<"li">>(function QueueItem(
  { className, ...props },
  ref,
) {
  return (
    <li
      ref={ref}
      className={cn(
        "group/queue-item flex min-w-0 items-center gap-2.5 rounded-xl px-2 py-0.5",
        className,
      )}
      {...props}
    />
  );
});

/**
 * The item's dot; with children (its place in line) it becomes a small numbered
 * ring. Its solid background hides the list's joining line behind it.
 */
export function QueueItemIndicator({ className, children, ...props }: ComponentProps<"span">) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative flex flex-shrink-0 items-center justify-center rounded-full border border-primary/35 bg-background text-primary",
        children === undefined ? "h-2.5 w-2.5" : "h-5 w-5 text-[10px] font-semibold tabular-nums leading-none",
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}

/**
 * The item's text as a small bubble, like the user's own messages in the chat,
 * as wide as its text; one line, cut with an ellipsis (the full text in its title).
 */
export function QueueItemContent({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "min-w-0 truncate rounded-xl rounded-tl-md bg-background/85 px-2.5 py-1 text-foreground shadow-sm ring-1 ring-border/60 transition-colors duration-150 group-hover/queue-item:ring-primary/30",
        className,
      )}
      {...props}
    />
  );
}

/** The item's buttons, hidden until the row is hovered or focused — except on touch screens. */
export function QueueItemActions({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "ml-auto flex flex-shrink-0 items-center opacity-0 transition-opacity duration-150 group-hover/queue-item:opacity-100 group-focus-within/queue-item:opacity-100 [@media(hover:none)]:opacity-100",
        className,
      )}
      {...props}
    />
  );
}

/** One icon button among the item's actions; it needs an aria-label. */
export function QueueItemAction({ className, type = "button", ...props }: ComponentProps<"button">) {
  return (
    <button
      type={type}
      className={cn(
        "relative flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 after:absolute after:-inset-2 after:content-[''] hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The editor surface, from Plate's shadcn registry (`platejs.org/r/editor`),
 * adapted: Tailwind 3 selectors instead of v4's (`**:`, `has-aria-*`), the
 * app's semantic tokens instead of `brand`, and a single "document" variant —
 * the reading column the canvas needs — instead of the demo variants.
 */
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { PlateContainer, PlateContent, type PlateContentProps } from "platejs/react";

import { cn } from "@/shared/lib/utils";

/** The scrollable box around the editable (it owns the scroll, not the page). */
export function EditorContainer({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <PlateContainer
      className={cn(
        "relative w-full cursor-text select-text caret-primary focus-visible:outline-none",
        className,
      )}
      {...props}
    />
  );
}

const editorVariants = cva(
  cn(
    "group/editor relative w-full cursor-text select-text whitespace-pre-wrap break-words",
    "focus-visible:outline-none selection:bg-primary/20 [&_*::selection]:bg-primary/20",
    "[&_[data-slate-placeholder]]:!opacity-100 [&_[data-slate-placeholder]]:text-muted-foreground/70",
    "[&_strong]:font-semibold [&_strong]:text-foreground",
  ),
  {
    defaultVariants: { variant: "document" },
    variants: {
      variant: {
        // The canvas's reading column: ~680px of text, sans body, roomy lines.
        document: "text-[16px] leading-[1.75] text-foreground/90",
        // A compact surface (a comment composer, a cell editor).
        compact: "text-sm leading-relaxed",
      },
    },
  },
);

export type EditorProps = PlateContentProps & VariantProps<typeof editorVariants>;

/** The editable itself. Plate's default inline styles are off; the classes above style it. */
export const Editor = React.forwardRef<HTMLDivElement, EditorProps>(
  ({ className, variant, ...props }, ref) => (
    <PlateContent
      ref={ref}
      className={cn(editorVariants({ variant }), className)}
      disableDefaultStyles
      {...props}
    />
  ),
);
Editor.displayName = "Editor";

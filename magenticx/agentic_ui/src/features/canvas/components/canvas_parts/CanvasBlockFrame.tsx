/**
 * The frame around every top-level block of the document: hides the block
 * when a heading above it is folded, puts a fold chevron at a heading's right
 * edge and the byline under the title.
 *
 * Written for the canvas: Plate has a toggle plugin, but it folds a dedicated
 * toggle block, not the section under a heading, and a markdown document has
 * no toggle blocks.
 */
import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { useEditorRef, usePluginOption } from "platejs/react";

import { cn } from "@/shared/lib/utils";

import { canvasViewPlugin, setFolds } from "../../lib/canvasView";
import { headingLevel } from "../../lib/outline";
import { CanvasByline } from "./CanvasByline";

/** Where the chevron sits so it centres on the heading's first line. */
const CHEVRON_TOP: Record<number, string> = {
  1: "top-[0.55rem] sm:top-[0.8rem]",
  2: "top-[0.2rem] sm:top-[0.3rem]",
  3: "top-0",
  4: "top-0",
};

export function CanvasBlockFrame({
  index,
  type,
  children,
}: {
  index: number;
  type: string;
  children: ReactNode;
}) {
  const editor = useEditorRef();
  const hidden = usePluginOption(canvasViewPlugin, "hidden");
  const folded = usePluginOption(canvasViewPlugin, "folded");

  const level = headingLevel(type);
  const isFolded = folded.includes(index);
  const isTitle = index === 0 && level === 1;

  const toggleFold = () => {
    const current = editor.getOption(canvasViewPlugin, "folded");
    setFolds(editor, isFolded ? current.filter((item) => item !== index) : [...current, index]);
  };

  return (
    <div
      data-canvas-block={index}
      className={cn(
        "group/block relative",
        hidden.includes(index) && "hidden",
        index === 0 && "[&>*:first-child]:!mt-0",
      )}
    >
      {children}

      {level !== null ? (
        <span
          contentEditable={false}
          className={cn("absolute right-0 select-none", CHEVRON_TOP[level])}
        >
          <button
            type="button"
            aria-label={isFolded ? "Expand section" : "Collapse section"}
            aria-expanded={!isFolded}
            onMouseDown={(event) => event.preventDefault()}
            onClick={toggleFold}
            className={cn(
              "flex size-8 items-center justify-center rounded-md text-muted-foreground/60 transition-colors duration-150",
              "hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              isFolded && "text-foreground",
            )}
          >
            <ChevronDown
              className={cn(
                "size-[18px] transition-transform duration-200",
                isFolded && "-rotate-90",
              )}
            />
          </button>
        </span>
      ) : null}

      {isTitle ? <CanvasByline className="mb-8 mt-1" /> : null}
    </div>
  );
}

/**
 * Where the document canvas sits beside the chat (plan 44 §3 "Layout"): the
 * chat on the left, the document docked on the right at ~55% of the card,
 * its left edge dragged to resize (remembered on this device). Full screen
 * covers the chat; on a phone, or in a window too narrow to share, the
 * canvas always covers it. The chat stays mounted under it either way, so
 * closing the canvas finds the conversation exactly as it was.
 *
 * Without a document open this is just the chat column. The canvas itself is
 * lazy-loaded (`DocumentCanvas`) behind an error boundary, so a crash in the
 * editor never takes the chat down with it.
 */
import { lazy, Suspense, useState, type ReactNode } from "react";

import { useIsMobile } from "@/shared/hooks/use-mobile";
import { useResizablePanel } from "@/shared/hooks/useResizablePanel";
import { cn } from "@/shared/lib/utils";
import { SectionBoundary } from "@/shared/ui/SectionBoundary";

import { CanvasSkeleton } from "./canvas_parts/CanvasStates";
import type { DocumentCanvasProps } from "./DocumentCanvas";

const DocumentCanvas = lazy(() => import("./DocumentCanvas"));

/** The canvas's share of the card until the user drags it (plan 44: ~55%). */
const DEFAULT_SHARE = 0.55;

const CANVAS_PANEL = {
  storageKey: "magenticx:canvas:width",
  min: 380,
  max: 1600,
  defaultWidth: (area: number) => area * DEFAULT_SHARE,
  // The chat keeps a readable column (and its composer) beside the document.
  siblingMin: 360,
  // Narrower than this, chat and document can't both be read: cover the chat.
  dockMinArea: 760,
  label: "Resize the document",
} as const;

/** What the dock needs to show a document; everything else is the canvas's own. */
export type CanvasDockDocument = Omit<
  DocumentCanvasProps,
  "compact" | "canToggleFullscreen" | "fullscreen" | "onToggleFullscreen"
>;

export function CanvasDock({
  document,
  children,
}: {
  /** The open document, or null for the chat alone. */
  document: CanvasDockDocument | null;
  /** The chat column. */
  children: ReactNode;
}) {
  const isPhone = useIsMobile();
  const panel = useResizablePanel(CANVAS_PANEL);
  const [fullscreen, setFullscreen] = useState(false);
  const covers = isPhone || panel.layout === "drawer";

  const close = () => {
    setFullscreen(false);
    document?.onClose();
  };

  return (
    <div ref={panel.areaRef} className="relative flex min-h-0 flex-1">
      {/* `isolate`: the chat's own layers (its sticky composer, z-40) stay
          inside it, so a canvas covering the chat paints over all of them. */}
      <div className="relative isolate flex min-w-0 flex-1 flex-col">{children}</div>

      {document ? (
        <div
          className={cn(
            "flex min-h-0 bg-background animate-in fade-in-0 duration-300 motion-reduce:animate-none",
            covers || fullscreen
              ? "absolute inset-0 z-30"
              : "relative shrink-0 border-l border-border/70 slide-in-from-right-4",
          )}
          style={covers || fullscreen ? undefined : { width: panel.width }}
        >
          {covers || fullscreen ? null : (
            <div
              {...panel.separatorProps}
              className={cn(
                "group absolute -left-1.5 top-0 z-10 flex h-full w-3 cursor-col-resize justify-center focus-visible:outline-none",
              )}
            >
              <span
                className={cn(
                  "h-full w-px bg-transparent transition-colors duration-150 group-hover:bg-primary/50 group-focus-visible:bg-primary",
                  panel.dragging && "bg-primary",
                )}
              />
            </div>
          )}
          <SectionBoundary label="document">
            <Suspense fallback={<CanvasSkeleton />}>
              <DocumentCanvas
                {...document}
                onClose={close}
                compact={isPhone}
                canToggleFullscreen={!covers}
                fullscreen={fullscreen}
                onToggleFullscreen={() => setFullscreen((value) => !value)}
              />
            </Suspense>
          </SectionBoundary>
        </div>
      ) : null}
    </div>
  );
}

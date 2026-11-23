/**
 * One file as a card in the Artifacts grid: its cover (the family's drawing,
 * the extension and size), the title the agent gave it with the file name
 * under it, the agent's summary, and a footer with where it came from (Input
 * or Output, the conversation as a link) and how old it is.
 *
 * The whole card opens the file — the title button's hit area is stretched
 * over the card — so the biggest target does the commonest thing: a canvas
 * document opens in its conversation's canvas, anything else in the preview.
 * The conversation link, the dock and the ⋯ menu sit above that layer.
 *
 * Built for a long, virtualized grid (plan 45): memoized; the hover lift, the
 * sheet's tilt and the glow are CSS transform/opacity; the light that follows
 * the pointer is two CSS variables written straight to the element, so moving
 * the mouse never re-renders React. Only the entrance uses framer-motion, and
 * only when the card mounts.
 */
import { memo, type PointerEvent } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { MessageSquareText, Paperclip, Sparkles } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import type { UserFile } from "@/shared/lib/types";
import { ArtifactCover } from "@/features/artifacts/components/artifacts_parts/ArtifactCover";
import {
  ArtifactActionDock,
  ArtifactActionMenu,
  type ArtifactHandlers,
} from "@/features/artifacts/components/artifacts_parts/ArtifactActions";
import { describeFile } from "@/features/artifacts/lib/fileView";

const EASE = [0.22, 1, 0.36, 1] as const;

/** Writes the pointer's position for the card's spotlight; no React state. */
function trackPointer(event: PointerEvent<HTMLElement>) {
  if (event.pointerType !== "mouse") return;
  const box = event.currentTarget.getBoundingClientRect();
  event.currentTarget.style.setProperty("--spot-x", `${event.clientX - box.left}px`);
  event.currentTarget.style.setProperty("--spot-y", `${event.clientY - box.top}px`);
}

/** The kind as a small badge: what an agent made, or what the user attached. */
export function KindBadge({ output }: { output: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex flex-shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        output ? "bg-primary/10 text-primary" : "bg-muted/70 text-muted-foreground",
      )}
    >
      {output ? <Sparkles size={11} aria-hidden /> : <Paperclip size={11} aria-hidden />}
      {output ? "Output" : "Input"}
    </span>
  );
}

function ArtifactCardImpl({
  file,
  previewBusy,
  introDelay,
  onPreview,
  onDownload,
  onOpenConversation,
  onOpenCanvas,
}: ArtifactHandlers & {
  file: UserFile;
  previewBusy: boolean;
  /** Seconds to wait before rising in, or null to appear at once (scrolled into view later). */
  introDelay: number | null;
}) {
  const reduceMotion = useReducedMotion();
  const view = describeFile(file);
  const open = () =>
    view.canvasPath ? onOpenCanvas(file.conversationId, view.canvasPath) : onPreview(file);

  return (
    <motion.article
      data-testid="artifact-item"
      onPointerMove={trackPointer}
      initial={reduceMotion || introDelay === null ? false : { opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.38, ease: EASE, delay: introDelay ?? 0 }}
      className="h-full"
    >
      <div
        className={cn(
          "group relative isolate flex h-full flex-col overflow-hidden rounded-[1.15rem] border border-border/60 bg-card",
          "transition-[transform,border-color] duration-200 ease-out hover:-translate-y-1 hover:border-primary/30 motion-reduce:transition-none motion-reduce:hover:translate-y-0",
          // The lifted shadow lives on a layer that only fades in: animating
          // box-shadow itself would repaint the card on every frame.
          "before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:rounded-[inherit] before:opacity-0 before:shadow-[0_22px_50px_-24px_hsl(var(--primary)/0.45)] before:transition-opacity before:duration-200 hover:before:opacity-100",
        )}
      >
        {/* The spotlight that follows a mouse across the card. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-[1] opacity-0 transition-opacity duration-300 group-hover:opacity-100"
          style={{
            background:
              "radial-gradient(280px circle at var(--spot-x, 50%) var(--spot-y, 0%), hsl(var(--primary) / 0.09), transparent 65%)",
          }}
        />

        <ArtifactCover visual={view.visual} accent={view.accent}>
          <span className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-background/80 px-2 py-1 text-[10px] font-semibold tracking-wide text-muted-foreground shadow-sm ring-1 ring-border/50">
            <span className={cn("h-1.5 w-1.5 rounded-full", view.accent.dot)} aria-hidden />
            <span className="font-mono">{view.extension || view.typeLabel.toUpperCase()}</span>
            {view.size ? (
              <>
                <span aria-hidden className="text-muted-foreground/50">·</span>
                <span className="tabular-nums font-medium">{view.size}</span>
              </>
            ) : null}
          </span>
          <ArtifactActionDock
            variant="overlay"
            file={file}
            canvasPath={view.canvasPath}
            previewBusy={previewBusy}
            onPreview={onPreview}
            onDownload={onDownload}
            onOpenCanvas={onOpenCanvas}
          />
          <ArtifactActionMenu
            file={file}
            canvasPath={view.canvasPath}
            previewBusy={previewBusy}
            className="absolute right-1.5 top-1.5 bg-background/80 text-foreground shadow-sm ring-1 ring-border/50"
            onPreview={onPreview}
            onDownload={onDownload}
            onOpenConversation={onOpenConversation}
            onOpenCanvas={onOpenCanvas}
          />
        </ArtifactCover>

        <div className="flex flex-1 flex-col px-4 pb-3.5 pt-3.5">
          <button
            type="button"
            onClick={open}
            title={view.title}
            className={cn(
              "block max-w-full truncate rounded-md text-left text-[15px] font-semibold leading-snug tracking-tight text-foreground focus-visible:outline-none",
              // Stretched over the card: the whole card is this button's target.
              "after:absolute after:inset-0 after:z-[2] after:rounded-[1.15rem] after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-primary/60",
            )}
          >
            {view.title}
          </button>
          {view.showFileName ? (
            <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={file.fileName}>
              {file.fileName}
            </p>
          ) : null}
          {file.summary ? (
            <p className="mt-2 line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">{file.summary}</p>
          ) : null}

          {/* Pushes the footer to the card's foot, so a row of cards lines up. */}
          <div aria-hidden className="min-h-3.5 flex-1" />
          <div className="flex items-center gap-2 border-t border-border/50 pt-3 text-xs text-muted-foreground">
            <KindBadge output={view.output} />
            <button
              type="button"
              onClick={() => onOpenConversation(file.conversationId)}
              aria-label={`Open conversation ${view.conversation}`}
              title={view.conversation}
              className="relative z-10 inline-flex min-w-0 items-center gap-1 rounded-md py-1 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              <MessageSquareText size={12} aria-hidden className="flex-shrink-0" />
              <span className="truncate">{view.conversation}</span>
            </button>
            {view.age ? (
              <time
                dateTime={file.createdAt}
                title={view.date}
                className="ml-auto flex-shrink-0 whitespace-nowrap tabular-nums"
              >
                {view.age}
              </time>
            ) : null}
          </div>
        </div>
      </div>
    </motion.article>
  );
}

export const ArtifactCard = memo(ArtifactCardImpl);

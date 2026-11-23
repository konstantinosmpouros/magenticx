/**
 * One file as a row in the Artifacts page's list view — the dense
 * alternative to the grid, for scanning many files: the family's coloured
 * tile, the title (with the file name under it when they differ), then where
 * it came from, how old and how big, and the actions.
 *
 * Like the card, the whole row opens the file (the title's hit area is
 * stretched over it) and the conversation is a link of its own. On a touch
 * screen the dock gives way to the ⋯ menu. Memoized for the virtualized list.
 */
import { memo, type PointerEvent } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { MessageSquareText } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import type { UserFile } from "@/shared/lib/types";
import { KindBadge } from "@/features/artifacts/components/artifacts_parts/ArtifactCard";
import {
  ArtifactActionDock,
  ArtifactActionMenu,
  type ArtifactHandlers,
} from "@/features/artifacts/components/artifacts_parts/ArtifactActions";
import { describeFile } from "@/features/artifacts/lib/fileView";

const EASE = [0.22, 1, 0.36, 1] as const;

function trackPointer(event: PointerEvent<HTMLElement>) {
  if (event.pointerType !== "mouse") return;
  const box = event.currentTarget.getBoundingClientRect();
  event.currentTarget.style.setProperty("--spot-x", `${event.clientX - box.left}px`);
}

function ArtifactRowImpl({
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
  introDelay: number | null;
}) {
  const reduceMotion = useReducedMotion();
  const view = describeFile(file);
  const { Icon } = view;
  const open = () =>
    view.canvasPath ? onOpenCanvas(file.conversationId, view.canvasPath) : onPreview(file);

  return (
    <motion.div
      data-testid="artifact-item"
      onPointerMove={trackPointer}
      initial={reduceMotion || introDelay === null ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: EASE, delay: introDelay ?? 0 }}
      className="group relative isolate flex items-center gap-3.5 overflow-hidden rounded-2xl border border-border/60 bg-card px-3 py-3 transition-colors duration-200 hover:border-primary/30 sm:px-4"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{
          background:
            "radial-gradient(340px circle at var(--spot-x, 30%) 50%, hsl(var(--primary) / 0.07), transparent 70%)",
        }}
      />

      <span
        className={cn(
          "grid h-11 w-11 flex-shrink-0 place-items-center rounded-xl ring-1 transition-transform duration-200 ease-out group-hover:scale-105 motion-reduce:transition-none",
          view.accent.soft,
          view.accent.ring,
          view.accent.text,
        )}
        title={view.typeLabel}
      >
        <Icon size={19} aria-hidden />
        <span className="sr-only">{view.typeLabel}</span>
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <button
            type="button"
            onClick={open}
            title={view.title}
            className="min-w-0 truncate rounded text-left text-sm font-semibold tracking-tight text-foreground focus-visible:outline-none after:absolute after:inset-0 after:z-[1] after:rounded-[inherit] after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-primary/60"
          >
            {view.title}
          </button>
          {view.showFileName ? (
            <span className="hidden min-w-0 truncate font-mono text-[11px] text-muted-foreground md:inline" title={file.fileName}>
              {file.fileName}
            </span>
          ) : null}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <KindBadge output={view.output} />
          {view.extension ? (
            <span className="rounded-md bg-muted/70 px-1.5 py-px font-mono text-[10px] font-medium tracking-wide">
              {view.extension}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => onOpenConversation(file.conversationId)}
            aria-label={`Open conversation ${view.conversation}`}
            title={view.conversation}
            className="relative z-10 inline-flex min-w-0 max-w-full items-center gap-1 rounded-md transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 max-sm:order-last max-sm:basis-full sm:max-w-[16rem]"
          >
            <MessageSquareText size={12} aria-hidden className="flex-shrink-0" />
            <span className="truncate">{view.conversation}</span>
          </button>
          {/* Age and size travel together, so a wrap never strands a "·" at a
              line's end; the dot before them only shows where the conversation
              sits on the same line (from `sm`). */}
          {view.age || view.size ? (
            <span className="inline-flex items-center gap-x-2 whitespace-nowrap tabular-nums">
              <span aria-hidden className="text-muted-foreground/50 max-sm:hidden">·</span>
              {view.age ? (
                <time dateTime={file.createdAt} title={view.date}>
                  {view.age}
                </time>
              ) : null}
              {view.age && view.size ? <span aria-hidden className="text-muted-foreground/50">·</span> : null}
              {view.size ? <span>{view.size}</span> : null}
            </span>
          ) : null}
        </div>
      </div>

      <ArtifactActionDock
        variant="inline"
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
        onPreview={onPreview}
        onDownload={onDownload}
        onOpenConversation={onOpenConversation}
        onOpenCanvas={onOpenCanvas}
      />
    </motion.div>
  );
}

export const ArtifactRow = memo(ArtifactRowImpl);

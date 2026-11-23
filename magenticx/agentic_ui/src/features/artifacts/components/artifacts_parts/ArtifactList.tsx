import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";

import type { UserFile } from "@/shared/lib/types";
import { useVirtualList } from "@/shared/hooks/useVirtualList";
import { ArtifactCard } from "@/features/artifacts/components/artifacts_parts/ArtifactCard";
import { ArtifactRow } from "@/features/artifacts/components/artifacts_parts/ArtifactRow";
import type { ArtifactHandlers } from "@/features/artifacts/components/artifacts_parts/ArtifactActions";
import { dateGroupLabel } from "@/features/artifacts/lib/fileFilters";
import type { ArtifactsView } from "@/features/artifacts/hooks/useArtifactsView";

/** Expected heights (px) before an entry is measured: a row of cards, a list row, a date heading. */
const CARD_ROW_ESTIMATE_PX = 300;
const LIST_ROW_ESTIMATE_PX = 72;
/** Space between entries, as the list's former `space-y-*` (the virtualizer places them absolutely). */
const GRID_GAP_PX = 16;
const LIST_GAP_PX = 10;
/** How many of the first files rise in one after another; the rest appear at once. */
const STAGGERED = 12;
const STAGGER_S = 0.045;

/** Cards per row for the grid's width: one on a phone, two on a tablet, three from there. */
function columnsFor(width: number): number {
  if (width >= 880) return 3;
  if (width >= 540) return 2;
  return 1;
}

type Entry =
  | { kind: "heading"; key: string; label: string }
  | { kind: "files"; key: string; files: UserFile[]; firstIndex: number };

/**
 * The files, newest first, under date headings (Today, Yesterday, …), as a
 * grid of cards or a list of rows.
 *
 * Virtualized either way (plan 45, Phase 6): "Load more" and the scroll
 * sentinel keep adding pages, so only the entries near the viewport are in
 * the DOM, inside the page's own scroll box (`[data-artifacts-scroll]`). An
 * entry is a heading, a list row, or a whole ROW of cards — the grid is
 * re-chunked when its width changes the column count — and every entry is
 * measured, so a card with a summary or a row that wraps takes its real height.
 */
export function ArtifactList({
  items,
  view,
  refreshing,
  loadingImageId,
  ...handlers
}: ArtifactHandlers & {
  items: UserFile[];
  view: ArtifactsView;
  /** A filter change is loading: the entries stay, dimmed. */
  refreshing: boolean;
  loadingImageId: string | null;
}) {
  const reduceMotion = useReducedMotion();
  const widthRef = useRef<HTMLDivElement | null>(null);
  const [columns, setColumns] = useState(1);

  useEffect(() => {
    const element = widthRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0;
      if (width > 0) setColumns(columnsFor(width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const perRow = view === "grid" ? columns : 1;
  const entries = useMemo(() => {
    const out: Entry[] = [];
    const now = new Date();
    let label: string | null = null;
    let bucket: UserFile[] = [];
    let bucketStart = 0;
    const flush = () => {
      for (let i = 0; i < bucket.length; i += perRow) {
        const files = bucket.slice(i, i + perRow);
        out.push({ kind: "files", key: `f:${files[0].attachmentId}`, files, firstIndex: bucketStart + i });
      }
      bucket = [];
    };
    items.forEach((file, index) => {
      const group = dateGroupLabel(file.createdAt, now);
      if (group !== label) {
        flush();
        label = group;
        bucketStart = index;
        out.push({ kind: "heading", key: `h:${group}`, label: group });
      }
      bucket.push(file);
    });
    flush();
    return out;
  }, [items, perRow]);

  const keys = useMemo(() => entries.map((entry) => entry.key), [entries]);
  const { listRef, virtualItems, totalSize, scrollMargin, measureElement, onFocus } =
    useVirtualList<HTMLDivElement>({
      keys,
      estimateSize: view === "grid" ? CARD_ROW_ESTIMATE_PX : LIST_ROW_ESTIMATE_PX,
      gap: view === "grid" ? GRID_GAP_PX : LIST_GAP_PX,
      scrollContainerSelector: "[data-artifacts-scroll]",
    });

  const introDelay = (index: number) =>
    reduceMotion || index >= STAGGERED ? null : index * STAGGER_S;

  return (
    <div ref={widthRef}>
      <motion.div
        ref={listRef}
        role="region"
        aria-label="Files"
        aria-busy={refreshing || undefined}
        className="relative"
        style={{ height: totalSize }}
        onFocus={onFocus}
        animate={{ opacity: refreshing ? 0.55 : 1 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
      >
        {virtualItems.map((item) => {
          const entry = entries[item.index];
          if (!entry) return null;
          return (
            <div
              key={entry.key}
              ref={measureElement}
              data-index={item.index}
              className="absolute left-0 top-0 w-full"
              style={{ transform: `translateY(${item.start - scrollMargin}px)` }}
            >
              {entry.kind === "heading" ? (
                <div className="flex items-center gap-3 pb-0.5 pt-3">
                  <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    {entry.label}
                  </h2>
                  <span aria-hidden className="h-px flex-1 bg-gradient-to-r from-border to-transparent" />
                </div>
              ) : view === "grid" ? (
                <div
                  className="grid gap-4"
                  style={{ gridTemplateColumns: `repeat(${perRow}, minmax(0, 1fr))` }}
                >
                  {entry.files.map((file, i) => (
                    <ArtifactCard
                      key={file.attachmentId}
                      file={file}
                      previewBusy={loadingImageId === file.attachmentId}
                      introDelay={introDelay(entry.firstIndex + i)}
                      {...handlers}
                    />
                  ))}
                </div>
              ) : (
                <ArtifactRow
                  file={entry.files[0]}
                  previewBusy={loadingImageId === entry.files[0].attachmentId}
                  introDelay={introDelay(entry.firstIndex)}
                  {...handlers}
                />
              )}
            </div>
          );
        })}
      </motion.div>
    </div>
  );
}

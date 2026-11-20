import { useMemo } from "react";
import { motion, useReducedMotion } from "framer-motion";

import type { UserFile } from "@/shared/lib/types";
import { useVirtualList } from "@/shared/hooks/useVirtualList";
import { ArtifactRow } from "@/features/artifacts/components/artifacts_parts/ArtifactRow";

/** A row's height on a wide screen (40px tile + padding + border); measured once rendered. */
const ROW_ESTIMATE_PX = 64;
/** The space between rows, as the list's former `space-y-2`. */
const ROW_GAP_PX = 8;

/**
 * The Artifacts page's list of files, virtualized (plan 45, Phase 6): "Load
 * more" and the scroll sentinel keep adding pages, so without a bound the DOM
 * grew a row — with its tooltips and menu — per file ever loaded. Only the
 * rows near the viewport are rendered now, inside the page's own scroll box
 * (`[data-artifacts-scroll]`), below the toolbar; rows are measured, so a row
 * that wraps on a phone takes its real height.
 */
export function ArtifactList({
  items,
  refreshing,
  loadingImageId,
  onPreview,
  onDownload,
  onOpenConversation,
  onOpenCanvas,
}: {
  items: UserFile[];
  /** A filter change is loading: the rows stay, dimmed. */
  refreshing: boolean;
  loadingImageId: string | null;
  onPreview: (file: UserFile) => void;
  onDownload: (file: UserFile) => void;
  onOpenConversation: (conversationId: string) => void;
  onOpenCanvas: (conversationId: string, path: string) => void;
}) {
  const reduceMotion = useReducedMotion();
  const keys = useMemo(() => items.map((file) => file.attachmentId), [items]);
  const { listRef, virtualItems, totalSize, scrollMargin, measureElement, onFocus } =
    useVirtualList<HTMLUListElement>({
      keys,
      estimateSize: ROW_ESTIMATE_PX,
      gap: ROW_GAP_PX,
      scrollContainerSelector: "[data-artifacts-scroll]",
    });

  return (
    <motion.ul
      ref={listRef}
      aria-label="Files"
      aria-busy={refreshing || undefined}
      className="relative"
      style={{ height: totalSize }}
      onFocus={onFocus}
      initial={reduceMotion ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: refreshing ? 0.6 : 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
    >
      {virtualItems.map((item) => {
        const file = items[item.index];
        return (
          <ArtifactRow
            key={file.attachmentId}
            ref={measureElement}
            index={item.index}
            offset={item.start - scrollMargin}
            file={file}
            previewBusy={loadingImageId === file.attachmentId}
            onPreview={onPreview}
            onDownload={onDownload}
            onOpenConversation={onOpenConversation}
            onOpenCanvas={onOpenCanvas}
          />
        );
      })}
    </motion.ul>
  );
}

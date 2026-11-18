import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { LoaderCircle } from "lucide-react";

import { ImageLightbox } from "@/shared/ui/ImageLightbox";
import { SidebarTrigger } from "@/shared/ui/sidebar";
import AttachmentPreviewPanel from "@/features/attachments/components/AttachmentPreviewPanel";
import { ArtifactRow } from "@/features/artifacts/components/artifacts_parts/ArtifactRow";
import {
  ArtifactsEmpty,
  ArtifactsError,
  ArtifactsSkeleton,
} from "@/features/artifacts/components/artifacts_parts/ArtifactsStates";
import { ArtifactsToolbar } from "@/features/artifacts/components/artifacts_parts/ArtifactsToolbar";
import { useArtifactActions } from "@/features/artifacts/hooks/useArtifactActions";
import { useDebouncedValue } from "@/features/artifacts/hooks/useDebouncedValue";
import { useLoadMoreSentinel } from "@/features/artifacts/hooks/useLoadMoreSentinel";
import { useUserFiles } from "@/features/artifacts/hooks/useUserFiles";
import {
  SEARCH_DEBOUNCE_MS,
  type KindFilter,
  type TypeFilter,
} from "@/features/artifacts/lib/fileFilters";

/**
 * The Artifacts page (plan 44): every file of the user's in one place —
 * what they attached (Inputs) and what agents made and presented for them
 * (Outputs), across all their conversations, newest first.
 *
 * Filters (kind, type) and the search run on the bridge, so they cover every
 * file, not just the pages loaded so far; "Load more" follows its cursor. Each
 * row previews the file with the chat's own preview surfaces, downloads it,
 * or opens the conversation it belongs to.
 */
export default function ArtifactsPage({
  userId,
  onOpenConversation,
  onOpenCanvas,
  onStartChat,
}: {
  userId: string | null;
  onOpenConversation: (conversationId: string) => void;
  /** Opens a canvas document in its conversation (plan 44, Phase 4.1). */
  onOpenCanvas: (conversationId: string, path: string) => void;
  onStartChat: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const [kind, setKind] = useState<KindFilter>("all");
  const [type, setType] = useState<TypeFilter>("all");
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
  const files = useUserFiles(userId, { kind, type, query: debouncedQuery });
  const actions = useArtifactActions(userId);
  // Scrolling near the end loads the next page by itself; the button below
  // is the same action for keyboards and for browsers without the observer.
  const loadMoreRef = useLoadMoreSentinel<HTMLDivElement>(
    files.hasMore && !files.loadingMore && !files.loading && !files.error,
    files.loadMore,
  );

  // The tab reads like the sidebar entry while the page is open; the chat's own
  // title comes back on the way out.
  useEffect(() => {
    const previous = document.title;
    document.title = "Artifacts · mAgenticX";
    return () => {
      document.title = previous;
    };
  }, []);

  const filtered = kind !== "all" || type !== "all" || debouncedQuery.trim() !== "";
  const clearFilters = () => {
    setKind("all");
    setType("all");
    setQuery("");
  };
  const showSkeleton = files.loading && !files.loaded;
  // A filter change keeps the previous rows on screen (dimmed) until the new
  // page lands, instead of flashing the skeleton on every keystroke.
  const refreshing = files.loading && files.loaded;

  return (
    <div className="flex h-full flex-col">
      <header className="flex-shrink-0 px-4 pb-4 pt-4 sm:px-6 sm:pt-6">
        <div className="mx-auto flex w-full max-w-4xl items-center gap-3">
          {/* On mobile the sidebar is an overlay sheet and this page covers the
              chat header's own trigger — the same md:hidden toggle Automations
              and Agents carry, so there is always a way back to the sidebar. */}
          <SidebarTrigger
            aria-label="Toggle sidebar"
            className="inline-flex h-10 w-10 flex-shrink-0 rounded-xl bg-transparent text-foreground transition-colors hover:bg-[hsl(var(--hover-surface))] hover:text-foreground active:bg-[hsl(var(--hover-surface-strong))] focus-visible:ring-2 focus-visible:ring-ring md:hidden [&_svg]:size-5"
          />
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
              Artifacts
            </h1>
            <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">
              Every file you attached and every file your agents made, across your conversations.
            </p>
          </div>
        </div>
      </header>

      <div className="scrollbar-muted min-h-0 flex-1 overflow-y-auto px-4 sm:px-6">
        <div className="mx-auto w-full max-w-4xl space-y-4 pb-10 pt-1">
          <ArtifactsToolbar
            query={query}
            onQueryChange={setQuery}
            kind={kind}
            onKindChange={setKind}
            type={type}
            onTypeChange={setType}
          />

          {files.error && files.items.length === 0 ? (
            <ArtifactsError message={files.error} onRetry={files.reload} />
          ) : showSkeleton ? (
            <ArtifactsSkeleton />
          ) : files.loaded && files.items.length === 0 && !files.loading ? (
            <ArtifactsEmpty
              filtered={filtered}
              onClearFilters={clearFilters}
              onStartChat={onStartChat}
            />
          ) : (
            <>
              <motion.ul
                aria-label="Files"
                aria-busy={refreshing || undefined}
                className="space-y-2"
                initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: refreshing ? 0.6 : 1, y: 0 }}
                transition={{ duration: 0.2, ease: "easeOut" }}
              >
                {files.items.map((file) => (
                  <ArtifactRow
                    key={file.attachmentId}
                    file={file}
                    previewBusy={actions.loadingImageId === file.attachmentId}
                    onPreview={actions.openPreview}
                    onDownload={actions.download}
                    onOpenConversation={onOpenConversation}
                    onOpenCanvas={onOpenCanvas}
                  />
                ))}
              </motion.ul>
              {files.error ? (
                <p role="alert" className="text-center text-sm text-destructive">
                  {files.error}
                </p>
              ) : null}
              {files.hasMore ? (
                <div ref={loadMoreRef} className="flex justify-center pt-2">
                  <button
                    type="button"
                    onClick={files.loadMore}
                    disabled={files.loadingMore}
                    className="inline-flex h-10 items-center gap-2 rounded-full border border-border/60 bg-background/60 px-4 text-sm font-medium text-foreground transition-[background-color,transform] hover:bg-[hsl(var(--hover-surface))] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:opacity-60"
                  >
                    {files.loadingMore ? (
                      <LoaderCircle size={15} aria-hidden className="animate-spin" />
                    ) : null}
                    {files.loadingMore ? "Loading…" : "Load more"}
                  </button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>

      {/* The chat's own preview surfaces, pointed at the file's conversation. */}
      <AttachmentPreviewPanel
        preview={actions.filePreview}
        userId={userId}
        conversationId={actions.previewFile?.conversationId ?? null}
        onClose={actions.closePreview}
        onDownload={() => {
          if (actions.previewFile) actions.download(actions.previewFile);
        }}
      />
      <ImageLightbox
        src={actions.imageSrc}
        filename={actions.imageName}
        onClose={actions.closeImage}
      />
    </div>
  );
}

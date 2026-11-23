import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { LoaderCircle } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { ImageLightbox } from "@/shared/ui/ImageLightbox";
import { SidebarTrigger } from "@/shared/ui/sidebar";
import AttachmentPreviewPanel from "@/features/attachments/components/AttachmentPreviewPanel";
import { ArtifactList } from "@/features/artifacts/components/artifacts_parts/ArtifactList";
import {
  ArtifactsEmpty,
  ArtifactsError,
  ArtifactsSkeleton,
} from "@/features/artifacts/components/artifacts_parts/ArtifactsStates";
import { ArtifactsToolbar } from "@/features/artifacts/components/artifacts_parts/ArtifactsToolbar";
import { FileStackArt } from "@/features/artifacts/components/artifacts_parts/FileStackArt";
import { useArtifactActions } from "@/features/artifacts/hooks/useArtifactActions";
import { useArtifactsView } from "@/features/artifacts/hooks/useArtifactsView";
import { useDebouncedValue } from "@/features/artifacts/hooks/useDebouncedValue";
import { useLoadMoreSentinel } from "@/features/artifacts/hooks/useLoadMoreSentinel";
import { useUserFiles } from "@/features/artifacts/hooks/useUserFiles";
import {
  SEARCH_DEBOUNCE_MS,
  type KindFilter,
  type TypeFilter,
} from "@/features/artifacts/lib/fileFilters";

const EASE = [0.22, 1, 0.36, 1] as const;

/**
 * The toolbar's sticky frame: pinned to the top of the page's scroll box,
 * frosted, and given an edge and a shadow only once it is actually stuck (a
 * sentinel just above it leaves the viewport), so at rest it sits flat in the
 * page. Its own component, so the stuck flag re-renders the bar alone, never
 * the list.
 */
function StickyBar({ children }: { children: ReactNode }) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setStuck(!entry.isIntersecting), {
      root: sentinel.closest("[data-artifacts-scroll]"),
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <div ref={sentinelRef} aria-hidden className="h-px" />
      <div
        className={cn(
          "sticky top-0 z-20 -mx-4 px-4 pb-3 pt-3 transition-[background-color,box-shadow,border-color] duration-200 sm:-mx-6 sm:px-6",
          "border-b",
          stuck
            ? "border-border/60 bg-background/80 shadow-[0_12px_30px_-24px_hsl(var(--foreground)/0.5)] backdrop-blur-xl"
            : "border-transparent bg-transparent",
        )}
      >
        <div className="mx-auto w-full max-w-6xl">{children}</div>
      </div>
    </>
  );
}

/**
 * The Artifacts page (plan 44): every file of the user's in one place —
 * what they attached (Inputs) and what agents made and presented for them
 * (Outputs), across all their conversations, newest first, under date headings.
 *
 * A gallery of finished work rather than a file table: a heading with its
 * illustration, a pinned toolbar (search, kind, type, Grid / List), then the
 * files as cards (a cover drawn for the file's family, the title and summary
 * the agent gave it) or as dense rows.
 *
 * Filters (kind, type) and the search run on the bridge, so they cover every
 * file, not just the pages loaded so far; scrolling near the end (or "Load
 * more") follows its cursor. Each file previews with the chat's own preview
 * surfaces, downloads, or opens the conversation it belongs to.
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
  const [view, setView] = useArtifactsView();
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
  // No files at all: the empty state carries the illustration, so the
  // heading drops its copy rather than show the same art twice.
  const emptyLibrary = files.loaded && !files.loading && files.items.length === 0 && !filtered;
  // A filter change keeps the previous files on screen (dimmed) until the new
  // page lands, instead of flashing the skeleton on every keystroke.
  const refreshing = files.loading && files.loaded;

  const rise = (delay: number) =>
    reduceMotion
      ? {}
      : {
          initial: { opacity: 0, y: 12 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.5, ease: EASE, delay },
        };

  return (
    <div className="relative flex h-full flex-col">
      {/* The list's scroll box: ArtifactList virtualizes its entries against it. */}
      <div
        data-artifacts-scroll
        className="scrollbar-muted relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 sm:px-6"
      >
        {/* A soft wash of the brand colour behind the heading; static, so it costs nothing per frame. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-80 bg-[radial-gradient(60%_100%_at_30%_0%,hsl(var(--primary)/0.13),transparent_70%)]"
        />

        <header className="relative mx-auto flex w-full max-w-6xl items-center gap-6 pb-4 pt-5 max-md:flex-col max-md:items-start max-md:gap-3 sm:pt-10">
          {/* On mobile the sidebar is an overlay sheet and this page covers the
              chat header's own trigger — the same md:hidden toggle Automations
              and Agents carry, so there is always a way back to the sidebar. */}
          <SidebarTrigger
            aria-label="Toggle sidebar"
            className="inline-flex h-10 w-10 flex-shrink-0 self-start rounded-xl bg-transparent text-foreground transition-colors hover:bg-[hsl(var(--hover-surface))] hover:text-foreground active:bg-[hsl(var(--hover-surface-strong))] focus-visible:ring-2 focus-visible:ring-ring md:hidden [&_svg]:size-5"
          />
          <div className="min-w-0 flex-1">
            <motion.p
              {...rise(0)}
              className="text-xs font-semibold uppercase tracking-[0.18em] text-primary"
            >
              Your library
            </motion.p>
            <motion.h1
              {...rise(0.05)}
              className="mt-2 text-3xl font-semibold tracking-tight text-foreground sm:text-[2.6rem] sm:leading-[1.1]"
            >
              Artifacts
            </motion.h1>
            <motion.p
              {...rise(0.1)}
              className="mt-2.5 max-w-xl text-[15px] leading-relaxed text-muted-foreground"
            >
              Every file you attached and every file your agents made, across your conversations — in one place, ready to open.
            </motion.p>
          </div>
          {emptyLibrary ? null : <FileStackArt className="hidden flex-shrink-0 md:block" />}
        </header>

        <StickyBar>
          <ArtifactsToolbar
            query={query}
            onQueryChange={setQuery}
            kind={kind}
            onKindChange={setKind}
            type={type}
            onTypeChange={setType}
            view={view}
            onViewChange={setView}
          />
        </StickyBar>

        <div className="relative mx-auto w-full max-w-6xl pb-12">
          {files.error && files.items.length === 0 ? (
            <div className="pt-3">
              <ArtifactsError message={files.error} onRetry={files.reload} />
            </div>
          ) : showSkeleton ? (
            <ArtifactsSkeleton view={view} />
          ) : files.loaded && files.items.length === 0 && !files.loading ? (
            <div className="pt-3">
              <ArtifactsEmpty filtered={filtered} onClearFilters={clearFilters} onStartChat={onStartChat} />
            </div>
          ) : (
            <>
              {/* Keyed by layout: switching Grid / List is a new list whose files
                  rise in. A filter's new files rise in anyway, as they mount. */}
              <ArtifactList
                key={view}
                items={files.items}
                view={view}
                refreshing={refreshing}
                loadingImageId={actions.loadingImageId}
                onPreview={actions.openPreview}
                onDownload={actions.download}
                onOpenConversation={onOpenConversation}
                onOpenCanvas={onOpenCanvas}
              />
              {files.error ? (
                <p role="alert" className="pt-4 text-center text-sm text-destructive">
                  {files.error}
                </p>
              ) : null}
              {files.hasMore ? (
                <div ref={loadMoreRef} className="flex justify-center pt-6">
                  <button
                    type="button"
                    onClick={files.loadMore}
                    disabled={files.loadingMore}
                    className="inline-flex h-11 items-center gap-2 rounded-full border border-border/60 bg-card/70 px-5 text-sm font-medium text-foreground transition-[background-color,transform] hover:bg-[hsl(var(--hover-surface))] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:opacity-60"
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

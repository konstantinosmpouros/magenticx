/**
 * The canvas body when there is no document to show yet, or none at all:
 * the loading skeleton (the shape of a title, a byline and paragraphs), a
 * failed load with Retry, and a document that is gone (404: deleted, or the
 * conversation is not the user's) with the file's own preview as the way on.
 * Plus the banners over a document: reading an earlier version, a newer
 * version that arrived while the user had unsaved edits, and suggestions
 * that no longer fit the document (Phase 4.6).
 */
import type { ReactNode } from "react";
import { FileQuestion, RotateCw, Sparkles, TriangleAlert } from "lucide-react";
import { PiWarningCircle } from "react-icons/pi";

import { Button } from "@/shared/ui/button";
import { Skeleton } from "@/shared/ui/skeleton";

export function CanvasSkeleton() {
  return (
    <div
      className="mx-auto w-full max-w-[680px] space-y-4 px-6 pt-16 sm:px-10"
      aria-busy="true"
      aria-label="Loading the document"
    >
      <Skeleton className="h-9 w-3/4" />
      <div className="flex gap-2 pb-4">
        <Skeleton className="h-7 w-28" />
        <Skeleton className="h-7 w-20" />
        <Skeleton className="h-7 w-14" />
      </div>
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-11/12" />
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="mt-6 h-6 w-1/2" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
    </div>
  );
}

function CanvasMessage({
  icon,
  title,
  body,
  children,
  alert = false,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  children: ReactNode;
  alert?: boolean;
}) {
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-16">
      <div
        role={alert ? "alert" : "status"}
        className="flex max-w-sm flex-col items-center text-center"
      >
        <span className="mb-4 grid size-12 place-items-center rounded-2xl bg-muted text-muted-foreground">
          {icon}
        </span>
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{body}</p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">{children}</div>
      </div>
    </div>
  );
}

export function CanvasError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <CanvasMessage
      alert
      icon={<TriangleAlert className="size-6" aria-hidden="true" />}
      title="The document didn't load"
      body={message}
    >
      <Button variant="outline" size="sm" onClick={onRetry} className="gap-1.5">
        <RotateCw className="size-4" aria-hidden="true" />
        Retry
      </Button>
    </CanvasMessage>
  );
}

export function CanvasGone({
  onPreviewFile,
  onClose,
}: {
  /** Opens the file in the normal preview, when the conversation still has it. */
  onPreviewFile: (() => void) | null;
  onClose: () => void;
}) {
  return (
    <CanvasMessage
      icon={<FileQuestion className="size-6" aria-hidden="true" />}
      title="This document is no longer available"
      body={
        onPreviewFile
          ? "It has no versions to open in the canvas. The file the agent made can still be previewed."
          : "It may have been removed from this conversation."
      }
    >
      {onPreviewFile ? (
        <Button size="sm" onClick={onPreviewFile}>
          Preview the file
        </Button>
      ) : null}
      <Button variant="outline" size="sm" onClick={onClose}>
        Close
      </Button>
    </CanvasMessage>
  );
}

export function CanvasVersionBanner({
  version,
  onShowLatest,
}: {
  version: number;
  onShowLatest: () => void;
}) {
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-2 border-b border-border/70 bg-muted/60 px-4 py-2 text-[13px] text-muted-foreground"
    >
      <span className="min-w-0 flex-1 truncate">Reading version {version}, an earlier one.</span>
      <Button
        variant="ghost"
        size="sm"
        onClick={onShowLatest}
        className="h-8 shrink-0 px-2 text-[13px] text-foreground [@media(pointer:coarse)]:h-10"
      >
        Show the latest
      </Button>
    </div>
  );
}

export function CanvasIncomingBanner({
  version,
  byAgent,
  onReview,
}: {
  version: number;
  /** Whether the agent wrote it (else another tab of yours). */
  byAgent: boolean;
  onReview: () => void;
}) {
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-2 border-b border-primary/25 bg-primary/8 px-4 py-2 text-[13px] text-foreground"
    >
      <Sparkles className="size-4 shrink-0 text-primary" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">
        {byAgent ? "The agent" : "You (in another tab)"} saved v{version}. Your edits are kept.
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={onReview}
        className="h-8 shrink-0 px-2 text-[13px] font-medium text-primary hover:text-primary [@media(pointer:coarse)]:h-10"
      >
        Review
      </Button>
    </div>
  );
}

/**
 * Suggestions that no longer fit (plan 44, Phase 4.6): the document changed
 * since they were made (the agent edited the same lines), so they show
 * read-only over the version they were made on. Discard deletes them; the
 * user re-applies what they still want by hand.
 */
export function CanvasStaleSuggestionsBanner({
  version,
  onDiscard,
}: {
  /** The version the suggestions were made on. */
  version: number;
  onDiscard: () => void;
}) {
  return (
    <div
      role="status"
      className="flex shrink-0 items-start gap-2 border-b border-warning/30 bg-warning/10 px-4 py-2 text-[13px] text-foreground sm:items-center"
    >
      <PiWarningCircle className="mt-0.5 size-4 shrink-0 text-warning sm:mt-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        The document changed since your suggestions on v{version}. Discard them, or re-apply by
        hand.
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={onDiscard}
        className="h-8 shrink-0 px-2 text-[13px] font-medium text-destructive hover:text-destructive [@media(pointer:coarse)]:h-11"
      >
        Discard
      </Button>
    </div>
  );
}

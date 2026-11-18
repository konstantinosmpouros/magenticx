/**
 * The canvas body when there is no document to show yet, or none at all:
 * the loading skeleton (the shape of a title, a byline and paragraphs), a
 * failed load with Retry, and a document that is gone (404: deleted, or the
 * conversation is not the user's) with the file's own preview as the way on.
 */
import type { ReactNode } from "react";
import { FileQuestion, RotateCw, TriangleAlert } from "lucide-react";

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

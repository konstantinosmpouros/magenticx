/**
 * Where the open document's edits stand, in the canvas header (plan 44,
 * Phase 4.2): Saved, Saving…, Unsaved changes, Save failed with Retry, or
 * the conflict waiting in its dialog — always an icon and a word, never a
 * colour alone — and the Save button (also Ctrl/Cmd+S). On a phone the word
 * is left to screen readers so the header keeps its buttons.
 */
import {
  AlertTriangle,
  Check,
  CircleDot,
  GitCompareArrows,
  Loader2,
  RotateCw,
  Save,
} from "lucide-react";

import type { CanvasSaveStatus as Status } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";

const LABEL: Record<Status, string> = {
  saved: "Saved",
  unsaved: "Unsaved changes",
  saving: "Saving…",
  failed: "Save failed",
  conflict: "Newer version",
};

export function CanvasSaveStatus({
  status,
  errorMessage,
  compact,
  saveShortcut,
  onSave,
  onRetry,
  onResolveConflict,
}: {
  status: Status;
  errorMessage: string | null;
  compact: boolean;
  /** "Ctrl+S" or "⌘S", for the Save button's hint. */
  saveShortcut: string;
  onSave: () => void;
  onRetry: () => void;
  onResolveConflict: () => void;
}) {
  const Icon =
    status === "saved"
      ? Check
      : status === "saving"
        ? Loader2
        : status === "unsaved"
          ? CircleDot
          : status === "conflict"
            ? GitCompareArrows
            : AlertTriangle;

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <span
        role="status"
        aria-live="polite"
        title={status === "failed" && errorMessage ? errorMessage : undefined}
        className={cn(
          "flex h-8 items-center gap-1.5 rounded-md px-1.5 text-[13px]",
          status === "saved" && "text-muted-foreground",
          status === "saving" && "text-muted-foreground",
          status === "unsaved" && "text-foreground/80",
          (status === "failed" || status === "conflict") && "font-medium text-destructive",
        )}
      >
        <Icon
          className={cn(
            "size-4 shrink-0",
            status === "saving" && "animate-spin motion-reduce:animate-none",
            status === "unsaved" && "text-warning",
          )}
          aria-hidden="true"
        />
        <span className={cn(compact && "sr-only")}>{LABEL[status]}</span>
      </span>

      {status === "failed" ? (
        <button
          type="button"
          onClick={onRetry}
          className="flex h-8 items-center gap-1 rounded-md px-2 text-[13px] font-medium text-foreground transition-colors duration-150 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-11"
        >
          <RotateCw className="size-3.5" aria-hidden="true" />
          Retry
        </button>
      ) : status === "conflict" ? (
        <button
          type="button"
          onClick={onResolveConflict}
          className="flex h-8 items-center rounded-md px-2 text-[13px] font-medium text-foreground transition-colors duration-150 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-11"
        >
          Resolve
        </button>
      ) : status === "unsaved" ? (
        // Only when there is something to save: saving is the user's call.
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={`Save (${saveShortcut})`}
              onClick={onSave}
              className="ml-1 flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background animate-in fade-in-0 zoom-in-95 duration-150 motion-reduce:animate-none [@media(pointer:coarse)]:h-11"
            >
              <Save className="size-4" aria-hidden="true" />
              Save
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            Save as a new version{" "}
            <kbd className="ml-1 font-sans text-muted-foreground">{saveShortcut}</kbd>
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}

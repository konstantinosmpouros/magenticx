/**
 * A file's actions on the Artifacts page, in the two shapes a card and a row
 * need: the dock of icon buttons a pointer reaches (Open in canvas, Preview,
 * Download), and the ⋯ menu a finger reaches (the same, plus Open
 * conversation). Which one shows is the device's, not the width's: the dock
 * needs a hover to appear on a card, so a touch screen of any size gets the
 * menu (`@media (hover: none)`).
 *
 * "Open conversation" is not in the dock: the card and the row already carry
 * the conversation as a link, the dock would only repeat it.
 */
import { memo, useState, type ReactNode } from "react";
import { Download, Eye, LoaderCircle, MessageSquareText, MoreHorizontal, PanelRight } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import type { UserFile } from "@/shared/lib/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { useTouchMenuTrigger } from "@/shared/hooks/useTouchMenuTrigger";

export type ArtifactHandlers = {
  onPreview: (file: UserFile) => void;
  onDownload: (file: UserFile) => void;
  onOpenConversation: (conversationId: string) => void;
  onOpenCanvas: (conversationId: string, path: string) => void;
};

function DockButton({
  label,
  onClick,
  busy = false,
  children,
}: {
  label: string;
  onClick: () => void;
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          aria-busy={busy || undefined}
          disabled={busy}
          className="grid h-10 w-10 place-items-center rounded-[0.65rem] text-muted-foreground transition-[background-color,color,transform] duration-150 hover:bg-[hsl(var(--hover-surface))] hover:text-foreground active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:opacity-60"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The pointer's actions. `overlay` floats on a card's cover and slides in on
 * the card's hover or keyboard focus; `inline` sits at the end of a row.
 */
export const ArtifactActionDock = memo(function ArtifactActionDock({
  file,
  canvasPath,
  previewBusy,
  variant,
  onPreview,
  onDownload,
  onOpenCanvas,
}: Pick<ArtifactHandlers, "onPreview" | "onDownload" | "onOpenCanvas"> & {
  file: UserFile;
  canvasPath: string | null;
  previewBusy: boolean;
  variant: "overlay" | "inline";
}) {
  return (
    <div
      className={cn(
        "z-10 flex items-center [@media(hover:none)]:hidden",
        variant === "inline" && "relative",
        variant === "overlay" &&
          "absolute right-2.5 top-2.5 gap-0.5 rounded-xl bg-background/85 p-0.5 shadow-[0_8px_24px_-12px_hsl(var(--foreground)/0.4)] ring-1 ring-border/60 backdrop-blur-md " +
            "translate-y-[-4px] opacity-0 transition-[opacity,transform] duration-200 ease-out group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100 motion-reduce:transition-none",
      )}
    >
      {canvasPath ? (
        <DockButton
          label={`Open ${file.fileName} in canvas`}
          onClick={() => onOpenCanvas(file.conversationId, canvasPath)}
        >
          <PanelRight size={17} aria-hidden />
        </DockButton>
      ) : null}
      <DockButton label={`Preview ${file.fileName}`} onClick={() => onPreview(file)} busy={previewBusy}>
        {previewBusy ? (
          <LoaderCircle size={17} aria-hidden className="animate-spin" />
        ) : (
          <Eye size={17} aria-hidden />
        )}
      </DockButton>
      <DockButton label={`Download ${file.fileName}`} onClick={() => onDownload(file)}>
        <Download size={17} aria-hidden />
      </DockButton>
    </div>
  );
});

/** The finger's actions: every action in one menu, opened on the tap's click (useTouchMenuTrigger). */
export const ArtifactActionMenu = memo(function ArtifactActionMenu({
  file,
  canvasPath,
  previewBusy,
  className,
  onPreview,
  onDownload,
  onOpenConversation,
  onOpenCanvas,
}: ArtifactHandlers & {
  file: UserFile;
  canvasPath: string | null;
  previewBusy: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const touchMenuTrigger = useTouchMenuTrigger();

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild {...touchMenuTrigger(() => setOpen((v) => !v))}>
        <button
          type="button"
          aria-label={`Actions for ${file.fileName}`}
          className={cn(
            "relative z-10 grid h-11 w-11 flex-shrink-0 place-items-center rounded-xl text-muted-foreground transition-colors hover:bg-[hsl(var(--hover-surface))] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 data-[state=open]:bg-[hsl(var(--hover-surface))] [@media(hover:hover)]:hidden",
            className,
          )}
        >
          {previewBusy ? (
            <LoaderCircle size={18} aria-hidden className="animate-spin" />
          ) : (
            <MoreHorizontal size={18} aria-hidden />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[13rem]">
        {canvasPath ? (
          <DropdownMenuItem
            className="min-h-11 gap-2.5"
            onSelect={() => onOpenCanvas(file.conversationId, canvasPath)}
          >
            <PanelRight size={16} aria-hidden /> Open in canvas
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem className="min-h-11 gap-2.5" disabled={previewBusy} onSelect={() => onPreview(file)}>
          <Eye size={16} aria-hidden /> Preview
        </DropdownMenuItem>
        <DropdownMenuItem className="min-h-11 gap-2.5" onSelect={() => onDownload(file)}>
          <Download size={16} aria-hidden /> Download
        </DropdownMenuItem>
        <DropdownMenuItem className="min-h-11 gap-2.5" onSelect={() => onOpenConversation(file.conversationId)}>
          <MessageSquareText size={16} aria-hidden /> Open conversation
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

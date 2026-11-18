import type { ReactNode } from "react";
import { Download, Eye, LoaderCircle, MessageSquareText } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import type { UserFile } from "@/shared/lib/types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { formatBytes } from "@/features/attachments/components/attachment_preview_parts";
import { FILE_TYPE_META, fileExtension, fileIcon, formatFileDate } from "@/features/artifacts/lib/fileFilters";

function RowAction({
  label,
  onClick,
  children,
  busy = false,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  busy?: boolean;
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
          className="grid h-10 w-10 place-items-center rounded-xl text-muted-foreground transition-colors hover:bg-[hsl(var(--hover-surface))] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:opacity-60"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * One file on the Artifacts page: its type tile, name, where it came from
 * (Input / Output and the conversation), when, and how big — then Preview,
 * Download and Open conversation. The name is itself the Preview button, the
 * biggest target on the row.
 *
 * On a phone the meta line wraps under the name and the three actions stay a
 * fixed 40px strip on the right, so a long file name truncates rather than
 * pushing them off screen.
 */
export function ArtifactRow({
  file,
  previewBusy,
  onPreview,
  onDownload,
  onOpenConversation,
}: {
  file: UserFile;
  previewBusy: boolean;
  onPreview: (file: UserFile) => void;
  onDownload: (file: UserFile) => void;
  onOpenConversation: (conversationId: string) => void;
}) {
  const meta = FILE_TYPE_META[file.type];
  const Icon = fileIcon(file.type, file.fileName);
  const extension = fileExtension(file.fileName);
  const date = formatFileDate(file.createdAt);
  const size = formatBytes(file.size ?? undefined);
  const conversation = file.conversationTitle || "Untitled conversation";
  const output = file.kind === "output";

  return (
    <li
      data-testid="artifact-row"
      className="group flex items-center gap-3 rounded-2xl border border-border/60 bg-card px-3 py-2.5 transition-colors hover:border-primary/30 sm:px-4"
    >
      <span
        className={cn(
          "grid h-10 w-10 flex-shrink-0 place-items-center rounded-xl ring-1",
          output
            ? "bg-primary/[0.08] text-primary ring-primary/10"
            : "bg-muted/50 text-muted-foreground ring-border/50",
        )}
        title={meta.label}
      >
        <Icon size={18} aria-hidden />
        <span className="sr-only">{meta.label}</span>
      </span>

      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => onPreview(file)}
          className="block max-w-full truncate rounded text-left text-sm font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          {file.fileName}
        </button>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
          <span
            className={cn(
              "rounded-full px-1.5 py-px text-[10px] font-medium",
              output ? "bg-primary/10 text-primary" : "bg-muted/70 text-muted-foreground",
            )}
          >
            {output ? "Output" : "Input"}
          </span>
          {extension ? (
            <span className="rounded-md bg-muted/70 px-1 py-px font-mono text-[10px] font-medium tracking-wide text-muted-foreground">
              {extension}
            </span>
          ) : null}
          <span className="min-w-0 max-w-[16rem] truncate" title={conversation}>
            {conversation}
          </span>
          {date ? (
            <>
              <span aria-hidden>·</span>
              <time dateTime={file.createdAt}>{date}</time>
            </>
          ) : null}
          {size ? (
            <>
              <span aria-hidden>·</span>
              <span className="tabular-nums">{size}</span>
            </>
          ) : null}
        </p>
      </div>

      <div className="flex flex-shrink-0 items-center">
        <RowAction label={`Preview ${file.fileName}`} onClick={() => onPreview(file)} busy={previewBusy}>
          {previewBusy ? (
            <LoaderCircle size={17} aria-hidden className="animate-spin" />
          ) : (
            <Eye size={17} aria-hidden />
          )}
        </RowAction>
        <RowAction label={`Download ${file.fileName}`} onClick={() => onDownload(file)}>
          <Download size={17} aria-hidden />
        </RowAction>
        <RowAction
          label={`Open conversation ${conversation}`}
          onClick={() => onOpenConversation(file.conversationId)}
        >
          <MessageSquareText size={17} aria-hidden />
        </RowAction>
      </div>
    </li>
  );
}

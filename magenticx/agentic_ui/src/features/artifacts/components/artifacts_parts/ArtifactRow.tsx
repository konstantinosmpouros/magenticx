import {
  forwardRef,
  memo,
  useState,
  type ForwardedRef,
  type ReactNode,
} from "react";
import {
  Download,
  Eye,
  LoaderCircle,
  MessageSquareText,
  MoreHorizontal,
  PanelRight,
} from "lucide-react";

import { canvasDocumentPath } from "@/shared/lib/canvasDocuments";
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
import { formatBytes } from "@/features/attachments/components/attachment_preview_parts/registry";
import {
  FILE_TYPE_META,
  fileExtension,
  fileIcon,
  formatFileDate,
} from "@/features/artifacts/lib/fileFilters";

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
 * biggest target on the row — except for a canvas document (a generated
 * `.md`, plan 44), whose name opens it in the canvas of its conversation,
 * with an Open in canvas action first.
 *
 * On a phone the name gets the row's width: the actions fold into one ⋯
 * menu (four 40px icons left ~90px for the name), and the meta line puts
 * the conversation on a line of its own under "Output · MD · date · size",
 * so no line starts with a stray separator.
 *
 * Memoized, and placed by its list (`index`, `offset`, the ref): the page's
 * list is virtualized (plan 45), so a scroll re-renders the list but not the
 * rows whose file did not change.
 */
function ArtifactRowImpl(
  {
    file,
    previewBusy,
    onPreview,
    onDownload,
    onOpenConversation,
    onOpenCanvas,
    index,
    offset,
  }: {
    file: UserFile;
    previewBusy: boolean;
    onPreview: (file: UserFile) => void;
    onDownload: (file: UserFile) => void;
    onOpenConversation: (conversationId: string) => void;
    onOpenCanvas: (conversationId: string, path: string) => void;
    /** Its place in the list (`data-index`, read by the virtualizer). */
    index?: number;
    /** Its offset in the virtualized list (px): the row is then placed absolutely there. */
    offset?: number;
  },
  ref: ForwardedRef<HTMLLIElement>,
) {
  const meta = FILE_TYPE_META[file.type];
  const Icon = fileIcon(file.type, file.fileName);
  const extension = fileExtension(file.fileName);
  const date = formatFileDate(file.createdAt);
  const size = formatBytes(file.size ?? undefined);
  const conversation = file.conversationTitle || "Untitled conversation";
  const output = file.kind === "output";
  const canvasPath = output ? canvasDocumentPath(file) : null;
  const open = () => (canvasPath ? onOpenCanvas(file.conversationId, canvasPath) : onPreview(file));
  const [menuOpen, setMenuOpen] = useState(false);
  const touchMenuTrigger = useTouchMenuTrigger();

  return (
    <li
      ref={ref}
      data-index={index}
      style={
        offset === undefined
          ? undefined
          : {
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${offset}px)`,
            }
      }
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
          onClick={open}
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
          <span
            className="min-w-0 max-w-full truncate max-sm:order-last max-sm:basis-full sm:max-w-[16rem]"
            title={conversation}
          >
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

      <div className="hidden flex-shrink-0 items-center sm:flex">
        {canvasPath ? (
          <RowAction label={`Open ${file.fileName} in canvas`} onClick={open}>
            <PanelRight size={17} aria-hidden />
          </RowAction>
        ) : null}
        <RowAction
          label={`Preview ${file.fileName}`}
          onClick={() => onPreview(file)}
          busy={previewBusy}
        >
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

      {/* Phone: the same actions in one menu. Modal, opened on the tap's
          click (useTouchMenuTrigger explains why). */}
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild {...touchMenuTrigger(() => setMenuOpen((v) => !v))}>
          <button
            type="button"
            aria-label={`Actions for ${file.fileName}`}
            className="grid h-11 w-11 flex-shrink-0 place-items-center rounded-xl text-muted-foreground transition-colors hover:bg-[hsl(var(--hover-surface))] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 data-[state=open]:bg-[hsl(var(--hover-surface))] sm:hidden"
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
            <DropdownMenuItem className="min-h-11 gap-2.5" onSelect={open}>
              <PanelRight size={16} aria-hidden /> Open in canvas
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            className="min-h-11 gap-2.5"
            disabled={previewBusy}
            onSelect={() => onPreview(file)}
          >
            <Eye size={16} aria-hidden /> Preview
          </DropdownMenuItem>
          <DropdownMenuItem className="min-h-11 gap-2.5" onSelect={() => onDownload(file)}>
            <Download size={16} aria-hidden /> Download
          </DropdownMenuItem>
          <DropdownMenuItem
            className="min-h-11 gap-2.5"
            onSelect={() => onOpenConversation(file.conversationId)}
          >
            <MessageSquareText size={16} aria-hidden /> Open conversation
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

export const ArtifactRow = memo(forwardRef(ArtifactRowImpl));

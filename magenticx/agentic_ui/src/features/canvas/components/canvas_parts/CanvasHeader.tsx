/**
 * The canvas panel's header: the document title (a menu of the
 * conversation's documents), the save status while editing (Phase 4.2),
 * then find, history, full screen (not on a phone, where the canvas is
 * always full screen) and close. Minimal chrome: no formatting
 * here, the document owns the panel. On a phone it starts with the outline
 * toggle, which the document row keeps on wider screens.
 */
import {
  Check,
  ChevronDown,
  FileSearch,
  FileText,
  History,
  Maximize2,
  Minimize2,
  PanelLeft,
  X,
} from "lucide-react";

import type { ReactNode } from "react";

import type { CanvasDocumentSummary } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";

import { CanvasHint } from "./CanvasHint";
import { documentTitle } from "../../lib/documentTitle";

const iconButton =
  "flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 [@media(pointer:coarse)]:size-11 [&_svg]:size-[18px]";

export function CanvasHeader({
  title,
  documents,
  activePath,
  showOutlineToggle,
  showFullscreenToggle,
  fullscreen,
  findOpen,
  canFind,
  historyOpen,
  status,
  onSelectDocument,
  onToggleOutline,
  onToggleFind,
  onToggleHistory,
  onToggleFullscreen,
  onClose,
}: {
  /** The open document's title (shown before the list has loaded). */
  title: string;
  /** The conversation's documents, newest first; empty while loading. */
  documents: CanvasDocumentSummary[];
  activePath: string;
  /** Phone layout: the outline toggle comes first, here. */
  showOutlineToggle: boolean;
  /** Not when the canvas already covers the chat (a phone, a narrow window). */
  showFullscreenToggle: boolean;
  fullscreen: boolean;
  findOpen: boolean;
  /** Find and the outline need a loaded document. */
  canFind: boolean;
  historyOpen: boolean;
  /** The save status and Save button, while the latest version is being edited. */
  status: ReactNode;
  onSelectDocument: (path: string) => void;
  onToggleOutline: () => void;
  onToggleFind: () => void;
  onToggleHistory: () => void;
  onToggleFullscreen: () => void;
  onClose: () => void;
}) {
  // Docked beside the chat, the dock sets --canvas-header-h to the chat
  // header's measured height, so the two bottom lines meet across the split.
  return (
    <header className="flex h-14 shrink-0 items-center gap-1 border-b border-border/70 px-2 sm:px-3 md:h-[var(--canvas-header-h,4rem)]">
      {showOutlineToggle ? (
        <CanvasHint label="Outline">
          <button
            type="button"
            className={iconButton}
            aria-label="Outline"
            disabled={!canFind}
            onClick={onToggleOutline}
          >
            <PanelLeft />
          </button>
        </CanvasHint>
      ) : null}

      <DropdownMenu>
        <CanvasHint label="Switch document">
          <DropdownMenuTrigger
            className="group flex min-w-0 items-center gap-1 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-11"
            aria-label={`Document: ${title}. Switch document`}
          >
            <span className="truncate text-[15px] font-semibold text-foreground">{title}</span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
          </DropdownMenuTrigger>
        </CanvasHint>
        <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-y-auto">
          <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
            Documents in this conversation
          </DropdownMenuLabel>
          {documents.length === 0 ? (
            <DropdownMenuItem disabled className="gap-2">
              <FileText className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{title}</span>
            </DropdownMenuItem>
          ) : (
            documents.map((doc) => (
              <DropdownMenuItem
                key={doc.path}
                onSelect={() => onSelectDocument(doc.path)}
                className="gap-2"
              >
                <FileText className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{documentTitle(doc.name)}</span>
                {doc.path === activePath ? (
                  <Check className="size-4 shrink-0 text-primary" aria-label="Open" />
                ) : null}
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        {status}
        <CanvasHint label="Find in document">
          <button
            type="button"
            className={cn(iconButton, findOpen && "bg-muted text-foreground")}
            aria-label="Find in document"
            aria-pressed={findOpen}
            disabled={!canFind}
            onClick={onToggleFind}
          >
            <FileSearch />
          </button>
        </CanvasHint>
        <CanvasHint label="Version history">
          <button
            type="button"
            className={cn(iconButton, historyOpen && "bg-muted text-foreground")}
            aria-label="Version history"
            aria-pressed={historyOpen}
            disabled={!canFind}
            onClick={onToggleHistory}
          >
            <History />
          </button>
        </CanvasHint>
        {showFullscreenToggle ? (
          <CanvasHint label={fullscreen ? "Exit full screen" : "Full screen"}>
            <button
              type="button"
              className={iconButton}
              aria-label={fullscreen ? "Exit full screen" : "Full screen"}
              onClick={onToggleFullscreen}
            >
              {fullscreen ? <Minimize2 /> : <Maximize2 />}
            </button>
          </CanvasHint>
        ) : null}
        <CanvasHint label="Close">
          <button
            type="button"
            className={iconButton}
            aria-label="Close document"
            onClick={onClose}
          >
            <X />
          </button>
        </CanvasHint>
      </div>
    </header>
  );
}

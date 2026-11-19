/**
 * Export in the canvas header (plan 44, Phase 4.5): a download button that
 * opens a small panel rather than a bare menu —
 *
 *   Export · the document's title                                    ✕
 *   Version  [ v10 · Latest ▾ ]
 *   W    Word        Editable .docx document                          ⤓
 *   PDF  PDF         Document for printing and sharing                ⤓
 *   M↓   Markdown    Plain-text .md file                              ⤓
 *   ⧉ Copy as Markdown
 *   ● Unsaved changes aren't included            [Save first]
 *
 * The rows follow Claude Docs' export list: a bare ~24px file mark (no tile),
 * a title and one muted line, the ⤓ at the right. The header's trigger is
 * the ⤓ alone.
 *
 * Each row shows a spinner while its file is made (Word and PDF convert in
 * the sandbox) and a check once it has downloaded. Any saved version can be
 * exported; unsaved edits are never part of an export, which the panel says
 * plainly with a Save first, instead of a dialog in the way.
 *
 * Custom: shadcn has no export panel; it is built from our Popover, Select,
 * Button, tokens and lucide icons; the file marks are `FileTypeIcon`.
 */
import { useEffect, useState } from "react";
import { Check, CircleDot, Copy, Download, Loader2, X } from "lucide-react";

import type { CanvasDocumentVersionMeta, CanvasExportFormat } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";
import { Button } from "@/shared/ui/button";
import { FileTypeIcon } from "@/shared/ui/file-type-icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";

import { formatVersionMoment } from "../../lib/dates";
import { CanvasHint } from "./CanvasHint";

const FORMATS: {
  format: CanvasExportFormat;
  label: string;
  hint: string;
}[] = [
  {
    format: "docx",
    label: "Word",
    hint: "Editable .docx document",
  },
  {
    format: "pdf",
    label: "PDF",
    hint: "Document for printing and sharing",
  },
  {
    format: "md",
    label: "Markdown",
    hint: "Plain-text .md file",
  },
];

/** How long a finished row keeps its check. */
const DONE_MS = 2200;

export interface CanvasExportPanelProps {
  title: string;
  /** No document loaded yet. */
  disabled: boolean;
  /** The saved version an export takes by default (the one shown). */
  defaultVersion: number | null;
  latestVersion: number | null;
  versions: CanvasDocumentVersionMeta[] | null;
  versionsLoading: boolean;
  onLoadVersions: () => void;
  /** The format being made now, if any. */
  pending: CanvasExportFormat | null;
  /** The open document has edits that are not saved (they are not exported). */
  unsaved: boolean;
  onSaveFirst: () => Promise<void>;
  /** Resolves true once the file has been handed to the browser. */
  onExport: (format: CanvasExportFormat, version: number | null) => Promise<boolean>;
  /** Copies that version's markdown; resolves true on success. */
  onCopyMarkdown: (version: number | null) => Promise<boolean>;
}

export function CanvasExportPanel({
  title,
  disabled,
  defaultVersion,
  latestVersion,
  versions,
  versionsLoading,
  onLoadVersions,
  pending,
  unsaved,
  onSaveFirst,
  onExport,
  onCopyMarkdown,
}: CanvasExportPanelProps) {
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState<number | null>(defaultVersion);
  const [done, setDone] = useState<CanvasExportFormat | "copy" | null>(null);
  const [saving, setSaving] = useState(false);

  // Each opening starts from the version on screen.
  useEffect(() => {
    if (open) setVersion(defaultVersion);
  }, [open, defaultVersion]);
  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(() => setDone(null), DONE_MS);
    return () => window.clearTimeout(timer);
  }, [done]);

  const run = async (format: CanvasExportFormat) => {
    if (pending) return;
    if (await onExport(format, version)) setDone(format);
  };
  const copy = async () => {
    if (await onCopyMarkdown(version)) setDone("copy");
  };
  const saveFirst = async () => {
    setSaving(true);
    try {
      await onSaveFirst();
    } finally {
      setSaving(false);
    }
  };

  const isLatest = version === null || version === latestVersion;
  const choices =
    versions && versions.length > 0
      ? versions
      : defaultVersion !== null
        ? [{ version: defaultVersion } as CanvasDocumentVersionMeta]
        : [];

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) onLoadVersions();
        setOpen(next);
      }}
    >
      <CanvasHint label="Export">
        <PopoverTrigger
          aria-label="Export"
          disabled={disabled}
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 data-[state=open]:bg-muted data-[state=open]:text-foreground [@media(pointer:coarse)]:size-11"
        >
          {pending ? (
            <Loader2
              className="size-[18px] animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : (
            <Download className="size-[18px]" aria-hidden="true" />
          )}
        </PopoverTrigger>
      </CanvasHint>

      <PopoverContent
        align="end"
        sideOffset={8}
        collisionPadding={12}
        className="w-[min(23rem,calc(100vw-1.5rem))] overflow-hidden rounded-2xl p-0"
        aria-label="Export the document"
      >
        {/* Head: what is exported, and from which version. */}
        <div className="space-y-3 px-4 pb-3 pt-3.5">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-foreground">Export</p>
              <p className="truncate text-xs text-muted-foreground" title={title}>
                {title}
              </p>
            </div>
            <button
              type="button"
              aria-label="Close"
              onClick={() => setOpen(false)}
              className="-mr-1.5 -mt-0.5 flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:size-11"
            >
              <X className="size-4" />
            </button>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs font-medium text-muted-foreground">Version</span>
            <Select
              value={version === null ? undefined : String(version)}
              onValueChange={(value) => setVersion(Number(value))}
              disabled={choices.length === 0}
            >
              <SelectTrigger
                aria-label="Version to export"
                className="h-8 flex-1 rounded-lg text-[13px] [@media(pointer:coarse)]:h-11"
              >
                <SelectValue placeholder={versionsLoading ? "Loading…" : "Latest"} />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {choices.map((meta) => (
                  <SelectItem key={meta.version} value={String(meta.version)}>
                    <span className="font-medium">v{meta.version}</span>
                    {meta.version === latestVersion ? (
                      <span className="text-muted-foreground"> · Latest</span>
                    ) : null}
                    {meta.author ? (
                      <span className="text-muted-foreground">
                        {" "}
                        · {meta.author === "agent" ? "Agent" : "You"}
                        {meta.createdAt ? `, ${formatVersionMoment(meta.createdAt)}` : ""}
                      </span>
                    ) : null}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* The formats. */}
        <ul className="border-t border-border/60 p-1">
          {FORMATS.map(({ format, label, hint }) => {
            const running = pending === format;
            const finished = done === format;
            return (
              <li key={format}>
                <button
                  type="button"
                  onClick={() => void run(format)}
                  disabled={pending !== null && !running}
                  aria-busy={running || undefined}
                  aria-label={`Download as ${label}`}
                  className="group flex w-full items-center gap-3 rounded-lg px-3 py-1.5 text-left transition-colors duration-150 hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 [@media(pointer:coarse)]:min-h-12"
                >
                  <FileTypeIcon kind={format} />
                  <span className="flex min-w-0 flex-1 flex-col gap-px">
                    <span className="text-[13.5px] font-medium leading-5 text-foreground">
                      {label}
                    </span>
                    <span className="truncate text-xs leading-4 text-muted-foreground">
                      {running ? "Preparing the file…" : finished ? "Downloaded" : hint}
                    </span>
                  </span>
                  <span
                    aria-hidden="true"
                    className={cn(
                      "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 group-hover:text-foreground",
                      finished && "text-success group-hover:text-success",
                    )}
                  >
                    {running ? (
                      <Loader2 className="size-4 animate-spin text-primary motion-reduce:animate-none" />
                    ) : finished ? (
                      <Check className="size-4" />
                    ) : (
                      <Download className="size-4" />
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        {/* A quick copy, no file. */}
        <div className="border-t border-border/60 p-1">
          <button
            type="button"
            onClick={() => void copy()}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[13px] text-foreground transition-colors duration-150 hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-11"
          >
            <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground">
              {done === "copy" ? (
                <Check className="size-4 text-success" aria-hidden="true" />
              ) : (
                <Copy className="size-4" aria-hidden="true" />
              )}
            </span>
            <span className="flex-1 font-medium">
              {done === "copy" ? "Copied to the clipboard" : "Copy as Markdown"}
            </span>
          </button>
        </div>

        {/* What the export does not hold. */}
        {unsaved && isLatest ? (
          <div className="flex items-center gap-2.5 border-t border-border/60 bg-warning/[0.07] px-4 py-2.5">
            <CircleDot className="size-4 shrink-0 text-warning" aria-hidden="true" />
            <p className="min-w-0 flex-1 text-xs text-foreground/80">
              Unsaved changes aren&apos;t included.
            </p>
            <Button
              size="sm"
              variant="outline"
              className="h-7 shrink-0 gap-1.5 rounded-lg px-2.5 text-xs [@media(pointer:coarse)]:h-11"
              disabled={saving}
              onClick={() => void saveFirst()}
            >
              {saving ? (
                <Loader2
                  className="size-3.5 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : null}
              Save first
            </Button>
          </div>
        ) : !isLatest && version !== null ? (
          <div className="border-t border-border/60 bg-muted/40 px-4 py-2.5 text-xs text-muted-foreground">
            Exporting v{version}, an earlier version.
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

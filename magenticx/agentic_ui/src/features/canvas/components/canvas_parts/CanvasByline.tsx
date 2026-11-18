/**
 * The document's byline, a row of chips under its title: the date of the
 * shown version, who wrote it (the agent or you) and the version itself, a
 * menu of every version to read an earlier one. Read-only: picking a version
 * shows it, nothing is restored.
 */
import { useContext } from "react";
import { CalendarDays, Check, ChevronDown, History, Sparkles, UserRound } from "lucide-react";

import type { CanvasDocumentAuthor } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { Skeleton } from "@/shared/ui/skeleton";

import { CanvasBylineContext } from "../../lib/bylineContext";
import { formatVersionDay, formatVersionMoment } from "../../lib/dates";

const chip = "inline-flex h-7 items-center gap-1.5 rounded-md bg-muted px-2 text-[13px]";

function AuthorLabel({ author }: { author: CanvasDocumentAuthor }) {
  const Icon = author === "agent" ? Sparkles : UserRound;
  return (
    <>
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      {author === "agent" ? "Agent" : "You"}
    </>
  );
}

export function CanvasByline({ className }: { className?: string }) {
  const byline = useContext(CanvasBylineContext);
  if (!byline) return null;
  const date = formatVersionDay(byline.createdAt);

  return (
    <div
      contentEditable={false}
      className={cn("flex select-none flex-wrap items-center gap-2", className)}
    >
      {date ? (
        <span className={cn(chip, "text-muted-foreground")}>
          <CalendarDays className="size-3.5" aria-hidden="true" />
          <time dateTime={byline.createdAt}>{date}</time>
        </span>
      ) : null}
      <span
        className={cn(chip, "font-medium text-foreground/80")}
        aria-label={byline.author === "agent" ? "Written by the agent" : "Written by you"}
      >
        <AuthorLabel author={byline.author} />
      </span>
      <DropdownMenu
        onOpenChange={(open) => {
          if (open) byline.onLoadVersions();
        }}
      >
        <DropdownMenuTrigger
          className={cn(
            chip,
            "text-muted-foreground transition-colors duration-150 hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:text-foreground [@media(pointer:coarse)]:h-9",
          )}
          aria-label={`Version ${byline.version}${byline.isLatest ? ", the latest" : ""}. Show versions`}
        >
          <History className="size-3.5" aria-hidden="true" />v{byline.version}
          <ChevronDown className="size-3" aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-y-auto">
          <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
            Versions
          </DropdownMenuLabel>
          {byline.versions === null || byline.versionsLoading ? (
            <div className="space-y-2 px-2 py-1.5" aria-busy="true" aria-label="Loading versions">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ) : (
            byline.versions.map((meta, index) => (
              <DropdownMenuItem
                key={meta.version}
                onSelect={() => byline.onPickVersion(index === 0 ? null : meta.version)}
                className="gap-2"
              >
                <span className="w-8 shrink-0 font-medium tabular-nums text-foreground">
                  v{meta.version}
                </span>
                <span className="flex min-w-0 flex-1 items-center gap-1.5 text-muted-foreground">
                  <AuthorLabel author={meta.author} />
                  <span aria-hidden="true">·</span>
                  <span className="truncate">{formatVersionMoment(meta.createdAt)}</span>
                </span>
                {meta.version === byline.version ? (
                  <Check className="size-4 shrink-0 text-primary" aria-label="Shown" />
                ) : null}
              </DropdownMenuItem>
            ))
          )}
          {!byline.isLatest ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => byline.onPickVersion(null)}>
                Back to the latest version
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

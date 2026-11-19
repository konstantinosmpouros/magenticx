/**
 * The document's byline, a row of chips under its title: the date of the
 * shown version, who wrote it (the agent or you) and the version itself. The
 * version chip is the one way into the version history (the panel beside the
 * document, a sheet on a phone): read an earlier version, compare two,
 * restore one.
 */
import { useContext } from "react";
import { CalendarDays, History, Sparkles, UserRound } from "lucide-react";

import type { CanvasDocumentAuthor } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";

import { CanvasBylineContext } from "../../lib/bylineContext";
import { formatVersionDay } from "../../lib/dates";
import { CanvasHint } from "./CanvasHint";

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
      <CanvasHint label="Version history">
        <button
          type="button"
          onClick={byline.onToggleHistory}
          aria-pressed={byline.historyOpen}
          aria-label={`Version ${byline.version}${byline.isLatest ? ", the latest" : ""}. Version history`}
          className={cn(
            chip,
            "text-muted-foreground transition-colors duration-150 hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-primary/12 aria-pressed:text-primary [@media(pointer:coarse)]:h-9",
          )}
        >
          <History className="size-3.5" aria-hidden="true" />v{byline.version}
        </button>
      </CanvasHint>
    </div>
  );
}

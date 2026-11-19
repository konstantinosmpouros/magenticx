/**
 * The agent's canvas comment steps (plan 44 v2) — `reply_to_comment` and
 * `add_comment` — drawn as what they are: a comment on a passage. The passage
 * as a muted «…» line, the agent's words as a quoted card (clamped, with
 * Show more when long), and only what a reader needs from the result: nothing
 * on the routine success but a way to open the document, the refusal sentence
 * on a `Could not …`. No thread ids, no JSON.
 *
 * The one read, `list_comments`, shows its result as a summary ("3 open
 * threads") that expands to each thread's passage and first comment, parsed
 * from the listing (`parseCommentListing`).
 *
 * Written for this app because no shadcn / AI Elements part renders a comment
 * on a passage inside a chain-of-thought step; it reuses the step panes'
 * tokens and the artifact card's "Open in canvas" affordance.
 */
import { useState } from "react";
import { ChevronDown, CircleAlert, PanelRight } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import type { TimelineToolExecution } from "@/shared/lib/types";
import { useCanvasOpener } from "@/features/chat/lib/canvasOpener";
import { canvasDocumentTitle } from "@/shared/lib/canvasDocuments";
import {
  asToolArgs,
  commentListingRefusal,
  commentListingSummary,
  type ListedCommentThread,
  oneLinePassage,
  parseCommentListing,
  parseCommentToolResult,
  type ToolArgs,
  undoDoubleEscaping,
} from "@/features/chat/lib/toolPresentation";
import { useCommentThreadRef } from "@/features/chat/hooks/useCommentThreadRef";

const text = (args: ToolArgs | null, key: string): string =>
  typeof args?.[key] === "string" ? (args[key] as string) : "";

/** Past this, the card is clamped to four lines with Show more. */
const LONG_BODY_CHARS = 280;
const LONG_BODY_LINES = 4;

const isLongBody = (body: string): boolean =>
  body.length > LONG_BODY_CHARS || body.split("\n").length > LONG_BODY_LINES;

/** Where a step's comment sits: the document, and the passage when known. */
const useCommentTarget = (
  name: string,
  args: ToolArgs | null,
): { path: string | null; quote: string; threadId: string | null } => {
  const threadId = name === "reply_to_comment" ? text(args, "thread_id").trim() || null : null;
  const thread = useCommentThreadRef(threadId);
  if (name === "add_comment") {
    return { path: text(args, "path").trim() || null, quote: text(args, "quote"), threadId: null };
  }
  return { path: thread?.path ?? null, quote: thread?.quote ?? "", threadId };
};

const PassageLine = ({ quote }: { quote: string }) => {
  const line = oneLinePassage(quote);
  if (!line) return null;
  return (
    <p className="truncate text-muted-foreground text-xs italic" title={line}>
      «{line}»
    </p>
  );
};

/** The agent's comment, as a quoted card: wraps, clamps when long. */
const CommentCard = ({ body }: { body: string }) => {
  const [expanded, setExpanded] = useState(false);
  const long = isLongBody(body);
  return (
    <div className="min-w-0 rounded-md border-primary/40 border-l-2 bg-muted/50 px-3 py-2 text-foreground">
      <p
        className={cn(
          "whitespace-pre-wrap break-words text-[13px] leading-relaxed",
          long && !expanded && "line-clamp-4",
        )}
      >
        {body}
      </p>
      {long ? (
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          className="mt-1 rounded-sm font-medium text-muted-foreground text-xs transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
};

/** What the agent wrote and where: the passage, then its words. */
export const CommentToolArgsView = ({ tool, args: rawArgs }: { tool: TimelineToolExecution; args: unknown }) => {
  const args = asToolArgs(rawArgs);
  const target = useCommentTarget(tool.name, args);
  // Arguments still streaming (or malformed): the row's title says enough.
  const body = undoDoubleEscaping(text(args, "body")).trim();
  if (!args || (!body && !target.quote)) return null;
  return (
    <div className="space-y-1.5">
      <PassageLine quote={target.quote} />
      {body ? <CommentCard body={body} /> : null}
    </div>
  );
};

/** A refusal the agent got back, in its own words. */
const RefusalLine = ({ children }: { children: string }) => (
  <p className="flex items-start gap-1.5 break-words text-destructive text-xs">
    <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
    <span className="min-w-0">{children}</span>
  </p>
);

/** What came back: a way to the comment on success, the reason on a refusal. */
export const CommentToolResultView = ({ tool, args: rawArgs }: { tool: TimelineToolExecution; args: unknown }) => {
  const args = asToolArgs(rawArgs);
  const target = useCommentTarget(tool.name, args);
  const openCanvas = useCanvasOpener();
  const result = tool.result;
  if (result === undefined) return null;
  if (tool.state === "output-error") {
    return <RefusalLine>{result.trim() || "The comment could not be saved."}</RefusalLine>;
  }
  const outcome = parseCommentToolResult(result);
  if (outcome?.ok === false) return <RefusalLine>{outcome.reason}</RefusalLine>;
  if (!outcome) {
    return <p className="whitespace-pre-wrap break-words text-muted-foreground text-xs italic">{result}</p>;
  }
  if (!openCanvas || !target.path) return null;
  const path = target.path;
  return (
    <button
      type="button"
      onClick={(event) =>
        openCanvas(path, event.currentTarget, target.threadId ? { commentId: target.threadId } : undefined)
      }
      className="flex items-center gap-1.5 rounded-sm font-medium text-[11px] text-primary/80 transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <PanelRight aria-hidden className="size-3" />
      Open in canvas
    </button>
  );
};

/** One listed thread: its passage, then its first comment, clamped to two lines. */
const ListedThreadItem = ({ thread, showState }: { thread: ListedCommentThread; showState: boolean }) => (
  <li className="min-w-0 space-y-0.5">
    <PassageLine quote={thread.quote} />
    <p className="line-clamp-2 break-words text-foreground text-xs leading-relaxed">
      {showState && thread.resolved ? (
        <span className="mr-1.5 rounded-sm bg-muted px-1 py-px font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
          Resolved
        </span>
      ) : null}
      {thread.author === "agent" ? <span className="text-muted-foreground">Agent: </span> : null}
      {thread.body}
    </p>
  </li>
);

/**
 * What `list_comments` read: a summary line that opens to the threads, each as
 * its passage and first comment — grouped by document when it read several.
 * A refusal is the same destructive line as the write tools'.
 */
export const CommentListingView = ({ tool }: { tool: TimelineToolExecution }) => {
  const [open, setOpen] = useState(false);
  const result = tool.result;
  if (result === undefined) return null;
  const refusal = tool.state === "output-error" ? result.trim() || "The comments could not be read." : null;
  if (refusal ?? commentListingRefusal(result)) {
    return <RefusalLine>{refusal ?? (commentListingRefusal(result) as string)}</RefusalLine>;
  }
  const listing = parseCommentListing(result);
  if (!listing) {
    return <p className="whitespace-pre-wrap break-words text-muted-foreground text-xs italic">{result}</p>;
  }
  const summary = commentListingSummary(listing);
  if (!listing.threads.length) return <p className="text-muted-foreground text-xs">{summary}</p>;
  const documents = [...new Set(listing.threads.map((thread) => thread.path))];
  const showState = listing.status === "all";
  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex items-center gap-1 rounded-sm font-medium text-muted-foreground text-xs transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {summary}
        <ChevronDown aria-hidden className={cn("size-3 transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div className="space-y-2 rounded-md border-primary/40 border-l-2 bg-muted/50 px-3 py-2">
          {documents.map((path) => (
            <div key={path} className="space-y-1.5">
              {documents.length > 1 ? (
                <p className="font-medium text-[11px] text-muted-foreground">{canvasDocumentTitle(path)}</p>
              ) : null}
              <ul className="space-y-1.5">
                {listing.threads
                  .filter((thread) => thread.path === path)
                  .map((thread, index) => (
                    <ListedThreadItem key={`${path}-${index}`} thread={thread} showState={showState} />
                  ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
};

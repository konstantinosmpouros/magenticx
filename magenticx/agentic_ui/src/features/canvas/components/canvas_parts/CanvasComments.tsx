/**
 * A document's comment threads as cards on the text (plan 44, Phase 4.4),
 * the way Claude Docs shows them: no side panel. Each commented line has a
 * 💬 mark in the margin (`CanvasCommentMarkers`); a click on it, or on a
 * painted passage, opens a card under the mark with that line's threads:
 * the author and time, the body, ⋯ (Edit / Delete on one's own) and ✓
 * Resolve, the replies, and a Reply box at the bottom.
 *
 * Threads whose quote is no longer in the text ("detached") and resolved
 * threads have no line to sit on: they are listed in the card of the mark at
 * the top of the margin (`CanvasOtherComments`), resolved ones folded under
 * "Resolved (n)" with Reopen.
 *
 * Shaped after Plate's registry discussion pieces (`block-discussion`,
 * `comment`), built from the app's own buttons, menus and collapsible.
 * Plate's comment plugin itself is not used: it keeps comments as marks
 * inside the document's value, which would make every comment an unsaved
 * edit and has no place in the markdown the document is stored as. Here a
 * comment is the bridge's record, anchored by its quote
 * (`lib/commentAnchors.ts`).
 */
import { useState, type ReactNode } from "react";
import {
  Check,
  ChevronRight,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Sparkles,
  Trash2,
  Unlink,
  UserRound,
} from "lucide-react";

import type { CanvasComment, CanvasCommentThread } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";
import { Button } from "@/shared/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/shared/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";

import { isLocalComment, type CanvasCommentsState } from "../../hooks/useCanvasComments";
import { formatVersionMoment } from "../../lib/dates";
import { CanvasCommentForm } from "./CanvasCommentForm";
import { CanvasHint } from "./CanvasHint";

const smallIconButton =
  "flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted [@media(pointer:coarse)]:size-11 [&_svg]:size-4";

function Author({ comment }: { comment: CanvasComment }) {
  const Icon = comment.author === "agent" ? Sparkles : UserRound;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[13px]">
      <span
        aria-hidden="true"
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-full",
          comment.author === "agent" ? "bg-primary/12 text-primary" : "bg-muted text-foreground/80",
        )}
      >
        <Icon className="size-3.5" />
      </span>
      <span className="font-semibold text-foreground">
        {comment.author === "agent" ? "Agent" : "You"}
      </span>
      <span className="truncate text-xs text-muted-foreground">
        {isLocalComment(comment.id) ? "Sending…" : formatVersionMoment(comment.createdAt)}
      </span>
    </span>
  );
}

/** One comment: its author and time, its body, and Edit / Delete on one's own. */
function CommentItem({
  comment,
  isThread,
  comments,
  trailing,
}: {
  comment: CanvasComment;
  /** The thread's first comment (Delete takes the replies too). */
  isThread: boolean;
  comments: CanvasCommentsState;
  /** Buttons before the ⋯ menu (Resolve, on a thread). */
  trailing?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const own = comment.author === "user";
  const local = isLocalComment(comment.id);

  return (
    <div className={cn("space-y-1.5", local && "opacity-60")} aria-busy={local || undefined}>
      <div className="flex items-center gap-1">
        <Author comment={comment} />
        <span className="ml-auto flex items-center">
          {trailing}
          {own && !local ? (
            <DropdownMenu>
              <CanvasHint label="More actions">
                <DropdownMenuTrigger
                  className={smallIconButton}
                  aria-label={
                    isThread ? "More actions on this thread" : "More actions on this reply"
                  }
                >
                  <MoreHorizontal />
                </DropdownMenuTrigger>
              </CanvasHint>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem className="gap-2" onSelect={() => setEditing(true)}>
                  <Pencil className="size-4 text-muted-foreground" aria-hidden="true" />
                  Edit
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="gap-2 text-destructive focus:text-destructive"
                  onSelect={() => setConfirming(true)}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </span>
      </div>

      {editing ? (
        <CanvasCommentForm
          label="Edit the comment"
          placeholder="Edit the comment…"
          submitLabel="Save"
          initial={comment.body}
          onSubmit={(body) => {
            setEditing(false);
            void comments.editBody(comment, body);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <p className="whitespace-pre-wrap break-words pl-[1.875rem] text-sm leading-relaxed text-foreground/90">
          {comment.body}
        </p>
      )}

      {confirming ? (
        <div
          role="alertdialog"
          aria-label={isThread ? "Delete this thread?" : "Delete this reply?"}
          className="ml-[1.875rem] flex flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-2.5 py-2 animate-in fade-in-0 duration-150 motion-reduce:animate-none"
        >
          <span className="mr-auto text-[13px] text-foreground">
            {isThread ? "Delete this thread and its replies?" : "Delete this reply?"}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 [@media(pointer:coarse)]:h-11"
            onClick={() => setConfirming(false)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            variant="destructive"
            className="h-8 [@media(pointer:coarse)]:h-11"
            autoFocus
            onClick={() => {
              setConfirming(false);
              void comments.remove(comment);
            }}
          >
            Delete
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** The thread's passage: its quote, or "Detached" when the quote is no longer in the text. */
function Quote({ quote, detached }: { quote: string; detached: boolean }) {
  return (
    <span className="block space-y-1">
      {detached ? (
        <span className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          <Unlink className="size-3" aria-hidden="true" />
          Detached · the text changed
        </span>
      ) : null}
      <span
        className={cn(
          "line-clamp-3 border-l-2 pl-2.5 text-[13px] leading-snug",
          detached
            ? "border-muted-foreground/40 text-muted-foreground line-through decoration-muted-foreground/40"
            : "border-warning text-foreground/75",
        )}
      >
        {quote}
      </span>
    </span>
  );
}

/** One thread in a card: its comment with ✓ Resolve, the replies, the Reply box. */
function ThreadItem({
  thread,
  comments,
  detached,
}: {
  thread: CanvasCommentThread;
  comments: CanvasCommentsState;
  /** Its quote is no longer in the text: show the quote, struck through. */
  detached: boolean;
}) {
  const { comment, replies } = thread;
  const [replying, setReplying] = useState(false);
  const local = isLocalComment(comment.id);

  return (
    <li
      id={`canvas-thread-${comment.id}`}
      aria-label={`Comment on “${comment.anchor?.quote.slice(0, 60) ?? ""}”`}
      className="px-3.5 py-3"
    >
      {detached ? (
        <div className="mb-2.5">
          <Quote quote={comment.anchor?.quote ?? ""} detached />
        </div>
      ) : null}

      <CommentItem
        comment={comment}
        isThread
        comments={comments}
        trailing={
          local ? null : (
            <CanvasHint label="Resolve">
              <button
                type="button"
                aria-label="Resolve thread"
                onClick={() => void comments.setStatus(comment, "resolved")}
                className={cn(smallIconButton, "hover:text-primary")}
              >
                <Check />
              </button>
            </CanvasHint>
          )
        }
      />

      {replies.length > 0 ? (
        <ul className="mt-3 space-y-3" aria-label="Replies">
          {replies.map((item) => (
            <li key={item.id}>
              <CommentItem comment={item} isThread={false} comments={comments} />
            </li>
          ))}
        </ul>
      ) : null}

      {local ? null : replying ? (
        <CanvasCommentForm
          className="mt-3"
          label="Reply to the thread"
          placeholder="Reply…"
          submitLabel="Reply"
          onSubmit={(body) => {
            setReplying(false);
            void comments.reply(comment, body);
          }}
          onCancel={() => setReplying(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setReplying(true)}
          className="mt-3 flex h-10 w-full items-center rounded-xl bg-muted/60 px-3 text-left text-[13px] text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-11"
        >
          Reply…
        </button>
      )}
    </li>
  );
}

/** A resolved thread, folded: its quote, its first comment, who resolved it, Reopen. */
function ResolvedCard({
  thread,
  comments,
}: {
  thread: CanvasCommentThread;
  comments: CanvasCommentsState;
}) {
  const { comment, replies } = thread;
  const by = comment.resolvedBy === "agent" ? "the agent" : "you";
  return (
    <li className="rounded-xl border border-border/60 bg-muted/30 p-3">
      <Quote quote={comment.anchor?.quote ?? ""} detached={false} />
      <p className="mt-2 line-clamp-2 text-[13px] text-muted-foreground">{comment.body}</p>
      {comment.resolutionNote ? (
        <p className="mt-1 line-clamp-2 text-xs italic text-muted-foreground">
          {comment.resolutionNote}
        </p>
      ) : null}
      <div className="mt-2 flex items-center gap-2">
        <span className="mr-auto flex items-center gap-1 text-xs text-muted-foreground">
          <Check className="size-3.5" aria-hidden="true" />
          Resolved by {by}
          {replies.length > 0
            ? ` · ${replies.length} ${replies.length === 1 ? "reply" : "replies"}`
            : ""}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 gap-1.5 [@media(pointer:coarse)]:h-11"
          onClick={() => void comments.setStatus(comment, "open")}
        >
          <RotateCcw className="size-3.5" aria-hidden="true" />
          Reopen
        </Button>
      </div>
    </li>
  );
}

/** The threads of one line, in the card under its margin mark. */
export function CanvasCommentThreads({
  threads,
  comments,
}: {
  threads: CanvasCommentThread[];
  comments: CanvasCommentsState;
}) {
  return (
    <ul className="divide-y divide-border/60" aria-label="Comments">
      {threads.map((thread) => (
        <ThreadItem key={thread.comment.id} thread={thread} comments={comments} detached={false} />
      ))}
    </ul>
  );
}

/**
 * The threads with no line to sit on, in the card of the mark at the top of
 * the margin: those whose text changed (detached), then the resolved ones,
 * folded, with Reopen.
 */
export function CanvasOtherComments({
  detached,
  comments,
}: {
  detached: CanvasCommentThread[];
  comments: CanvasCommentsState;
}) {
  const { resolved } = comments;
  return (
    <div className="divide-y divide-border/60">
      {detached.length > 0 ? (
        <ul aria-label="Comments on text that changed" className="divide-y divide-border/60">
          {detached.map((thread) => (
            <ThreadItem key={thread.comment.id} thread={thread} comments={comments} detached />
          ))}
        </ul>
      ) : null}
      {resolved.length > 0 ? (
        <Collapsible className="p-1.5">
          <CollapsibleTrigger className="group flex h-9 w-full items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-11">
            <ChevronRight
              className="size-4 transition-transform duration-150 group-data-[state=open]:rotate-90 motion-reduce:transition-none"
              aria-hidden="true"
            />
            Resolved ({resolved.length})
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="mt-1 space-y-2 px-1 pb-1" aria-label="Resolved comments">
              {resolved.map((thread) => (
                <ResolvedCard key={thread.comment.id} thread={thread} comments={comments} />
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}

/**
 * The document's comment threads (plan 44 §3, Phase 4.4): a panel on the
 * right of the document on wider screens, a bottom sheet on a phone — the
 * same slot as the version history, toggled from the 💬 count in the
 * document row. Cards aligned in the margin were weighed and left out: the
 * canvas is 520–900px wide and its reading column already takes 680, so
 * margin cards would squeeze the text or cover it.
 *
 * Each open thread shows its passage (or "Detached" when the quote is no
 * longer in the text), its comments and replies, a reply box, Resolve, and
 * Edit / Delete on one's own comments; resolved threads fold under
 * "Resolved (n)" with Reopen. Clicking a thread scrolls the document to its
 * passage (`onActivate`); clicking a passage brings its thread here.
 *
 * Shaped after Plate's registry discussion pieces (`block-discussion`,
 * `comment`: the quote, author and time, the body, the reply box, resolve),
 * built from the app's own buttons, menus, sheet and collapsible. Plate's
 * comment plugin itself is not used: it keeps comments as marks inside the
 * document's value, which would make every comment an unsaved edit and has
 * no place in the markdown the document is stored as. Here a comment is the
 * bridge's record, anchored by its quote (`lib/commentAnchors.ts`).
 */
import { useEffect, useState, type ReactNode } from "react";
import {
  Check,
  ChevronRight,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Sparkles,
  Trash2,
  Unlink,
  UserRound,
  X,
} from "lucide-react";

import type { CanvasAnchorPlacement, CanvasComment, CanvasCommentThread } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";
import { Button } from "@/shared/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/shared/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/shared/ui/sheet";
import { Skeleton } from "@/shared/ui/skeleton";

import { isLocalComment, type CanvasCommentsState } from "../../hooks/useCanvasComments";
import { scrollBehavior } from "../../lib/commentHighlight";
import { formatVersionMoment } from "../../lib/dates";
import { CanvasCommentForm } from "./CanvasCommentForm";
import { CanvasHint } from "./CanvasHint";

const smallIconButton =
  "flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted [@media(pointer:coarse)]:size-11 [&_svg]:size-4";

export interface CanvasCommentsProps {
  open: boolean;
  /** Phone layout: a bottom sheet instead of the side panel. */
  compact: boolean;
  comments: CanvasCommentsState;
  /** Where each open thread's passage is in the shown text; null while not known (a compare). */
  placements: Record<string, CanvasAnchorPlacement> | null;
  activeId: string | null;
  /** A thread was picked: scroll the document to its passage. */
  onActivate: (id: string) => void;
  onClose: () => void;
}

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

function ThreadCard({
  thread,
  comments,
  detached,
  active,
  onActivate,
}: {
  thread: CanvasCommentThread;
  comments: CanvasCommentsState;
  detached: boolean;
  active: boolean;
  onActivate: () => void;
}) {
  const { comment, replies } = thread;
  const [replying, setReplying] = useState(false);
  const local = isLocalComment(comment.id);

  return (
    <li
      id={`canvas-thread-${comment.id}`}
      aria-label={`Comment on “${comment.anchor?.quote.slice(0, 60) ?? ""}”`}
      className={cn(
        "rounded-xl border bg-card p-3 transition-[border-color,box-shadow] duration-150",
        active ? "border-warning/70 shadow-md shadow-foreground/5" : "border-border/70",
      )}
    >
      <button
        type="button"
        onClick={onActivate}
        aria-current={active ? "true" : undefined}
        disabled={detached}
        aria-label={detached ? undefined : "Show the passage in the document"}
        className="mb-2.5 block w-full rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
      >
        <Quote quote={comment.anchor?.quote ?? ""} detached={detached} />
      </button>

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
        <ul className="mt-3 space-y-3 border-t border-border/60 pt-3" aria-label="Replies">
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
          className="mt-3 flex h-9 w-full items-center rounded-lg border border-border/70 bg-background px-3 text-left text-[13px] text-muted-foreground transition-colors duration-150 hover:border-border hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-11"
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

function Body({
  comments,
  placements,
  activeId,
  onActivate,
}: Omit<CanvasCommentsProps, "open" | "compact" | "onClose">) {
  const { open, resolved } = comments;

  // A passage clicked in the text: bring its card into view (without taking
  // the focus from the editor).
  useEffect(() => {
    if (!activeId) return;
    document
      .getElementById(`canvas-thread-${activeId}`)
      ?.scrollIntoView({ block: "nearest", behavior: scrollBehavior() });
  }, [activeId]);

  if (comments.loading) {
    return (
      <div className="space-y-3 px-4 py-3" aria-busy="true" aria-label="Loading comments">
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>
    );
  }
  if (comments.errorMessage) {
    return (
      <div className="space-y-3 px-4 py-6 text-center">
        <p className="text-sm text-muted-foreground">{comments.errorMessage}</p>
        <Button size="sm" variant="outline" onClick={() => void comments.retry()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4 px-3 py-3">
      {open.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
          <span className="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <MessageSquare className="size-5" aria-hidden="true" />
          </span>
          <p className="text-sm font-medium text-foreground">
            {resolved.length > 0 ? "No open comments" : "No comments yet"}
          </p>
          <p className="max-w-[16rem] text-[13px] leading-relaxed text-muted-foreground">
            Select text in the document, then choose <strong>Comment</strong> to start a thread.
          </p>
        </div>
      ) : (
        <ul className="space-y-3" aria-label="Open comments">
          {open.map((thread) => (
            <ThreadCard
              key={thread.comment.id}
              thread={thread}
              comments={comments}
              detached={placements !== null && placements[thread.comment.id] === null}
              active={thread.comment.id === activeId}
              onActivate={() => onActivate(thread.comment.id)}
            />
          ))}
        </ul>
      )}

      {resolved.length > 0 ? (
        <Collapsible>
          <CollapsibleTrigger className="group flex h-9 w-full items-center gap-1.5 rounded-lg px-1.5 text-[13px] font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-11">
            <ChevronRight
              className="size-4 transition-transform duration-150 group-data-[state=open]:rotate-90 motion-reduce:transition-none"
              aria-hidden="true"
            />
            Resolved ({resolved.length})
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="mt-2 space-y-2" aria-label="Resolved comments">
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

function Heading({ count }: { count: number }) {
  return (
    <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
      <MessageSquare className="size-4 text-muted-foreground" aria-hidden="true" />
      Comments
      {count > 0 ? (
        <span className="rounded-full bg-muted px-1.5 text-xs font-medium tabular-nums text-muted-foreground">
          {count}
        </span>
      ) : null}
    </span>
  );
}

export function CanvasComments(props: CanvasCommentsProps) {
  const { open, compact, comments, onClose } = props;
  const count = comments.open.length;
  const busy = comments.loading;

  if (compact) {
    return (
      <Sheet open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
        <SheetContent
          side="bottom"
          hideClose
          className="flex max-h-[85svh] flex-col gap-0 rounded-t-2xl p-0"
        >
          <div className="flex items-center justify-between px-4 pb-1 pt-4">
            <SheetTitle asChild>
              <span>
                <Heading count={count} />
              </span>
            </SheetTitle>
            <button
              type="button"
              aria-label="Close comments"
              onClick={onClose}
              className="flex size-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-[18px]" />
            </button>
          </div>
          <SheetDescription className="sr-only">
            Comment threads on passages of the document.
          </SheetDescription>
          <div className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
            <Body {...props} />
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  if (!open) return null;
  return (
    <aside
      aria-label="Comments"
      aria-busy={busy || undefined}
      className="flex w-[min(21rem,46%)] shrink-0 flex-col border-l border-border/70 bg-background animate-in fade-in-0 slide-in-from-right-2 duration-200 motion-reduce:animate-none"
    >
      <div className="flex h-12 shrink-0 items-center justify-between pl-4 pr-2">
        <Heading count={count} />
        <CanvasHint label="Close comments">
          <button
            type="button"
            aria-label="Close comments"
            onClick={onClose}
            className="flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-[18px]" />
          </button>
        </CanvasHint>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Body {...props} />
      </div>
    </aside>
  );
}

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
 * the top of the margin (`CanvasOtherComments`), resolved ones listed
 * straight under "Resolved (n)" with Reopen; that card scrolls inside. In a
 * line's card the thread scrolls and the reply box stays pinned at the bottom.
 *
 * Comments as instructions (plan 44 v2): a reply or a new thread with
 * `@agent` in it asks the agent to act on the thread's passage
 * (`CanvasCommentAgentContext`); while that run goes the thread's card says
 * "Agent is working on this…". The agent's own comments carry its avatar
 * (the orb) and "Agent"; a thread it resolved says so.
 *
 * Shaped after Plate's registry discussion pieces (`block-discussion`,
 * `comment`), built from the app's own buttons, menus and collapsible.
 * Plate's comment plugin itself is not used: it keeps comments as marks
 * inside the document's value, which would make every comment an unsaved
 * edit and has no place in the markdown the document is stored as. Here a
 * comment is the bridge's record, anchored by its quote
 * (`lib/commentAnchors.ts`).
 */
import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Check,
  Loader2,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Trash2,
  Unlink,
  UserRound,
} from "lucide-react";

import type { CanvasComment, CanvasCommentThread } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";

import { isLocalComment, type CanvasCommentsState } from "../../hooks/useCanvasComments";
import { hasAgentMention } from "../../lib/agentMention";
import { CanvasCommentAgentContext } from "../../lib/commentAgentContext";
import { scrollBehavior } from "../../lib/commentHighlight";
import { formatVersionMoment } from "../../lib/dates";
import { CanvasAgentAvatar, CanvasMentionText } from "./CanvasAgentMention";
import { CanvasCommentForm } from "./CanvasCommentForm";
import { CanvasHint } from "./CanvasHint";

/** An item asked for from the chat: brought into view in its card once it shows. */
function useFocusedItem<T extends HTMLElement>(focused: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!focused) return;
    const frame = window.requestAnimationFrame(() =>
      ref.current?.scrollIntoView?.({ block: "nearest", behavior: scrollBehavior() }),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [focused]);
  return ref;
}

const smallIconButton =
  "flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted [@media(pointer:coarse)]:size-11 [&_svg]:size-4";

function Author({ comment }: { comment: CanvasComment }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[13px]">
      {comment.author === "agent" ? (
        <CanvasAgentAvatar />
      ) : (
        <span
          aria-hidden="true"
          className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-foreground/80"
        >
          <UserRound className="size-3.5" />
        </span>
      )}
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
          <CanvasMentionText body={comment.body} />
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
  focused = false,
  composer = true,
  onReplyHere,
  targeted = false,
}: {
  thread: CanvasCommentThread;
  comments: CanvasCommentsState;
  /** Its quote is no longer in the text: show the quote, struck through. */
  detached: boolean;
  /** Asked for from the chat: tinted and scrolled into view. */
  focused?: boolean;
  /** False in a line's card: its reply box is the card's pinned footer instead. */
  composer?: boolean;
  /** Several threads in one card: makes this one the footer's target. */
  onReplyHere?: () => void;
  /** This thread is the footer's target (several threads in one card). */
  targeted?: boolean;
}) {
  const ref = useFocusedItem<HTMLLIElement>(focused);
  const { comment, replies } = thread;
  const local = isLocalComment(comment.id);
  const agent = useContext(CanvasCommentAgentContext);
  const working = agent?.workingThreadId === comment.id;

  return (
    <li
      ref={ref}
      id={`canvas-thread-${comment.id}`}
      aria-label={`Comment on “${comment.anchor?.quote.slice(0, 60) ?? ""}”`}
      className={cn("px-3.5 py-3", (focused || targeted) && "bg-primary/5")}
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

      {working ? (
        <p
          role="status"
          className="mt-3 flex items-center gap-2 pl-[1.875rem] text-[13px] text-muted-foreground animate-in fade-in-0 duration-200 motion-reduce:animate-none"
        >
          <Loader2
            className="size-3.5 shrink-0 animate-spin text-primary motion-reduce:animate-none"
            aria-hidden="true"
          />
          Agent is working on this…
        </p>
      ) : null}

      {composer ? (
        <ThreadComposer thread={thread} comments={comments} className="mt-3" />
      ) : onReplyHere && !local && !targeted ? (
        <button
          type="button"
          onClick={onReplyHere}
          className="mt-2 ml-[1.875rem] rounded-md px-1 text-[13px] font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-11"
        >
          Reply here
        </button>
      ) : null}
    </li>
  );
}

/**
 * A thread's reply box: "Reply…" until clicked, then the composer. `@agent`
 * in a reply saves it first (so the thread shows what was asked), then asks.
 */
function ThreadComposer({
  thread,
  comments,
  className,
}: {
  thread: CanvasCommentThread;
  comments: CanvasCommentsState;
  className?: string;
}) {
  const { comment } = thread;
  const [replying, setReplying] = useState(false);
  const agent = useContext(CanvasCommentAgentContext);
  const mentions = Boolean(agent?.mentions);
  if (isLocalComment(comment.id)) return null;
  return replying ? (
    <CanvasCommentForm
      className={className}
      label="Reply to the thread"
      placeholder={mentions ? "Reply, or @agent to ask the agent…" : "Reply…"}
      submitLabel="Reply"
      mentions={mentions}
      onSubmit={(body) => {
        setReplying(false);
        void comments.reply(comment, body).then((saved) => {
          // Saved first, so the thread shows what was asked; then the ask.
          if (saved && agent?.mentions && hasAgentMention(body)) agent.ask(comment, body);
        });
      }}
      onCancel={() => setReplying(false)}
    />
  ) : (
    <button
      type="button"
      onClick={() => setReplying(true)}
      className={cn(
        "flex h-10 w-full items-center rounded-xl bg-muted/60 px-3 text-left text-[13px] text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-11",
        className,
      )}
    >
      {mentions ? "Reply, or @agent to ask the agent…" : "Reply…"}
    </button>
  );
}

/** A resolved thread, folded: its quote, its first comment, who resolved it, Reopen. */
function ResolvedCard({
  thread,
  comments,
  focused,
}: {
  thread: CanvasCommentThread;
  comments: CanvasCommentsState;
  /** Asked for from the chat: ringed and scrolled into view. */
  focused: boolean;
}) {
  const { comment, replies } = thread;
  const byAgent = comment.resolvedBy === "agent";
  const ref = useFocusedItem<HTMLLIElement>(focused);
  const lastReply = replies.length > 0 ? replies[replies.length - 1] : null;
  return (
    <li
      ref={ref}
      id={`canvas-thread-${comment.id}`}
      aria-label={`Resolved comment on “${comment.anchor?.quote.slice(0, 60) ?? ""}”`}
      className={cn(
        "rounded-xl border border-border/60 bg-muted/30 p-3",
        focused && "ring-2 ring-primary/40",
      )}
    >
      <Quote quote={comment.anchor?.quote ?? ""} detached={false} />
      <p className="mt-2 line-clamp-2 text-[13px] text-muted-foreground">
        <CanvasMentionText body={comment.body} />
      </p>
      {lastReply?.author === "agent" ? (
        <p className="mt-2 flex items-start gap-1.5 text-[13px] text-foreground/80">
          <CanvasAgentAvatar className="mt-px size-4 ring-0" />
          <span className="line-clamp-3">{lastReply.body}</span>
        </p>
      ) : null}
      {comment.resolutionNote ? (
        <p className="mt-1 line-clamp-2 text-xs italic text-muted-foreground">
          {comment.resolutionNote}
        </p>
      ) : null}
      <div className="mt-2 flex items-center gap-2">
        <span className="mr-auto flex items-center gap-1 text-xs text-muted-foreground">
          <Check className={cn("size-3.5", byAgent && "text-primary")} aria-hidden="true" />
          {byAgent ? "Resolved by the agent" : "Resolved by you"}
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
  // The footer answers one thread: the one picked with "Reply here", else
  // the newest (the last) — with a single thread, simply that one.
  const [targetId, setTargetId] = useState<string | null>(null);
  const target =
    threads.find((thread) => thread.comment.id === targetId) ?? threads[threads.length - 1];
  const several = threads.length > 1;

  // Open on the newest message, like a chat, and follow new ones as they come.
  const scrollRef = useRef<HTMLDivElement>(null);
  const messages = threads.reduce((count, thread) => count + 1 + thread.replies.length, 0);
  useEffect(() => {
    const area = scrollRef.current;
    if (!area) return;
    const toEnd = () => {
      area.scrollTop = area.scrollHeight;
    };
    toEnd();
    // The popover sizes itself (its max height comes from the room on screen)
    // after the first paint: follow that size change too, until it settles.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(toEnd);
    observer.observe(area);
    const stop = window.setTimeout(() => observer.disconnect(), 600);
    return () => {
      window.clearTimeout(stop);
      observer.disconnect();
    };
  }, [messages]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <ul className="divide-y divide-border/60" aria-label="Comments">
          {threads.map((thread) => (
            <ThreadItem
              key={thread.comment.id}
              thread={thread}
              comments={comments}
              detached={false}
              composer={false}
              onReplyHere={several ? () => setTargetId(thread.comment.id) : undefined}
              targeted={several && thread === target}
            />
          ))}
        </ul>
      </div>
      {target ? (
        // Pinned: never scrolled away, never below the card's edge.
        <div className="shrink-0 border-t border-border/60 bg-popover px-3.5 py-3">
          {several ? (
            <p className="mb-2 truncate text-xs text-muted-foreground">
              Replying on «{target.comment.anchor?.quote ?? ""}»
            </p>
          ) : null}
          <ThreadComposer key={target.comment.id} thread={target} comments={comments} />
        </div>
      ) : null}
    </div>
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
  focusId = null,
}: {
  detached: CanvasCommentThread[];
  comments: CanvasCommentsState;
  /** A thread asked for from the chat (an `@agent` card): its list opens on it. */
  focusId?: string | null;
}) {
  const { resolved } = comments;
  return (
    <div className="min-h-0 flex-1 divide-y divide-border/60 overflow-y-auto overscroll-contain">
      {detached.length > 0 ? (
        <ul aria-label="Comments on text that changed" className="divide-y divide-border/60">
          {detached.map((thread) => (
            <ThreadItem
              key={thread.comment.id}
              thread={thread}
              comments={comments}
              detached
              focused={thread.comment.id === focusId}
            />
          ))}
        </ul>
      ) : null}
      {resolved.length > 0 ? (
        <section aria-labelledby="canvas-resolved-heading" className="p-1.5">
          <h3
            id="canvas-resolved-heading"
            className="flex h-9 items-center px-2 text-[13px] font-medium text-muted-foreground"
          >
            Resolved ({resolved.length})
          </h3>
          <ul className="space-y-2 px-1 pb-1" aria-label="Resolved comments">
            {resolved.map((thread) => (
              <ResolvedCard
                key={thread.comment.id}
                thread={thread}
                comments={comments}
                focused={thread.comment.id === focusId}
              />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

import { useMemo } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Clock3, SendHorizontal, ShieldAlert, X } from "lucide-react";

import { toTitleCase, useBackgroundTasksContext, waitingTasks } from "@/features/inference";
import type { QueuedMessage } from "@/shared/lib/types";

type ComposerTaskNoticesProps = {
  /** The conversation's queued messages, oldest first. */
  queuedMessages: QueuedMessage[];
  /** A line's ×: cancel that one message. */
  onCancelQueued: (messageId: string) => void;
  /**
   * "Send now" (SSE plan phase 6): stop the answer that is running. The bridge
   * sends the queue the moment any run ends — a stopped one too — so stopping
   * is all it takes. Absent while nothing is running.
   */
  onSendNow?: () => void;
};

// Enter 200ms ease-out, exit at ~65% of it ease-in; transform + opacity only.
const ENTER = { opacity: 1, y: 0, transition: { duration: 0.2, ease: "easeOut" } } as const;
const EXIT = { opacity: 0, y: 4, transition: { duration: 0.13, ease: "easeIn" } } as const;

const ROW = "flex min-w-0 items-center gap-2 px-3 py-1.5 text-xs";
const CARD = "mb-2 min-w-0 rounded-2xl border border-border/70 bg-card shadow-card";

/**
 * When the queue goes in. Plain messages are read by the running agent at its
 * next step (steering, SSE plan phase 5) — or sent, stacked, when the answer
 * ends if the agent finishes first; a slash command first in line always waits
 * for the end, because it is a turn of its own.
 */
function queuedHint(first: QueuedMessage, count: number): string {
  if (first.commandName) return "Sent when this answer ends";
  return count > 1 ? "Read at the next step, or sent together after this answer" : "Read at the next step, or sent after this answer";
}

/** What a queued line shows: its slash command, its text (or its files). */
function QueuedText({ message }: { message: QueuedMessage }) {
  return (
    <span className="min-w-0 flex-1 truncate text-foreground" title={message.content}>
      {message.commandName ? <span className="font-medium text-primary">/{message.commandName} </span> : null}
      {message.content ||
        (message.attachmentCount
          ? `${message.attachmentCount} file${message.attachmentCount === 1 ? "" : "s"}`
          : "Your message")}
    </span>
  );
}

function CancelButton({ message, onCancel }: { message: QueuedMessage; onCancel: (id: string) => void }) {
  if (!message.id) return null;
  const id = message.id;
  return (
    <button
      type="button"
      onClick={() => onCancel(id)}
      aria-label={`Cancel the queued message: ${message.content || "your message"}`}
      title="Cancel — it goes back into the composer"
      className="relative flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 after:absolute after:-inset-2 after:content-[''] hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50"
    >
      <X className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}

function SendNowButton({ onSendNow, count }: { onSendNow: () => void; count: number }) {
  const what = count > 1 ? `these ${count} messages` : "this message";
  return (
    <button
      type="button"
      onClick={onSendNow}
      aria-label={`Send now: stop the answer and send ${what}`}
      title={`Send now — stops the answer and sends ${what}`}
      className="relative flex min-h-[2rem] flex-shrink-0 items-center gap-1 rounded-full px-2.5 font-medium text-primary transition-colors duration-150 after:absolute after:-inset-1.5 after:content-[''] hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
    >
      <SendHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="hidden sm:inline">Send now</span>
    </button>
  );
}

function QueuedPill({ count }: { count: number }) {
  return (
    <span className="flex-shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
      {count > 1 ? `Queued · ${count}` : "Queued"}
    </span>
  );
}

/**
 * The lines above the composer for the conversation's background work (plan
 * 41): the queued messages (§3.6) — one compact line when there is one, a
 * small stack when there are more, each with its own cancel — and a prompt
 * per task waiting on an approval (§3.8). The approval itself lives in the
 * task's drill-down, which the prompt opens, so a waiting task never takes
 * the composer over the way a run's own approval does.
 */
export function ComposerTaskNotices({ queuedMessages, onCancelQueued, onSendNow }: ComposerTaskNoticesProps) {
  const tasks = useBackgroundTasksContext();
  const reduceMotion = useReducedMotion();
  const waiting = useMemo(() => (tasks ? waitingTasks(tasks.tree) : []), [tasks]);
  const initial = reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 };
  const exit = reduceMotion ? { opacity: 0, transition: { duration: 0.1 } } : EXIT;
  const count = queuedMessages.length;
  const first = queuedMessages[0];

  // Each line carries its own bottom margin, so with nothing to show the slot
  // takes no room at all.
  return (
    <div className="flex min-w-0 flex-col">
      <AnimatePresence initial={false}>
        {waiting.map((task) => (
          <motion.div
            key={`approval:${task.taskId}`}
            initial={initial}
            animate={ENTER}
            exit={exit}
            className="mb-2 flex min-w-0 items-center gap-2 rounded-2xl border border-warning/40 bg-card px-3 py-1.5 text-xs shadow-card"
          >
            <ShieldAlert className="h-3.5 w-3.5 flex-shrink-0 text-warning" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-foreground">
              <span className="font-medium">{toTitleCase(task.name)}</span>
              <span className="text-muted-foreground"> is waiting for your approval</span>
            </span>
            <button
              type="button"
              onClick={() => tasks?.openTask(task.taskId)}
              aria-label={`Review ${task.name}'s approval`}
              className="relative min-h-[2rem] flex-shrink-0 rounded-full px-2.5 font-medium text-primary transition-colors duration-150 after:absolute after:-inset-1.5 after:content-[''] hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              Review
            </button>
          </motion.div>
        ))}
        {first ? (
          <motion.div
            key="queued-messages"
            initial={initial}
            animate={ENTER}
            exit={exit}
            className={CARD}
            role="status"
            aria-label={count > 1 ? `${count} queued messages` : "Queued message"}
          >
            {count === 1 ? (
              <div className={ROW}>
                <Clock3 className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
                <QueuedPill count={1} />
                <QueuedText message={first} />
                <span className="hidden flex-shrink-0 text-muted-foreground md:inline">{queuedHint(first, 1)}</span>
                {onSendNow ? <SendNowButton onSendNow={onSendNow} count={1} /> : null}
                <CancelButton message={first} onCancel={onCancelQueued} />
              </div>
            ) : (
              <>
                <div className={`${ROW} border-b border-border/60`}>
                  <Clock3 className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
                  <QueuedPill count={count} />
                  <span className="hidden min-w-0 flex-1 truncate text-muted-foreground md:inline">
                    {queuedHint(first, count)}
                  </span>
                  <span className="flex-1 md:hidden" />
                  {onSendNow ? <SendNowButton onSendNow={onSendNow} count={count} /> : null}
                </div>
                <ol>
                  <AnimatePresence initial={false}>
                    {queuedMessages.map((message, index) => (
                      <motion.li
                        key={message.id ?? `queued-${index}`}
                        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
                        animate={ENTER}
                        exit={exit}
                        className={ROW}
                      >
                        <span className="w-4 flex-shrink-0 text-right tabular-nums text-muted-foreground" aria-hidden="true">
                          {index + 1}
                        </span>
                        <QueuedText message={message} />
                        <CancelButton message={message} onCancel={onCancelQueued} />
                      </motion.li>
                    ))}
                  </AnimatePresence>
                </ol>
              </>
            )}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

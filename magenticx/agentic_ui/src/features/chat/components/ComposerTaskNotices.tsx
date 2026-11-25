import { useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Clock3, Paperclip, SendHorizontal, ShieldAlert, X } from "lucide-react";

import { toTitleCase, useBackgroundTasksContext, waitingTasks } from "@/features/inference";
import type { QueuedMessage } from "@/shared/lib/types";
import {
  Queue,
  QueueItem,
  QueueItemAction,
  QueueItemActions,
  QueueItemContent,
  QueueItemIndicator,
  QueueList,
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger,
} from "@/shared/ui/ai-elements/queue";

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

/**
 * The queue sits as a tray tucked behind the composer's top edge: narrower
 * than the composer, no bottom border, and it runs on under the composer
 * (negative margin + bottom padding), so it reads as part of the composer
 * rather than a card floating over the chat.
 */
const TRAY =
  "relative z-10 mx-3 -mb-6 overflow-hidden rounded-t-[1.25rem] border border-b-0 border-primary/20 bg-gradient-to-b from-primary/[0.07] to-muted/70 px-2 pb-8 pt-1.5 text-xs shadow-[inset_0_1px_0_hsl(var(--primary)/0.12)] backdrop-blur-md sm:mx-5";

const MotionQueueItem = motion.create(QueueItem);

/** The header's clock in a soft primary disc, so the tray has one point of colour. */
function QueuedIcon() {
  return (
    <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-primary/[0.12] text-primary">
      <Clock3 className="h-3 w-3" aria-hidden="true" />
    </span>
  );
}

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
    <QueueItemContent title={message.content}>
      {message.commandName ? <span className="font-medium text-primary">/{message.commandName} </span> : null}
      {message.content ||
        (message.attachmentCount
          ? `${message.attachmentCount} file${message.attachmentCount === 1 ? "" : "s"}`
          : "Your message")}
      {message.content && message.attachmentCount ? (
        <span className="ml-1.5 inline-flex items-center gap-0.5 align-middle text-muted-foreground">
          <Paperclip className="h-3 w-3" aria-hidden="true" />
          {message.attachmentCount}
        </span>
      ) : null}
    </QueueItemContent>
  );
}

function CancelButton({ message, onCancel }: { message: QueuedMessage; onCancel: (id: string) => void }) {
  if (!message.id) return null;
  const id = message.id;
  return (
    <QueueItemAction
      onClick={() => onCancel(id)}
      aria-label={`Cancel the queued message: ${message.content || "your message"}`}
      title="Cancel — it goes back into the composer"
    >
      <X className="h-3.5 w-3.5" aria-hidden="true" />
    </QueueItemAction>
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
      className="relative flex h-7 flex-shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2.5 font-medium text-primary transition-colors duration-150 after:absolute after:-inset-1.5 after:content-[''] hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
    >
      <SendHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="hidden sm:inline">Send now</span>
    </button>
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
  // A stack can fold to its header to keep the chat in view; one line never folds.
  const [open, setOpen] = useState(true);

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
            className={TRAY}
            role="status"
            aria-label={count > 1 ? `${count} queued messages` : "Queued message"}
          >
            <Queue>
              <QueueSection open={open || count === 1} onOpenChange={setOpen}>
                <div className="flex min-w-0 items-center gap-2 pl-0.5">
                  {count > 1 ? (
                    <QueueSectionTrigger aria-label={open ? "Hide the queued messages" : "Show the queued messages"}>
                      <QueueSectionLabel
                        icon={<QueuedIcon />}
                        label="Queued"
                        count={count}
                      />
                    </QueueSectionTrigger>
                  ) : (
                    <QueueSectionLabel
                      className="px-1.5 py-1 text-muted-foreground"
                      icon={<QueuedIcon />}
                      label="Queued"
                    />
                  )}
                  <span className="hidden min-w-0 flex-1 truncate text-[11px] text-muted-foreground md:inline">
                    {queuedHint(first, count)}
                  </span>
                  <span className="flex-1 md:hidden" />
                  {onSendNow ? <SendNowButton onSendNow={onSendNow} count={count} /> : null}
                </div>
                <QueueSectionContent>
                  <QueueList className="mt-1 pb-0.5">
                    <AnimatePresence initial={false}>
                      {queuedMessages.map((message, index) => (
                        <MotionQueueItem
                          key={message.id ?? `queued-${index}`}
                          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
                          animate={ENTER}
                          exit={exit}
                        >
                          <QueueItemIndicator>{index + 1}</QueueItemIndicator>
                          <QueuedText message={message} />
                          <QueueItemActions>
                            <CancelButton message={message} onCancel={onCancelQueued} />
                          </QueueItemActions>
                        </MotionQueueItem>
                      ))}
                    </AnimatePresence>
                  </QueueList>
                </QueueSectionContent>
              </QueueSection>
            </Queue>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

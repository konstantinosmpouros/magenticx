/**
 * The agent's look in the comments (plan 44 v2): its avatar — the app's orb
 * artwork, still (the live `Orb` is a WebGL shader per instance, too much
 * for a list of comments, and a comment is not the AI working) — and the
 * `@agent` token styled where a comment body shows it.
 *
 * Small from-scratch pieces: no prebuilt avatar or mention chip fits the
 * orb artwork and the canvas's tokens; they borrow shadcn Avatar's round,
 * clipped shape.
 */
import { useTheme } from "next-themes";

import { cn } from "@/shared/lib/utils";
import { orbFor } from "@/styles/theme/themes";

import { MENTION_TOKEN, splitAgentMentions } from "../../lib/agentMention";

/** The agent's avatar: the orb, still, on a soft primary disc. */
export function CanvasAgentAvatar({ className }: { className?: string }) {
  const { resolvedTheme } = useTheme();
  return (
    <span
      aria-hidden="true"
      data-canvas-agent-avatar=""
      className={cn(
        "flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary/10 ring-1 ring-primary/20",
        className,
      )}
    >
      <img
        src={orbFor(resolvedTheme)}
        alt=""
        draggable={false}
        className="size-[85%] object-contain"
      />
    </span>
  );
}

/** A comment body with its `@agent` tokens styled. */
export function CanvasMentionText({ body }: { body: string }) {
  return (
    <>
      {splitAgentMentions(body).map((part, index) =>
        part.mention ? (
          <span key={index} className={cn(MENTION_TOKEN, "px-1 py-px font-medium")}>
            {part.text}
          </span>
        ) : (
          part.text
        ),
      )}
    </>
  );
}

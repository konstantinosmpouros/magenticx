import { memo, useMemo } from "react";
import { motion } from "framer-motion";
import { Response } from "@/shared/ui/ai-elements/response";
import { Textarea } from "@/shared/ui/textarea";
import type { ContentBlock, MessageOut } from "@/shared/lib/types";
import { normalizeBulletMarkdown } from "@/shared/lib/utils";

// ContentBlockView — a timeline content block rendered as markdown. `streaming`
// while it is the live run's last block, i.e. text may still be arriving in it.
// Always an agent's text, so its `[src:…]` markers render as citation pills.
export const ContentBlockView = memo(
  ({ block, streaming = false }: { block: ContentBlock; streaming?: boolean }) => {
    const normalized = normalizeBulletMarkdown(block.text);
    if (!normalized.trim()) return null;
    return (
      <Response streaming={streaming} citations>
        {normalized}
      </Response>
    );
  },
);
ContentBlockView.displayName = "ContentBlockView";

type MessageContentProps = {
  message: MessageOut;
  isEditing: boolean;
  editingDraft?: string;
  editingBusy?: boolean;
  onChangeEditDraft?: (value: string) => void;
  onCancelEdit?: () => void;
  onSubmitEdit?: () => void;
};

/**
 * The slash command a user message ran (plan 35), shown highlighted in front of
 * its text, as inline code (which the message renderer draws as a highlight).
 * The command travels in `message.command`, never in the text, so this is the
 * only place it appears in the bubble.
 */
function markCommand(content: string, name: string | null): string {
  if (!name) return content;
  return `\`/${name}\` ${content}`.trimEnd();
}

export function MessageContent({
  message,
  isEditing,
  editingDraft,
  editingBusy,
  onChangeEditDraft,
  onCancelEdit,
  onSubmitEdit,
}: MessageContentProps) {
  const commandName = message.sender === "user" ? (message.command?.name ?? null) : null;
  const normalizedContent = useMemo(
    () => markCommand(normalizeBulletMarkdown(message.content ?? ""), commandName),
    [message.content, commandName],
  );

  if (isEditing) {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.2, delay: 0.08, ease: "easeOut" }}
      >
        <Textarea
          value={editingDraft ?? ""}
          onChange={(event) => onChangeEditDraft?.(event.target.value)}
          onKeyDown={(event) => {
            // A key that confirms an IME composition is not a send.
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Escape") {
              event.preventDefault();
              onCancelEdit?.();
              return;
            }

            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSubmitEdit?.();
            }
          }}
          // The caret goes to the end of the text, where an edit usually starts.
          onFocus={(event) => {
            const end = event.currentTarget.value.length;
            event.currentTarget.setSelectionRange(end, end);
          }}
          disabled={editingBusy}
          autoFocus
          aria-label="Edit your message"
          // field-sizing grows the box with its text, up to half the screen.
          className="w-full min-h-[2.5rem] max-h-[50vh] resize-none overflow-y-auto bg-transparent px-1 py-0.5 text-base leading-relaxed text-inherit [field-sizing:content] border-none shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:border-none focus-visible:outline-none"
        />
      </motion.div>
    );
  }

  const trimmed = normalizedContent.trim();

  if (!trimmed) {
    return null;
  }

  // An agent's stored reply may cite sources; a person's message is shown as typed.
  return <Response citations={message.sender === "ai"}>{normalizedContent}</Response>;
}

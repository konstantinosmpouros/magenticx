/**
 * The comment composer (plan 44, Phase 4.4): a few lines of text and a send
 * button — a new thread from the selection menu or the pill, a reply under a
 * thread, or one's own comment edited in place. Ctrl/Cmd+Enter sends, Esc
 * cancels; Enter is a new line, since a comment may need a few.
 *
 * `@agent` (plan 44 v2): with `mentions`, typing "@" offers "@agent" under
 * the field (Enter or Tab, or a click, takes it; Esc closes it), and a body
 * with the token says the agent will act on it. The token is tinted inside
 * the field too: a backdrop behind the (transparent) textarea repeats its
 * text with the token marked — a textarea cannot style part of its text.
 *
 * Built on the app's own Textarea and Button (shadcn) rather than Plate's
 * registry `comment-create-form`: that one is itself a Plate editor bound to
 * Plate's comment plugin, which stores comments as marks in the document — a
 * comment here is not part of the document (see `CanvasComments`). The
 * mention suggestion is written here because no prebuilt mention input
 * (shadcn, Radix, AI Elements) works on a plain textarea; Plate's mention
 * plugin would again need an editor.
 */
import { useEffect, useId, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";

import { CANVAS_COMMENT_LIMITS } from "@/shared/lib/schemas";
import { cn } from "@/shared/lib/utils";
import { Button } from "@/shared/ui/button";

import {
  AGENT_MENTION,
  MENTION_TOKEN,
  completeMention,
  hasAgentMention,
  mentionQuery,
  splitAgentMentions,
} from "../../lib/agentMention";
import { modKeyLabel } from "../../lib/shortcuts";
import { CanvasAgentAvatar } from "./CanvasAgentMention";
import { useKeepFieldInView } from "../../hooks/useKeepFieldInView";
import { CanvasHint } from "./CanvasHint";

/** The field's box, shared by the textarea and its backdrop so their text lines up. */
const FIELD_TEXT = "px-3 py-2 text-base leading-snug sm:text-sm";

export function CanvasCommentForm({
  label,
  placeholder,
  submitLabel = "Comment",
  initial = "",
  mentions = false,
  onSubmit,
  onCancel,
  className,
}: {
  /** The field's accessible name. */
  label: string;
  placeholder: string;
  submitLabel?: string;
  /** The text to start from (editing a comment). */
  initial?: string;
  /** Offer `@agent` (where a saved comment can ask the agent). */
  mentions?: boolean;
  onSubmit: (body: string) => void;
  onCancel: () => void;
  className?: string;
}) {
  const id = useId();
  const [draft, setDraft] = useState(initial);
  const [caret, setCaret] = useState<number | null>(null);
  // Esc closes the suggestion for the "@" being typed; a new "@" offers it again.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const body = draft.trim();
  const ready = body.length > 0 && body !== initial.trim();
  const keys = `${modKeyLabel()}Enter`;
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  // The box opens at the card's bottom: on a phone, bring it (and the send
  // button) into sight, again once the keyboard is up.
  useKeepFieldInView(formRef);
  // Editing: the caret starts at the end, not before the first word (once;
  // a later click places it where the user clicks).
  useEffect(() => {
    const field = fieldRef.current;
    if (field) field.setSelectionRange(field.value.length, field.value.length);
  }, []);

  const query = mentions && caret !== null ? mentionQuery(draft, caret) : null;
  const suggesting = query !== null && query.start !== dismissedAt;
  const mentioned = mentions && hasAgentMention(draft);

  const track = () => {
    const field = fieldRef.current;
    setCaret(field && field.selectionStart === field.selectionEnd ? field.selectionStart : null);
  };

  const pick = () => {
    if (!query) return;
    const next = completeMention(draft, query);
    setDraft(next.text);
    setCaret(next.caret);
    window.requestAnimationFrame(() => {
      const field = fieldRef.current;
      if (!field) return;
      field.focus();
      field.setSelectionRange(next.caret, next.caret);
    });
  };

  const submit = () => {
    if (ready) onSubmit(body);
  };

  return (
    <form
      ref={formRef}
      className={cn("flex flex-col gap-2", className)}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <div className="relative rounded-xl bg-background">
        {mentions ? (
          // The text again, under the field, with the token tinted.
          <div
            ref={backdropRef}
            aria-hidden="true"
            className={cn(
              FIELD_TEXT,
              "pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words rounded-xl border border-transparent text-transparent",
            )}
          >
            {splitAgentMentions(draft).map((part, index) =>
              part.mention ? (
                <mark key={index} className={cn(MENTION_TOKEN, "text-transparent")}>
                  {part.text}
                </mark>
              ) : (
                <span key={index}>{part.text}</span>
              ),
            )}
            {/* A last empty line still takes its height. */}
            {"​"}
          </div>
        ) : null}
        <textarea
          id={id}
          ref={fieldRef}
          autoFocus
          rows={2}
          maxLength={CANVAS_COMMENT_LIMITS.body}
          value={draft}
          aria-autocomplete={mentions ? "list" : undefined}
          aria-controls={suggesting ? `${id}-mention` : undefined}
          aria-activedescendant={suggesting ? `${id}-mention-agent` : undefined}
          data-mention-open={suggesting ? "" : undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            const field = event.target;
            setCaret(field.selectionStart === field.selectionEnd ? field.selectionStart : null);
          }}
          onSelect={track}
          onScroll={(event) => {
            if (backdropRef.current) backdropRef.current.scrollTop = event.currentTarget.scrollTop;
          }}
          onKeyDown={(event) => {
            if (suggesting && query && !event.metaKey && !event.ctrlKey) {
              if (event.key === "Enter" || event.key === "Tab") {
                event.preventDefault();
                pick();
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setDismissedAt(query.start);
                return;
              }
            }
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onCancel();
            } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder}
          className={cn(
            FIELD_TEXT,
            "relative block [field-sizing:content] max-h-40 min-h-[4.25rem] w-full resize-none rounded-xl border border-input bg-transparent text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
        />
      </div>

      {suggesting ? (
        <div id={`${id}-mention`} role="listbox" aria-label="Mention">
          <div
            id={`${id}-mention-agent`}
            role="option"
            aria-selected="true"
            // The field keeps the focus (and its caret).
            onMouseDown={(event) => event.preventDefault()}
            onClick={pick}
            className="flex min-h-10 cursor-pointer items-center gap-2 rounded-lg bg-muted/70 px-2 text-[13px] transition-colors duration-150 hover:bg-muted animate-in fade-in-0 duration-150 motion-reduce:animate-none [@media(pointer:coarse)]:min-h-11"
          >
            <CanvasAgentAvatar className="size-5" />
            <span className="font-medium text-foreground">{AGENT_MENTION}</span>
            <span className="truncate text-xs text-muted-foreground">
              Ask the agent to act on this
            </span>
            <kbd className="ml-auto hidden rounded border border-border/70 px-1 text-[10px] text-muted-foreground sm:inline">
              Enter
            </kbd>
          </div>
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-1.5">
        {mentioned ? (
          <span className="mr-auto flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <CanvasAgentAvatar className="size-4 ring-0" />
            <span className="truncate">The agent will act on this</span>
          </span>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 [@media(pointer:coarse)]:h-11"
          onClick={onCancel}
        >
          Cancel
        </Button>
        <CanvasHint label={submitLabel} keys={keys} side="top">
          <Button
            type="submit"
            size="sm"
            aria-disabled={!ready}
            className="h-8 gap-1.5 aria-disabled:opacity-45 [@media(pointer:coarse)]:h-11"
          >
            <ArrowUp className="size-4" aria-hidden="true" />
            {submitLabel}
          </Button>
        </CanvasHint>
      </div>
    </form>
  );
}

/**
 * The comment composer (plan 44, Phase 4.4): a few lines of text and a send
 * button — a new thread from the selection menu or the pill, a reply under a
 * thread, or one's own comment edited in place. Ctrl/Cmd+Enter sends, Esc
 * cancels; Enter is a new line, since a comment may need a few.
 *
 * Built on the app's own Textarea and Button (shadcn) rather than Plate's
 * registry `comment-create-form`: that one is itself a Plate editor bound to
 * Plate's comment plugin, which stores comments as marks in the document — a
 * comment here is not part of the document (see `CanvasComments`).
 */
import { useEffect, useId, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";

import { CANVAS_COMMENT_LIMITS } from "@/shared/lib/schemas";
import { cn } from "@/shared/lib/utils";
import { Button } from "@/shared/ui/button";

import { modKeyLabel } from "../../lib/shortcuts";
import { CanvasHint } from "./CanvasHint";

export function CanvasCommentForm({
  label,
  placeholder,
  submitLabel = "Comment",
  initial = "",
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
  onSubmit: (body: string) => void;
  onCancel: () => void;
  className?: string;
}) {
  const id = useId();
  const [draft, setDraft] = useState(initial);
  const body = draft.trim();
  const ready = body.length > 0 && body !== initial.trim();
  const keys = `${modKeyLabel()}Enter`;
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  // Editing: the caret starts at the end, not before the first word (once;
  // a later click places it where the user clicks).
  useEffect(() => {
    const field = fieldRef.current;
    if (field) field.setSelectionRange(field.value.length, field.value.length);
  }, []);

  const submit = () => {
    if (ready) onSubmit(body);
  };

  return (
    <form
      className={cn("flex flex-col gap-2", className)}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <textarea
        id={id}
        ref={fieldRef}
        autoFocus
        rows={2}
        maxLength={CANVAS_COMMENT_LIMITS.body}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
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
        className="[field-sizing:content] max-h-40 min-h-[4.25rem] w-full resize-none rounded-xl border border-input bg-background px-3 py-2 text-base leading-snug text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
      />
      <div className="flex items-center justify-end gap-1.5">
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

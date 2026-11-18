/**
 * Leaving a document with edits not saved (plan 44, Phase 4.2): the canvas
 * saves only when the user says so, so closing it, switching to another
 * document or restoring an old version first asks:
 *
 * - **Save:** save the edits as a new version, then go on;
 * - **Discard:** drop them (the editor goes back to the saved text), then go on;
 * - **Cancel** (or Esc): stay, with the edits as they are.
 *
 * A save that fails or meets a newer version keeps the user here: the header
 * shows Retry or Resolve, and nothing is left behind.
 */
import { useState } from "react";
import { CircleDot, Loader2 } from "lucide-react";

import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";

export function CanvasUnsavedDialog({
  open,
  title,
  onCancel,
  onSave,
  onDiscard,
}: {
  open: boolean;
  /** The document's title, for the question. */
  title: string;
  onCancel: () => void;
  /** Saves; resolves when the save has landed (or failed). */
  onSave: () => Promise<void>;
  onDiscard: () => void;
}) {
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onSave();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next || saving ? undefined : onCancel())}>
      <DialogContent className="max-w-md rounded-[1.4rem]">
        <DialogHeader className="text-left">
          <span className="mb-1 flex h-9 w-9 items-center justify-center rounded-xl bg-warning/15 text-warning">
            <CircleDot className="size-[18px]" aria-hidden="true" />
          </span>
          <DialogTitle className="text-base">Save your changes?</DialogTitle>
          <DialogDescription className="text-sm leading-relaxed">
            Your edits to “{title}” are not saved yet. Save them as a new version, or discard them.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:justify-between sm:space-x-0">
          <Button variant="ghost" className="sm:mr-auto" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="outline" onClick={onDiscard} disabled={saving}>
              Discard
            </Button>
            <Button onClick={() => void save()} disabled={saving} className="gap-1.5">
              {saving ? (
                <Loader2
                  className="size-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : null}
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

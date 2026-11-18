/**
 * A save refused because someone saved first (plan 44, Phase 4.2): the
 * agent's run or another tab wrote version n while the user was editing an
 * older one. Never last-write-wins — the user picks:
 *
 * - **Keep theirs:** the newer version replaces the editor's text;
 * - **Keep mine:** the user's text is saved again, on top of version n;
 * - **Compare:** both, as a diff, with the same two choices above it.
 *
 * Closing the dialog decides nothing: the header keeps a "Resolve" button.
 */
import { GitCompareArrows } from "lucide-react";

import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";

export function CanvasConflictDialog({
  open,
  version,
  byAgent,
  onOpenChange,
  onCompare,
  onKeepTheirs,
  onKeepMine,
}: {
  open: boolean;
  /** The newer version's number. */
  version: number;
  /** Whether the agent wrote it (else another tab of yours, or unknown). */
  byAgent: boolean | null;
  onOpenChange: (open: boolean) => void;
  onCompare: () => void;
  onKeepTheirs: () => void;
  onKeepMine: () => void;
}) {
  const who =
    byAgent === true ? "The agent" : byAgent === false ? "You (in another tab)" : "Someone";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md rounded-[1.4rem]">
        <DialogHeader className="text-left">
          <span className="mb-1 flex h-9 w-9 items-center justify-center rounded-xl bg-warning/15 text-warning">
            <GitCompareArrows className="size-[18px]" aria-hidden="true" />
          </span>
          <DialogTitle className="text-base">
            This document changed while you were editing
          </DialogTitle>
          <DialogDescription className="text-sm leading-relaxed">
            {who} saved version {version}. Your changes are not saved yet. Keep the newer version,
            or save yours on top of it.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:justify-between sm:space-x-0">
          <Button variant="ghost" className="gap-1.5 sm:mr-auto" onClick={onCompare}>
            <GitCompareArrows className="size-4" aria-hidden="true" />
            Compare
          </Button>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="outline" onClick={onKeepTheirs}>
              Keep theirs
            </Button>
            <Button onClick={onKeepMine}>Keep mine</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

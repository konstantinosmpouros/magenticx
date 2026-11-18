/**
 * How the canvas saves the user's edits as versions (plan 44, Phase 4.2),
 * as a plain object so its rules are testable without React or an editor:
 *
 * - **Saved only when the user says so** (the user, 2026-11-18): `flush()`
 *   runs on the Save button, Ctrl/Cmd+S, or a "Save" in the unsaved-changes
 *   dialog. An edit only marks the document unsaved; there is no autosave.
 * - **Never concurrent:** one save in flight per document. A flush that
 *   arrives meanwhile is queued, and runs with the latest text once the
 *   first one lands, so the second save is based on the first one's version.
 * - **Every save names its base:** the version the edit started from. A save
 *   refused with 409 holds the conflict until the user picks Keep theirs or
 *   Keep mine; nothing is ever overwritten silently.
 * - **No-op saves are skipped:** a text equal to the base's (after the same
 *   markdown round trip the editor applies) sends nothing.
 *
 * The text comes from `serialize`, attached by the live editor; it is only
 * read when a save is due, not on every keystroke.
 */
import type {
  CanvasDocumentAuthor,
  CanvasEditHead,
  CanvasSaveConflict,
  CanvasSaveResult,
  CanvasSaveState,
} from "@/shared/lib/types";

/**
 * After this long without an edit the text is compared with the saved one
 * again, so typing a space and deleting it (or undoing back) is "Saved".
 * Not on every keystroke: serializing a long document is not free.
 */
export const DIRTY_CHECK_DELAY_MS = 250;

export interface SaveControllerOptions {
  /** Send one save; resolves to the new version or a conflict, throws on any other failure. */
  save: (content: string, baseVersion: number) => Promise<CanvasSaveResult>;
  /** The base text as the editor would write it (markdown → editor → markdown). */
  normalize: (markdown: string) => string;
  /** Called whenever the state changes. */
  onState: (state: CanvasSaveState) => void;
  /** Called after each saved version (to refresh the version lists and the cache). */
  onSaved?: (saved: { version: number; createdAt: string; content: string }) => void;
}

const errorText = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : "The document could not be saved.";

export class SaveController {
  private readonly opts: SaveControllerOptions;
  private state: CanvasSaveState;
  /** The base version's text, normalized: what "unchanged" compares against. */
  private savedText: string;
  /** The editor's text as last read. */
  private text: string;
  private serializer: (() => string) | null = null;
  private inFlight: Promise<void> | null = null;
  private queued = false;
  private disposed = false;
  private dirtyCheck: ReturnType<typeof setTimeout> | null = null;

  constructor(base: CanvasEditHead & { markdown: string }, opts: SaveControllerOptions) {
    this.opts = opts;
    this.savedText = opts.normalize(base.markdown);
    this.text = this.savedText;
    this.state = { status: "saved", head: headOf(base), conflict: null, errorMessage: null };
  }

  get snapshot(): CanvasSaveState {
    return this.state;
  }

  /** The editor's current text (read now when the editor is attached). */
  currentText(): string {
    this.capture();
    return this.text;
  }

  /** Whether there is work a reload would lose: edits not saved, a save on its way or refused. */
  hasUnsavedWork(): boolean {
    if (this.state.status === "saving" || this.state.status === "conflict") return true;
    return this.currentText() !== this.savedText;
  }

  /** The live editor's serializer; `null` when it unmounts (its last text is kept). */
  attach(serialize: (() => string) | null): void {
    if (serialize === null) this.capture();
    this.serializer = serialize;
  }

  /** The user changed the text: mark it unsaved. Nothing is sent until `flush()`. */
  edited(): void {
    if (this.disposed) return;
    if (this.state.status === "saved") this.set({ status: "unsaved", errorMessage: null });
    if (this.dirtyCheck !== null) clearTimeout(this.dirtyCheck);
    this.dirtyCheck = setTimeout(() => {
      this.dirtyCheck = null;
      this.recheck();
    }, DIRTY_CHECK_DELAY_MS);
  }

  /** Back to "Saved" when the text is the saved one again (an edit undone). */
  private recheck(): void {
    if (this.disposed || this.state.status !== "unsaved") return;
    if (this.currentText() === this.savedText) this.set({ status: "saved", errorMessage: null });
  }

  /**
   * Throw the unsaved edits away (the unsaved-changes dialog's Discard): the
   * text goes back to the last saved version's, and a pending conflict is
   * dropped with them (the newer version loads on the next read). Returns
   * that text for the editor to remount with, or null while a save is in flight.
   */
  discard(): string | null {
    if (this.inFlight) return null;
    this.queued = false;
    this.serializer = null;
    this.text = this.savedText;
    this.set({ status: "saved", conflict: null, errorMessage: null });
    return this.savedText;
  }

  /**
   * Save now, if the text changed. With a save in flight this queues one more
   * (with the latest text) and resolves when the queue is empty.
   */
  flush(): Promise<void> {
    this.capture();
    if (this.inFlight) {
      this.queued = true;
      return this.inFlight;
    }
    if (this.state.status === "conflict") return Promise.resolve();
    this.inFlight = this.run().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Start over from `base` (a reload, Keep theirs): nothing unsaved, no conflict. */
  reset(base: CanvasEditHead & { markdown: string }): void {
    this.queued = false;
    this.savedText = this.opts.normalize(base.markdown);
    this.text = this.savedText;
    this.set({ status: "saved", head: headOf(base), conflict: null, errorMessage: null });
  }

  /** Keep theirs: the latest version becomes the editor's text. Returns it for the editor. */
  keepTheirs(author: CanvasDocumentAuthor = "agent"): string | null {
    const conflict = this.state.conflict;
    if (!conflict) return null;
    this.reset({
      version: conflict.currentVersion,
      // Who wrote it is not in the 409; the caller looks it up in the version list.
      author,
      createdAt: "",
      markdown: conflict.currentContent,
    });
    return conflict.currentContent;
  }

  /** Keep mine: save the refused text again, based on the version that won. */
  keepMine(): Promise<void> {
    const conflict = this.state.conflict;
    if (!conflict) return Promise.resolve();
    this.savedText = this.opts.normalize(conflict.currentContent);
    // The text is the editor's (it may have grown since the refusal), not
    // the refused copy: everything the user wrote is what they keep.
    this.capture();
    this.set({
      status: "unsaved",
      conflict: null,
      head: { version: conflict.currentVersion, author: "agent", createdAt: "" },
    });
    return this.flush();
  }

  /**
   * Replace the text and save it (Restore): the old text becomes a new
   * version based on the latest, so history is never rewritten. The editor is
   * remounted with `markdown` by the caller; until then its text is this.
   */
  replaceAndSave(markdown: string): Promise<void> {
    this.serializer = null;
    this.text = this.opts.normalize(markdown);
    this.set({ status: this.text === this.savedText ? "saved" : "unsaved" });
    return this.flush();
  }

  /**
   * Treat a newer version that arrived while the user had unsaved edits (the
   * agent's run, another tab) as a conflict: the same dialog decides.
   */
  adoptConflict(currentVersion: number, currentContent: string): void {
    this.queued = false;
    this.set({
      status: "conflict",
      conflict: { currentVersion, currentContent, mine: this.currentText() },
    });
  }

  dispose(): void {
    this.disposed = true;
    if (this.dirtyCheck !== null) clearTimeout(this.dirtyCheck);
    this.dirtyCheck = null;
  }

  // -- internals -------------------------------------------------------------

  private async run(): Promise<void> {
    do {
      this.queued = false;
      const text = this.text;
      if (text === this.savedText) {
        if (this.state.status !== "conflict") this.set({ status: "saved", errorMessage: null });
        return;
      }
      const base = this.state.head.version;
      this.set({ status: "saving", errorMessage: null });
      let result: CanvasSaveResult;
      try {
        result = await this.opts.save(text, base);
      } catch (error) {
        this.set({ status: "failed", errorMessage: errorText(error) });
        return;
      }
      if (result.kind === "conflict") {
        const conflict: CanvasSaveConflict = {
          currentVersion: result.currentVersion,
          currentContent: result.currentContent,
          mine: text,
        };
        this.queued = false;
        this.set({ status: "conflict", conflict });
        return;
      }
      this.savedText = text;
      this.capture();
      this.set({
        head: { version: result.version, author: "user", createdAt: result.createdAt },
        status: this.text === text ? "saved" : "unsaved",
      });
      this.opts.onSaved?.({ version: result.version, createdAt: result.createdAt, content: text });
    } while (this.queued && !this.disposed);
    if (this.text !== this.savedText && this.state.status === "saved")
      this.set({ status: "unsaved" });
  }

  private capture(): void {
    if (this.serializer) this.text = this.serializer();
  }

  private set(patch: Partial<CanvasSaveState>): void {
    this.state = { ...this.state, ...patch };
    this.opts.onState(this.state);
  }
}

const headOf = (base: CanvasEditHead): CanvasEditHead => ({
  version: base.version,
  author: base.author,
  createdAt: base.createdAt,
});

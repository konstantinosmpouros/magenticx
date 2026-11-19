/**
 * How the canvas saves the user's suggestion set (plan 44, Phase 4.6), beside
 * the `SaveController` that saves versions — as a plain object, so its rules
 * are testable without React or an editor:
 *
 * - **One set per document, saved only when the user says so** (Save,
 *   Ctrl/Cmd+S, the unsaved-changes dialog's Save) — or right after a ✓ / ✕
 *   decision, which the canvas saves at once. A suggestion typed and not
 *   saved is unsaved work, like an edit.
 * - **The set is the proposed text**: the document with every suggestion
 *   accepted, on the base version it was made on. Nothing suggested any more
 *   (all decided, or every insertion undone) → the set is deleted; the server
 *   deletes it too when a PUT equals its base (204).
 * - **A moved base is saved again**: when a version save (an accepted
 *   suggestion, an edit) moves the base, the remaining set is PUT on the new
 *   version even though its text did not change.
 * - **Never concurrent**: one request in flight; a flush that arrives
 *   meanwhile waits for it, then runs with the latest text.
 *
 * `clean` is the proposed text the server holds, as the editor writes it —
 * what "unchanged" compares against (null: the server holds none).
 */
import type { CanvasDocumentSuggestion, CanvasSuggestionSaveState } from "@/shared/lib/types";

import { DIRTY_CHECK_DELAY_MS } from "./saveController";

export interface SuggestionSaverOptions {
  /** PUT the set; null when the server found nothing suggested (204). Throws on failure. */
  put: (proposed: string, baseVersion: number) => Promise<CanvasDocumentSuggestion | null>;
  /** DELETE the set (idempotent). Throws on failure. */
  remove: () => Promise<void>;
  onState: (state: CanvasSuggestionSaveState) => void;
}

const errorText = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : "The suggestions could not be saved.";

export class SuggestionSaver {
  private readonly opts: SuggestionSaverOptions;
  private state: CanvasSuggestionSaveState = { status: "saved", errorMessage: null };
  private clean: string | null;
  /** The base version of the set the server holds, or null. */
  private serverBase: number | null;
  /** The editor's proposed text as last read (null: nothing suggested). */
  private proposed: string | null;
  private serializer: (() => string | null) | null = null;
  private inFlight: Promise<void> | null = null;
  private disposed = false;
  private dirtyCheck: ReturnType<typeof setTimeout> | null = null;

  constructor(
    start: { clean: string | null; serverBase: number | null },
    opts: SuggestionSaverOptions,
  ) {
    this.opts = opts;
    this.clean = start.clean;
    this.serverBase = start.serverBase;
    this.proposed = start.clean;
  }

  get snapshot(): CanvasSuggestionSaveState {
    return this.state;
  }

  /** The base version of the set the server holds (null: none). */
  get savedBase(): number | null {
    return this.serverBase;
  }

  /** The editor's proposed text, read now when the editor is attached. */
  currentProposed(): string | null {
    if (this.serializer) this.proposed = this.serializer();
    return this.proposed;
  }

  /** Suggestions not saved yet (or a save on its way). */
  isDirty(): boolean {
    return this.state.status === "saving" || this.currentProposed() !== this.clean;
  }

  /** The live editor's reader of the proposed text; `null` when it unmounts (its last text is kept). */
  attach(serialize: (() => string | null) | null): void {
    if (serialize === null) this.currentProposed();
    this.serializer = serialize;
  }

  /** The user changed the text: unsaved when the proposal differs (checked again after a pause). */
  edited(): void {
    if (this.disposed) return;
    if (this.dirtyCheck !== null) clearTimeout(this.dirtyCheck);
    this.dirtyCheck = setTimeout(() => {
      this.dirtyCheck = null;
      if (this.disposed || this.state.status === "saving") return;
      const dirty = this.currentProposed() !== this.clean;
      if (dirty && this.state.status === "saved") this.set({ status: "unsaved" });
      if (!dirty && this.state.status === "unsaved") this.set({ status: "saved" });
    }, DIRTY_CHECK_DELAY_MS);
  }

  /**
   * The editor will remount with `proposed` (a restore, a rebase): until it
   * attaches again, that is its proposed text.
   */
  replace(proposed: string | null): void {
    this.serializer = null;
    this.proposed = proposed;
  }

  /**
   * The text the server's set stands for changed without the user (rebased
   * onto the agent's newer version, or set aside as stale): `clean` follows,
   * so nothing shows as unsaved. The server keeps its set as it was.
   */
  rebased(clean: string | null): void {
    this.clean = clean;
    this.proposed = clean;
    this.serializer = null;
    this.set({ status: "saved", errorMessage: null });
  }

  /** Throw unsaved suggestions away: back to the saved set. Returns its text for the editor. */
  discard(): string | null {
    this.serializer = null;
    this.proposed = this.clean;
    this.set({ status: "saved", errorMessage: null });
    return this.clean;
  }

  /**
   * Save the set if it changed, or if the base moved (`baseMoved`: a version
   * was just saved under it): PUT on `headVersion`, or DELETE when nothing
   * is suggested any more.
   */
  async flush(headVersion: number, baseMoved = false): Promise<void> {
    while (this.inFlight) await this.inFlight;
    this.inFlight = this.run(headVersion, baseMoved).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Delete the server's set now, whatever the editor holds (Discard of stale suggestions, a silent clear). */
  async clearServer(): Promise<boolean> {
    while (this.inFlight) await this.inFlight;
    try {
      await this.opts.remove();
    } catch (error) {
      this.set({ status: "failed", errorMessage: errorText(error) });
      return false;
    }
    this.serverBase = null;
    if (this.currentProposed() === this.clean) this.proposed = null;
    this.clean = null;
    this.set({ status: this.currentProposed() === null ? "saved" : "unsaved", errorMessage: null });
    return true;
  }

  /**
   * The server no longer holds a set, and the user did not delete it: the
   * agent accepted or rejected it on their request (re-read when a run
   * ends). Returns true when the editor should drop the suggestions it shows
   * — they were the saved set, unchanged. Suggestions changed since that
   * save stay, now unsaved against no set; nothing held, nothing to do.
   */
  serverCleared(): boolean {
    if (this.serverBase === null && this.clean === null) return false;
    const unchanged = this.state.status !== "saving" && this.currentProposed() === this.clean;
    this.serverBase = null;
    this.clean = null;
    if (unchanged) {
      this.serializer = null;
      this.proposed = null;
      this.set({ status: "saved", errorMessage: null });
      return true;
    }
    this.set({ status: "unsaved", errorMessage: null });
    return false;
  }

  dispose(): void {
    this.disposed = true;
    if (this.dirtyCheck !== null) clearTimeout(this.dirtyCheck);
    this.dirtyCheck = null;
  }

  private async run(headVersion: number, baseMoved: boolean): Promise<void> {
    const proposed = this.currentProposed();
    const needed =
      proposed !== this.clean ||
      (proposed !== null && (baseMoved || this.serverBase === null)) ||
      (proposed === null && this.serverBase !== null);
    if (!needed) {
      if (this.state.status !== "saved") this.set({ status: "saved", errorMessage: null });
      return;
    }
    this.set({ status: "saving", errorMessage: null });
    try {
      if (proposed === null) {
        await this.opts.remove();
        this.serverBase = null;
      } else {
        const saved = await this.opts.put(proposed, headVersion);
        this.serverBase = saved ? headVersion : null;
      }
    } catch (error) {
      this.set({ status: "failed", errorMessage: errorText(error) });
      return;
    }
    this.clean = proposed;
    this.set({
      status: this.currentProposed() === this.clean ? "saved" : "unsaved",
      errorMessage: null,
    });
  }

  private set(patch: Partial<CanvasSuggestionSaveState>): void {
    this.state = { ...this.state, ...patch };
    this.opts.onState(this.state);
  }
}

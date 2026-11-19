import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  deleteDocumentSuggestion,
  putDocumentSuggestion,
  saveDocumentVersion,
} from "@/shared/lib/api";
import type {
  CanvasDocumentAuthor,
  CanvasDocumentVersion,
  CanvasEditorSource,
  CanvasEditorTexts,
  CanvasSaveState,
  CanvasStaleSuggestions,
  CanvasSuggestionSaveState,
  CanvasSuggestionStart,
} from "@/shared/lib/types";

import { normalizeMarkdown } from "../lib/markdown";
import { canvasContentKey, canvasListKey, canvasVersionsKey } from "../lib/queryKeys";
import { SaveController } from "../lib/saveController";
import { SuggestionSaver } from "../lib/suggestionSaver";
import { normalizeProposed, rebaseProposed } from "../lib/suggestions";

/** No suggestion set: what a caller that never loads one (and the tests) start from. */
const NO_SUGGESTIONS: CanvasSuggestionStart = { status: "ready", proposed: null, savedBase: null };

/** What carrying the user's suggestions onto another text came to. */
type Carried = { proposed: string | null } | { stale: true };

/**
 * Editing one canvas document (plan 44, Phase 4.2): the save controller of
 * the open document (saved only on the user's Save, single flight, base
 * version, 409 → conflict), the text the editor mounts with, and what happens when a newer
 * version arrives from outside (a finished agent run, another tab):
 *
 * - no unsaved edits → the editor reloads with it, silently;
 * - unsaved edits → `incoming` is set (the "The agent saved v5 — Review"
 *   banner); reviewing it opens the conflict dialog. The user's text is
 *   never overwritten without them choosing to.
 *
 * Own saves never count as "from outside": each one is written into the
 * query cache as the latest version, and remembered.
 *
 * Suggesting mode (Phase 4.6) adds the user's suggestion set beside the
 * versions (`SuggestionSaver`): the editor's value stands for two texts
 * (`CanvasEditorTexts`) — the document (every suggestion rejected), which
 * versions are saved from, and the proposal (every one accepted), which the
 * set is saved as. One Save saves both: a version when the document changed
 * (an edit, an accepted suggestion), then the set (PUT on the new base, or
 * DELETE when nothing is suggested). Unsaved suggestions are unsaved work.
 * When a newer version loads, the suggestions are carried onto it (jsdiff
 * rebase, `rebaseProposed`); when they no longer fit they are set aside as
 * `stale` (shown read-only by the canvas until discarded), and when the new
 * version already says what they proposed they are cleared silently.
 *
 * The caller keys the hook's component by document, so one controller lives
 * exactly as long as one open document. Closing or switching documents asks
 * first (the canvas's unsaved-changes dialog); only an unmount the canvas
 * cannot ask about (leaving the conversation) saves what is pending, so an
 * edit is never lost silently.
 */
export function useCanvasEditing({
  userId,
  conversationId,
  path,
  latest,
  authorOf,
  suggestions = NO_SUGGESTIONS,
}: {
  userId: string;
  conversationId: string;
  path: string;
  /** The latest version as read (null until it has loaded). */
  latest: CanvasDocumentVersion | null;
  /** Who wrote version n, when the version list knows. */
  authorOf: (version: number) => CanvasDocumentAuthor | null;
  /** The document's pending suggestions as opened; nothing starts while they load. */
  suggestions?: CanvasSuggestionStart;
}) {
  const queryClient = useQueryClient();
  const controllerRef = useRef<SaveController | null>(null);
  const saverRef = useRef<SuggestionSaver | null>(null);
  const ownVersions = useRef(new Set<number>());
  const [savedState, setSave] = useState<CanvasSaveState | null>(null);
  const [suggestionState, setSuggestionState] = useState<CanvasSuggestionSaveState | null>(null);
  const [sourceState, setSource] = useState<CanvasEditorSource | null>(null);
  const [incoming, setIncoming] = useState<CanvasDocumentVersion | null>(null);
  const [staleState, setStale] = useState<CanvasStaleSuggestions | null | undefined>(undefined);
  const initialSource = useRef<CanvasEditorSource | null>(null);
  const initialStale = useRef<CanvasStaleSuggestions | null>(null);
  const latestRef = useRef(latest);
  latestRef.current = latest;

  // The controllers exist from the first render with a latest version (and
  // the suggestions read), not an effect later: the editor mounts in that
  // same render and hands over its serializer from its own effect, which
  // runs before this component's. The constructors have no side effects.
  if (!controllerRef.current && latest && suggestions.status !== "loading") {
    const proposed = suggestions.status === "ready" ? suggestions.proposed : null;
    const clean = proposed === null ? null : normalizeProposed(latest.content, proposed);
    initialSource.current = {
      key: 0,
      markdown: latest.content,
      ...(proposed !== null && clean !== null ? { proposed } : {}),
    };
    if (suggestions.status === "stale") {
      const { status: _status, ...stale } = suggestions;
      initialStale.current = stale;
    }
    saverRef.current = new SuggestionSaver(
      {
        clean,
        serverBase:
          suggestions.status === "ready" ? suggestions.savedBase : suggestions.baseVersion,
      },
      {
        put: (content, baseVersion) =>
          putDocumentSuggestion(userId, conversationId, { path, baseVersion, content }),
        remove: () => deleteDocumentSuggestion(userId, conversationId, path),
        onState: setSuggestionState,
      },
    );
    controllerRef.current = new SaveController(
      {
        version: latest.version,
        author: latest.author,
        createdAt: latest.createdAt,
        markdown: latest.content,
      },
      {
        save: (content, baseVersion) =>
          saveDocumentVersion(userId, conversationId, { path, baseVersion, content }),
        normalize: normalizeMarkdown,
        onState: setSave,
        onSaved: ({ version, createdAt, content }) => {
          ownVersions.current.add(version);
          const base = latestRef.current;
          queryClient.setQueryData<CanvasDocumentVersion>(
            canvasContentKey(userId, conversationId, path, "latest"),
            {
              path,
              name: base?.name ?? path.slice(path.lastIndexOf("/") + 1),
              version,
              author: "user",
              baseVersion: version - 1,
              createdAt,
              sizeBytes: new TextEncoder().encode(content).length,
              content,
            },
          );
          void queryClient.invalidateQueries({ queryKey: canvasListKey(userId, conversationId) });
          void queryClient.invalidateQueries({
            queryKey: canvasVersionsKey(userId, conversationId, path),
          });
        },
      },
    );
  }
  const versionSave = savedState ?? controllerRef.current?.snapshot ?? null;
  const suggestionSave = suggestionState ?? saverRef.current?.snapshot ?? null;
  // The header shows one status: the versions', unless they are saved and the suggestions are not.
  const save: CanvasSaveState | null =
    versionSave &&
    suggestionSave &&
    versionSave.status === "saved" &&
    suggestionSave.status !== "saved"
      ? { ...versionSave, status: suggestionSave.status, errorMessage: suggestionSave.errorMessage }
      : versionSave;
  const source = sourceState ?? initialSource.current;
  const stale = staleState === undefined ? initialStale.current : staleState;

  const remount = useCallback((markdown: string, previous?: string, proposed?: string | null) => {
    setSource((current) => ({
      key: ((current ?? initialSource.current)?.key ?? 0) + 1,
      markdown,
      ...(previous !== undefined ? { previous } : {}),
      ...(proposed ? { proposed } : {}),
    }));
  }, []);

  /**
   * The user's suggestions, made on `fromText`, carried onto `toText` (a newer
   * version, a restore, theirs in a conflict): the proposed text on it; null
   * when there are none, or when `toText` already says what they proposed
   * (the set is then cleared silently); `stale` when they no longer fit.
   */
  const carry = useCallback((fromText: string, toText: string): Carried => {
    const saver = saverRef.current;
    const proposed = saver?.currentProposed() ?? null;
    if (!saver || proposed === null) return { proposed: null };
    const target = normalizeMarkdown(toText);
    const rebased = proposed === target ? target : rebaseProposed(fromText, proposed, toText);
    if (rebased === null) return { stale: true };
    if (rebased === target) {
      saver.rebased(null);
      void saver.clearServer();
      return { proposed: null };
    }
    saver.rebased(normalizeProposed(toText, rebased));
    return { proposed: rebased };
  }, []);

  /** Suggestions that no longer fit the text: shown read-only over their base until discarded. */
  const setAside = useCallback((base: string, baseVersion: number) => {
    const saver = saverRef.current;
    const proposed = saver?.currentProposed() ?? null;
    if (!saver || proposed === null) return;
    saver.rebased(null);
    setStale({ base, proposed, baseVersion: saver.savedBase ?? baseVersion });
  }, []);

  // A later latest version is either ours (ignored), or new from outside:
  // reloaded when nothing is unsaved (the suggestions carried onto it), else
  // the banner.
  useEffect(() => {
    const existing = controllerRef.current;
    if (!latest || !existing) return;
    if (ownVersions.current.has(latest.version)) return;
    if (latest.version <= existing.snapshot.head.version) return;
    if (existing.hasUnsavedWork() || saverRef.current?.isDirty()) {
      setIncoming(latest);
      return;
    }
    // The agent's version: what it changed shines once (`changeShine`).
    const before = existing.currentText();
    const previous = latest.author === "agent" ? before : undefined;
    const carried = carry(before, latest.content);
    if ("stale" in carried) setAside(before, existing.snapshot.head.version);
    existing.reset({
      version: latest.version,
      author: latest.author,
      createdAt: latest.createdAt,
      markdown: latest.content,
    });
    setIncoming(null);
    remount(latest.content, previous, "stale" in carried ? null : carried.proposed);
  }, [latest, remount, carry, setAside]);

  /**
   * Save everything unsaved: the document as a version when it changed, then
   * the suggestion set on the version that is now the base. A refused (409)
   * or failed version save stops there; the header shows Resolve / Retry.
   */
  const flushAll = useCallback(async () => {
    const ctl = controllerRef.current;
    const saver = saverRef.current;
    if (!ctl) return;
    const before = ctl.snapshot.head.version;
    await ctl.flush();
    if (!saver || ctl.snapshot.status === "conflict" || ctl.snapshot.status === "failed") return;
    const head = ctl.snapshot.head.version;
    await saver.flush(head, head !== before);
  }, []);

  // An unmount the canvas could not ask about (leaving the conversation)
  // saves what is pending rather than dropping it; after a Discard there is
  // nothing pending, so this sends nothing.
  useEffect(
    () => () => {
      const saver = saverRef.current;
      void flushAll().finally(() => saver?.dispose());
    },
    [flushAll],
  );

  // Unsaved work warns before the tab closes or reloads.
  const pending = Boolean(save && save.status !== "saved");
  useEffect(() => {
    if (!pending) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers need a returnValue to show the prompt.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pending]);

  const controller = () => controllerRef.current;

  return {
    save,
    source,
    incoming,
    /** Suggestions that no longer fit the document, read-only until discarded; null: none. */
    stale,
    /**
     * The live editor's reader of its two texts, or null when it unmounts (to
     * show an older version): its last texts become what it remounts with, so
     * coming back to the latest finds the user's edits and suggestions, not
     * the text it opened with.
     */
    attach: useCallback((serialize: (() => CanvasEditorTexts) | null) => {
      const ctl = controller();
      const saver = saverRef.current;
      if (!ctl) return;
      ctl.attach(serialize && (() => serialize().text));
      saver?.attach(serialize && (() => serialize().proposed));
      if (serialize === null) {
        const markdown = ctl.currentText();
        const proposed = saver?.currentProposed() ?? null;
        setSource((current) => {
          const base = current ?? initialSource.current;
          // No shine on coming back: only an agent version loading shines.
          return base ? { key: base.key, markdown, ...(proposed ? { proposed } : {}) } : base;
        });
      }
    }, []),
    edited: useCallback(() => {
      controller()?.edited();
      saverRef.current?.edited();
    }, []),
    flush: flushAll,
    /** Whether closing or switching now would lose an edit or a suggestion (asks first). */
    hasUnsavedWork: useCallback(
      () => (controller()?.hasUnsavedWork() ?? false) || (saverRef.current?.isDirty() ?? false),
      [],
    ),
    /** Throw the unsaved edits and suggestions away: the editor goes back to what is saved. */
    discard: useCallback(() => {
      const markdown = controller()?.discard() ?? null;
      const proposed = saverRef.current?.discard() ?? null;
      if (markdown !== null) remount(markdown, undefined, proposed);
    }, [remount]),
    /**
     * The server holds no suggestion set any more (re-read when a run ends:
     * the agent accepted or rejected it, on the user's request). The saved
     * suggestions the editor shows go, and so do any set aside as stale;
     * suggestions the user changed since stay, as unsaved work. An accepted
     * set comes back as the agent's new version, loaded like any other.
     */
    suggestionsCleared: useCallback(() => {
      const ctl = controllerRef.current;
      const saver = saverRef.current;
      if (!ctl || !saver) return;
      // Never set aside: left as it is (no render for nothing).
      setStale((current) => (current === undefined && initialStale.current === null ? current : null));
      if (saver.serverCleared()) remount(ctl.currentText(), undefined, null);
    }, [remount]),
    /** Discard suggestions set aside as stale: the server's set is deleted. */
    discardStale: useCallback(async () => {
      if (await saverRef.current?.clearServer()) setStale(null);
    }, []),
    currentText: useCallback(() => controller()?.currentText() ?? "", []),
    /**
     * The saved version the editor's text is based on, read now (not from the
     * last render): Ask agent sends it right after a Save may have moved it.
     */
    headVersion: useCallback(() => controller()?.snapshot.head.version ?? null, []),
    /** Keep theirs: load the version that won into the editor (the suggestions carried onto it). */
    keepTheirs: useCallback(() => {
      const ctl = controller();
      const conflict = ctl?.snapshot.conflict;
      if (!ctl || !conflict) return;
      const before = ctl.currentText();
      const carried = carry(before, conflict.currentContent);
      if ("stale" in carried) setAside(before, ctl.snapshot.head.version);
      const markdown = ctl.keepTheirs(authorOf(conflict.currentVersion) ?? "agent");
      setIncoming(null);
      if (markdown !== null)
        remount(markdown, undefined, "stale" in carried ? null : carried.proposed);
    }, [authorOf, remount, carry, setAside]),
    /** Keep mine: save the user's text again, on top of the version that won (then the suggestions). */
    keepMine: useCallback(async () => {
      setIncoming(null);
      const ctl = controller();
      if (!ctl) return;
      await ctl.keepMine();
      if (ctl.snapshot.status === "saved")
        await saverRef.current?.flush(ctl.snapshot.head.version, true);
    }, []),
    /** The banner's Review: the newer version and the user's text, in the conflict dialog. */
    reviewIncoming: useCallback(() => {
      const ctl = controller();
      const next = incoming;
      if (!ctl || !next) return;
      ctl.adoptConflict(next.version, next.content);
      setIncoming(null);
    }, [incoming]),
    /**
     * Restore an earlier version: save its text as a new version based on the
     * latest (pending edits are saved first), and show it in the editor. The
     * suggestions are carried onto it, or dropped when they no longer fit.
     */
    restore: useCallback(
      async (markdown: string) => {
        const ctl = controller();
        const saver = saverRef.current;
        if (!ctl) return;
        await flushAll();
        if (ctl.snapshot.status === "conflict" || ctl.snapshot.status === "failed") return;
        const carried = carry(ctl.currentText(), markdown);
        const proposed = "stale" in carried ? null : carried.proposed;
        saver?.replace(proposed === null ? null : normalizeProposed(markdown, proposed));
        remount(markdown, undefined, proposed);
        await ctl.replaceAndSave(markdown);
        if (saver && ctl.snapshot.status === "saved")
          await saver.flush(ctl.snapshot.head.version, true);
      },
      [remount, carry, flushAll],
    ),
  };
}

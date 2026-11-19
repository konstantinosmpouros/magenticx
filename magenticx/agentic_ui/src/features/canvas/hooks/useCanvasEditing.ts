import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { saveDocumentVersion } from "@/shared/lib/api";
import type {
  CanvasDocumentAuthor,
  CanvasDocumentVersion,
  CanvasEditorSource,
  CanvasSaveState,
} from "@/shared/lib/types";

import { normalizeMarkdown } from "../lib/markdown";
import { canvasContentKey, canvasListKey, canvasVersionsKey } from "../lib/queryKeys";
import { SaveController } from "../lib/saveController";

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
}: {
  userId: string;
  conversationId: string;
  path: string;
  /** The latest version as read (null until it has loaded). */
  latest: CanvasDocumentVersion | null;
  /** Who wrote version n, when the version list knows. */
  authorOf: (version: number) => CanvasDocumentAuthor | null;
}) {
  const queryClient = useQueryClient();
  const controllerRef = useRef<SaveController | null>(null);
  const ownVersions = useRef(new Set<number>());
  const [savedState, setSave] = useState<CanvasSaveState | null>(null);
  const [sourceState, setSource] = useState<CanvasEditorSource | null>(null);
  const [incoming, setIncoming] = useState<CanvasDocumentVersion | null>(null);
  const initialSource = useRef<CanvasEditorSource | null>(null);
  const latestRef = useRef(latest);
  latestRef.current = latest;

  // The controller exists from the first render with a latest version, not
  // an effect later: the editor mounts in that same render and hands over its
  // serializer from its own effect, which runs before this component's. The
  // constructor has no side effects (no timer, no state update).
  if (!controllerRef.current && latest) {
    initialSource.current = { key: 0, markdown: latest.content };
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
  const save = savedState ?? controllerRef.current?.snapshot ?? null;
  const source = sourceState ?? initialSource.current;

  const remount = useCallback((markdown: string, previous?: string) => {
    setSource((current) => ({
      key: ((current ?? initialSource.current)?.key ?? 0) + 1,
      markdown,
      ...(previous !== undefined ? { previous } : {}),
    }));
  }, []);

  // A later latest version is either ours (ignored), or new from outside:
  // reloaded when nothing is unsaved, else the banner.
  useEffect(() => {
    const existing = controllerRef.current;
    if (!latest || !existing) return;
    if (ownVersions.current.has(latest.version)) return;
    if (latest.version <= existing.snapshot.head.version) return;
    if (existing.hasUnsavedWork()) {
      setIncoming(latest);
      return;
    }
    // The agent's version: what it changed shines once (`changeShine`).
    const previous = latest.author === "agent" ? existing.currentText() : undefined;
    existing.reset({
      version: latest.version,
      author: latest.author,
      createdAt: latest.createdAt,
      markdown: latest.content,
    });
    setIncoming(null);
    remount(latest.content, previous);
  }, [latest, remount]);

  // An unmount the canvas could not ask about (leaving the conversation)
  // saves what is pending rather than dropping it; after a Discard there is
  // nothing pending, so this sends nothing.
  useEffect(
    () => () => {
      void controllerRef.current?.flush();
    },
    [],
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
    /**
     * The live editor's serializer, or null when it unmounts (to show an
     * older version): its last text becomes what it remounts with, so coming
     * back to the latest finds the user's edits, not the text it opened with.
     */
    attach: useCallback((serialize: (() => string) | null) => {
      const ctl = controller();
      if (!ctl) return;
      ctl.attach(serialize);
      if (serialize === null) {
        const markdown = ctl.currentText();
        setSource((current) => {
          const base = current ?? initialSource.current;
          // No shine on coming back: only an agent version loading shines.
          return base ? { key: base.key, markdown } : base;
        });
      }
    }, []),
    edited: useCallback(() => controller()?.edited(), []),
    flush: useCallback(() => controller()?.flush() ?? Promise.resolve(), []),
    /** Whether closing or switching now would lose an edit (asks first). */
    hasUnsavedWork: useCallback(() => controller()?.hasUnsavedWork() ?? false, []),
    /** Throw the unsaved edits away: the editor goes back to the saved text. */
    discard: useCallback(() => {
      const markdown = controller()?.discard() ?? null;
      if (markdown !== null) remount(markdown);
    }, [remount]),
    currentText: useCallback(() => controller()?.currentText() ?? "", []),
    /**
     * The saved version the editor's text is based on, read now (not from the
     * last render): Ask agent sends it right after a Save may have moved it.
     */
    headVersion: useCallback(() => controller()?.snapshot.head.version ?? null, []),
    /** Keep theirs: load the version that won into the editor. */
    keepTheirs: useCallback(() => {
      const ctl = controller();
      const conflict = ctl?.snapshot.conflict;
      if (!ctl || !conflict) return;
      const markdown = ctl.keepTheirs(authorOf(conflict.currentVersion) ?? "agent");
      setIncoming(null);
      if (markdown !== null) remount(markdown);
    }, [authorOf, remount]),
    /** Keep mine: save the user's text again, on top of the version that won. */
    keepMine: useCallback(() => {
      setIncoming(null);
      return controller()?.keepMine() ?? Promise.resolve();
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
     * Show `markdown` in the editor at once and save it as the user's version
     * on the current base (Suggesting mode: the agent's version with the
     * rejected suggestions put back). A 409 is the usual conflict.
     */
    replace: useCallback(
      (markdown: string) => {
        const ctl = controller();
        if (!ctl) return Promise.resolve();
        remount(markdown);
        return ctl.replaceAndSave(markdown);
      },
      [remount],
    ),
    /**
     * Restore an earlier version: save its text as a new version based on the
     * latest (pending edits are saved first), and show it in the editor.
     */
    restore: useCallback(
      async (markdown: string) => {
        const ctl = controller();
        if (!ctl) return;
        await ctl.flush();
        if (ctl.snapshot.status === "conflict" || ctl.snapshot.status === "failed") return;
        remount(markdown);
        await ctl.replaceAndSave(markdown);
      },
      [remount],
    ),
  };
}

/**
 * The document canvas (plan 44, Phases 4.1–4.5): one document of the
 * conversation, open beside the chat. Its header switches between the
 * conversation's documents and holds the save status (nothing once saved),
 * Export, full screen and close; the document row holds the outline, Find
 * (also Ctrl/Cmd+F); the byline's version chip opens the
 * version history. The body is the document in the editor
 * (`CanvasDocumentView`) — editable at its latest version, read-only at an
 * earlier one — or a compare of two versions, or its loading skeleton, a
 * failed load with Retry, or (when the document is gone) a way to the file's
 * normal preview.
 *
 * Ask agent (Phase 4.3): a selection's menu (or the pill's Ask agent) asks
 * the agent to change only that passage — sent as a user message of the
 * conversation (`onAskAgent`), on the saved latest version (unsaved edits ask
 * Save and send / Cancel first). Until that run ends the editor is read-only
 * and the passage tinted; then the agent's version is loaded before it
 * unlocks.
 *
 * Comments (Phase 4.4): a selection's menu (or the pill's Comment on touch)
 * starts a thread on the passage; its passage is painted in the text and a
 * 💬 count in the margin opens a card with the line's threads, as in Claude
 * Docs (no side panel). They are not edits: nothing about them is unsaved, and they
 * work while reading. Export (Phase 4.5) downloads a saved version as Word,
 * PDF or Markdown; with unsaved edits it asks Save and export / Export the
 * saved version / Cancel first.
 *
 * Edits are saved as the user's versions by `useCanvasEditing`, only when
 * the user saves (Save, Ctrl+S); closing, switching documents or restoring
 * with unsaved edits asks Save / Discard / Cancel first; a save refused with
 * 409 opens the conflict dialog. Each document
 * is its own session (keyed below), so a document's controller lives exactly
 * as long as it is open.
 *
 * The default export is what `CanvasDock` lazy-loads, so Plate, the markdown
 * pipeline and the diff stay out of the app's main chunk until a document
 * opens.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  CanvasAgentEdit,
  CanvasAnchorPlacement,
  CanvasAskControl,
  CanvasAskDraft,
  CanvasBylineValue,
  CanvasCommentControl,
  CanvasCommentMarks,
  CanvasCompareState,
  CanvasDocumentAuthor,
  CanvasEditRef,
  CanvasExportFormat,
  CanvasMode,
} from "@/shared/lib/types";
import { useToast } from "@/shared/hooks/use-toast";
import { toastError } from "@/shared/lib/toast";
import { Button } from "@/shared/ui/button";

import { useCanvasComments } from "../hooks/useCanvasComments";
import { useCanvasDocument } from "../hooks/useCanvasDocument";
import { useCanvasEditing } from "../hooks/useCanvasEditing";
import { useCanvasExport } from "../hooks/useCanvasExport";
import { useRequestedShine } from "../hooks/useRequestedShine";
import { useCanvasVersionText, useFetchCanvasVersionText } from "../hooks/useCanvasVersionText";
import { buildCanvasEdit } from "../lib/askAgent";
import { documentTitle } from "../lib/documentTitle";
import { isApplePlatform, isFindShortcut, isSaveShortcut } from "../lib/shortcuts";
import { CanvasCommentThreads, CanvasOtherComments } from "./canvas_parts/CanvasComments";
import { CanvasCompareView } from "./canvas_parts/CanvasCompareView";
import { CanvasConflictDialog } from "./canvas_parts/CanvasConflictDialog";
import { CanvasDocumentView } from "./canvas_parts/CanvasDocumentView";
import { CanvasExportPanel } from "./canvas_parts/CanvasExportPanel";
import { CanvasHeader } from "./canvas_parts/CanvasHeader";
import { CanvasHistory } from "./canvas_parts/CanvasHistory";
import { CanvasAgentEditingStatus, CanvasSaveStatus } from "./canvas_parts/CanvasSaveStatus";
import { CanvasUnsavedDialog } from "./canvas_parts/CanvasUnsavedDialog";
import {
  CanvasError,
  CanvasGone,
  CanvasIncomingBanner,
  CanvasSkeleton,
  CanvasVersionBanner,
} from "./canvas_parts/CanvasStates";

export interface DocumentCanvasProps {
  userId: string;
  conversationId: string;
  /** The open document's virtual path (`/conversation/output/….md`). */
  path: string;
  /** Changes when the conversation may hold new versions (see `useCanvasDocument`). */
  revision: string;
  /** Phone layout: always full screen, outline toggle in the header, opens for reading. */
  compact: boolean;
  /** Whether the full-screen toggle is offered (not when the canvas already covers the chat). */
  canToggleFullscreen: boolean;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onSelectPath: (path: string) => void;
  onClose: () => void;
  /** Opens the file in the normal preview; null when the conversation has no such file. */
  onPreviewFile: (() => void) | null;
  /**
   * Sends Ask agent's request as a user message of this conversation;
   * resolves true once the run has started. Absent where the canvas has no
   * conversation to send into (Ask agent is then not offered).
   */
  onAskAgent?: ((edit: CanvasEditRef) => Promise<boolean>) | null;
  /** A run of this conversation is going (Ask agent waits for it). */
  runActive?: boolean;
}

export default function DocumentCanvas(props: DocumentCanvasProps) {
  return <DocumentSession key={`${props.conversationId}|${props.path}`} {...props} />;
}

function DocumentSession({
  userId,
  conversationId,
  path,
  revision,
  compact,
  canToggleFullscreen,
  fullscreen,
  onToggleFullscreen,
  onSelectPath,
  onClose,
  onPreviewFile,
  onAskAgent = null,
  runActive = false,
}: DocumentCanvasProps) {
  const data = useCanvasDocument(userId, conversationId, path, revision);
  const [findOpen, setFindOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  // The side slot beside the document (a sheet on a phone): the history.
  const [historyOpen, setHistoryOpen] = useState(false);
  const closePanel = () => setHistoryOpen(false);
  // Desktop opens for editing; a phone opens for reading (✎ switches). Held
  // as "not chosen yet" until the user picks, because the phone check
  // settles after the first render.
  const [chosenMode, setMode] = useState<CanvasMode | null>(null);
  const mode: CanvasMode = chosenMode ?? (compact ? "viewing" : "editing");
  const [compareSelection, setCompareSelection] = useState<number[]>([]);
  const [compare, setCompare] = useState<CanvasCompareState | null>(null);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const { versions, loadVersions, refreshVersions } = data;
  const authorOf = useCallback(
    (version: number): CanvasDocumentAuthor | null =>
      versions?.find((meta) => meta.version === version)?.author ?? null,
    [versions],
  );
  const editing = useCanvasEditing({ userId, conversationId, path, latest: data.latest, authorOf });
  const { flush } = editing;
  const save = editing.save;
  const conflict = save?.conflict ?? null;
  const fetchVersionText = useFetchCanvasVersionText(userId, conversationId, path);
  // Opened from an Ask agent card: what that request changed shines once.
  const requestedShine = useRequestedShine(userId, conversationId, path, fetchVersionText);

  const shown = data.document;
  const name =
    shown?.name ??
    data.documents.find((doc) => doc.path === path)?.name ??
    path.slice(path.lastIndexOf("/") + 1);
  const title = documentTitle(name);

  // A refused save opens the dialog (once per conflict), and the version
  // list learns who wrote the version that won.
  const conflictVersion = conflict?.currentVersion ?? null;
  useEffect(() => {
    if (conflictVersion === null) return;
    setConflictOpen(true);
    refreshVersions();
  }, [conflictVersion, refreshVersions]);

  // Ctrl/Cmd+S saves now, wherever the focus is, while this document is open.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isSaveShortcut(event)) return;
      event.preventDefault();
      void flush();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flush]);

  // Ctrl/Cmd+F opens Find while the canvas has the focus (or was the last
  // place clicked); in the chat the browser's own find stays.
  const sectionRef = useRef<HTMLElement>(null);
  const canFind = Boolean(shown) && compare === null;
  useEffect(() => {
    let lastInside = false;
    const onDown = (event: PointerEvent) => {
      lastInside = Boolean(sectionRef.current?.contains(event.target as Node));
    };
    const onKey = (event: KeyboardEvent) => {
      if (!canFind || !isFindShortcut(event)) return;
      const target = event.target as Node | null;
      const inside = target !== null && Boolean(sectionRef.current?.contains(target));
      if (!inside && !(target === document.body && lastInside)) return;
      event.preventDefault();
      setFindOpen(true);
      window.requestAnimationFrame(() => document.getElementById("canvas-find")?.focus());
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [canFind]);

  // Saving is the user's call: an action that would drop unsaved edits
  // (close, another document, restore) asks Save / Discard / Cancel first.
  // Reading an older version or a compare keeps the edits, so needs no ask.
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const guard = (action: () => void) => {
    if (editing.hasUnsavedWork()) setPendingAction(() => action);
    else action();
  };
  const saveAndContinue = async () => {
    const action = pendingAction;
    await flush();
    setPendingAction(null);
    // A failed or refused save stays here; the header shows Retry / Resolve.
    if (action && !editing.hasUnsavedWork()) action();
  };
  const discardAndContinue = () => {
    const action = pendingAction;
    editing.discard();
    setPendingAction(null);
    action?.();
  };

  const leave = (then: () => void) => guard(then);

  // Ask agent (Phase 4.3). `agentEdit` is set from the send until the run it
  // started has ended and the agent's version is loaded.
  const [agentEdit, setAgentEdit] = useState<CanvasAgentEdit | null>(null);
  const [pendingAsk, setPendingAsk] = useState<CanvasAskDraft | null>(null);
  const sawRun = useRef(false);
  const { refreshLatest } = data;

  const sendAsk = async (draft: CanvasAskDraft) => {
    const version = editing.headVersion();
    if (!onAskAgent || version === null) return;
    sawRun.current = false;
    setAgentEdit({ phase: "sending", range: draft.passage.range });
    // The path as the documents API returned it: the bridge checks it is canonical.
    const documentPath = data.latest?.path ?? path;
    const started = await onAskAgent(buildCanvasEdit({ path: documentPath, version, draft }));
    setAgentEdit(started ? { phase: "running", range: draft.passage.range } : null);
  };

  const busy = runActive || agentEdit !== null;
  const ask: CanvasAskControl | null = onAskAgent
    ? {
        disabledReason: busy ? "Wait for the current reply" : null,
        onAsk: (draft) => {
          if (busy) return;
          // The agent reads the saved document: unsaved edits are saved first, on request.
          if (editing.hasUnsavedWork()) setPendingAsk(draft);
          else void sendAsk(draft);
        },
      }
    : null;

  const saveAndSend = async () => {
    const draft = pendingAsk;
    await flush();
    setPendingAsk(null);
    // A failed or refused save sends nothing; the header shows Retry / Resolve.
    if (draft && !editing.hasUnsavedWork()) void sendAsk(draft);
  };

  // The run ends: load what the agent saved, then unlock. A run never seen
  // going (it ended before this canvas re-rendered) ends the wait anyway.
  useEffect(() => {
    if (!agentEdit) return;
    if (runActive) {
      sawRun.current = true;
      return;
    }
    if (agentEdit.phase !== "running") return;
    let cancelled = false;
    const finish = () => {
      void refreshLatest().finally(() => {
        if (!cancelled) setAgentEdit(null);
      });
    };
    if (sawRun.current) {
      finish();
      return () => {
        cancelled = true;
      };
    }
    const timer = window.setTimeout(finish, 5000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [agentEdit, runActive, refreshLatest]);

  const selectDocument = (next: string) => {
    if (next === path) return;
    leave(() => onSelectPath(next));
  };

  const changeMode = (next: CanvasMode) => setMode(next);

  const viewVersion = (version: number) => {
    setCompare(null);
    data.pickVersion(version === data.latest?.version ? null : version);
    if (compact) closePanel();
  };

  const toggleCompare = (version: number) =>
    setCompareSelection((current) =>
      current.includes(version)
        ? current.filter((item) => item !== version)
        : [...current, version].slice(-2),
    );

  const openCompare = () => {
    const [from, to] = [...compareSelection].sort((a, b) => a - b);
    if (from === undefined || to === undefined) return;
    setCompare({ kind: "versions", from, to });
    if (compact) closePanel();
  };

  const restore = (version: number) => guard(() => void restoreNow(version));

  const restoreNow = async (version: number) => {
    setRestoring(true);
    try {
      const markdown = await fetchVersionText(version);
      data.pickVersion(null);
      setCompare(null);
      await editing.restore(markdown);
    } catch {
      // The read failed: nothing was saved; the history stays as it was.
    } finally {
      setRestoring(false);
    }
  };

  const compareConflict = () => {
    if (!conflict) return;
    setConflictOpen(false);
    setCompare({
      kind: "conflict",
      version: conflict.currentVersion,
      theirs: conflict.currentContent,
      mine: editing.currentText(),
    });
  };

  const keepTheirs = () => {
    setConflictOpen(false);
    setCompare(null);
    editing.keepTheirs();
  };

  const keepMine = () => {
    setConflictOpen(false);
    setCompare(null);
    void editing.keepMine();
  };

  const toggleHistory = () => {
    if (!historyOpen) loadVersions();
    setHistoryOpen((open) => !open);
  };

  // The version the user is looking at, saved: the editor's base while
  // editing the latest, else the earlier version on screen. Comments are made
  // on it, and Export reads it.
  const savedVersionShown = (): number | null =>
    data.isLatest ? (editing.headVersion() ?? shown?.version ?? null) : (shown?.version ?? null);

  // Comments (Phase 4.4).
  const comments = useCanvasComments(userId, conversationId, path);
  // The thread whose card is open (null: none), and a nonce that scrolls
  // its passage into view when bumped.
  const [active, setActive] = useState<{ id: string; nonce: number } | null>(null);
  const [focusNonce, setFocusNonce] = useState(0);
  const [placements, setPlacements] = useState<Record<string, CanvasAnchorPlacement> | null>(null);
  const openCard = (id: string) => setActive((current) => ({ id, nonce: current?.nonce ?? 0 }));
  const commentControl: CanvasCommentControl = {
    onCreate: (anchor, body) => {
      const version = savedVersionShown();
      if (version === null) return;
      // The new thread's card opens under its mark once it is saved.
      void comments.createThread(version, anchor, body).then((saved) => {
        if (saved) openCard(saved.id);
      });
    },
  };
  const detached = comments.open.filter((thread) => placements?.[thread.comment.id] === null);
  const otherCount = detached.length + comments.resolved.length;
  const marks: CanvasCommentMarks = {
    threads: comments.open,
    activeId: active?.id ?? null,
    focusNonce,
    onActivate: openCard,
    onOpen: (id) => {
      openCard(id);
      setFocusNonce((nonce) => nonce + 1);
    },
    onClose: () => setActive(null),
    renderThreads: (ids) => (
      <CanvasCommentThreads
        threads={comments.open.filter((thread) => ids.includes(thread.comment.id))}
        comments={comments}
      />
    ),
    others:
      otherCount > 0
        ? {
            count: otherCount,
            render: () => <CanvasOtherComments detached={detached} comments={comments} />,
          }
        : null,
    onPlaced: setPlacements,
  };

  // Export (Phase 4.5): a saved version; unsaved edits ask first.
  const exporter = useCanvasExport({
    userId,
    conversationId,
    path: data.latest?.path ?? path,
    title,
  });
  const { toast } = useToast();
  // Any saved version exports; unsaved edits never do (the panel says so,
  // with a Save first). Copy as Markdown reads that version's text.
  const exportVersion = (format: CanvasExportFormat, version: number | null) =>
    exporter.run(format, version ?? savedVersionShown());
  const copyMarkdown = async (version: number | null): Promise<boolean> => {
    try {
      const wanted = version ?? savedVersionShown();
      const text =
        wanted === null || wanted === data.latest?.version
          ? (data.latest?.content ?? "")
          : await fetchVersionText(wanted);
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      toastError(toast, "Couldn't copy the document", error);
      return false;
    }
  };

  const conflictAuthor = conflict ? authorOf(conflict.currentVersion) : null;
  const editingLatest = data.isLatest && save !== null;
  const byline: CanvasBylineValue | null = shown
    ? {
        version: editingLatest ? save.head.version : shown.version,
        author: editingLatest ? save.head.author : shown.author,
        createdAt: (editingLatest && save.head.createdAt) || shown.createdAt,
        isLatest: data.isLatest,
        historyOpen,
        onToggleHistory: toggleHistory,
      }
    : null;

  const view = {
    title,
    compact,
    findOpen,
    outlineOpen,
    onToggleFind: () => setFindOpen((open) => !open),
    onCloseFind: () => setFindOpen(false),
    onToggleOutline: () => setOutlineOpen((open) => !open),
    onCloseOutline: () => setOutlineOpen(false),
    mode,
    onModeChange: changeMode,
    comment: commentControl,
    marks,
  };

  const body = compare ? (
    <CompareBody
      compare={compare}
      userId={userId}
      conversationId={conversationId}
      path={path}
      onClose={() => setCompare(null)}
      onKeepTheirs={keepTheirs}
      onKeepMine={keepMine}
    />
  ) : shown && byline ? (
    <>
      {data.isLatest ? null : (
        <CanvasVersionBanner version={shown.version} onShowLatest={() => data.pickVersion(null)} />
      )}
      {data.isLatest && editing.incoming ? (
        <CanvasIncomingBanner
          version={editing.incoming.version}
          byAgent={editing.incoming.author === "agent"}
          onReview={editing.reviewIncoming}
        />
      ) : null}
      {data.isLatest && editing.source ? (
        <CanvasDocumentView
          key={`edit-${editing.source.key}`}
          {...view}
          markdown={editing.source.markdown}
          shineFrom={editing.source.previous ?? null}
          shineTexts={requestedShine}
          byline={byline}
          canEdit
          onAttach={editing.attach}
          onEdited={editing.edited}
          ask={ask}
          agentEdit={agentEdit}
        />
      ) : (
        <CanvasDocumentView
          key={`${shown.path}@${shown.version}`}
          {...view}
          markdown={shown.content}
          byline={byline}
          canEdit={false}
        />
      )}
    </>
  ) : data.gone ? (
    <CanvasGone onPreviewFile={onPreviewFile} onClose={onClose} />
  ) : data.errorMessage ? (
    <CanvasError message={data.errorMessage} onRetry={data.retry} />
  ) : (
    <CanvasSkeleton />
  );

  return (
    <section
      ref={sectionRef}
      aria-label={`Document: ${title}`}
      className="relative flex h-full min-h-0 w-full flex-col bg-background"
    >
      <CanvasHeader
        title={title}
        documents={data.documents}
        activePath={path}
        showOutlineToggle={compact}
        showFullscreenToggle={canToggleFullscreen}
        fullscreen={fullscreen}
        canFind={Boolean(shown)}
        status={
          agentEdit ? (
            <CanvasAgentEditingStatus compact={compact} />
          ) : save ? (
            <CanvasSaveStatus
              status={save.status}
              errorMessage={save.errorMessage}
              compact={compact}
              saveShortcut={isApplePlatform() ? "⌘S" : "Ctrl+S"}
              onSave={() => void flush()}
              onRetry={() => void flush()}
              onResolveConflict={() => setConflictOpen(true)}
            />
          ) : null
        }
        exportMenu={
          <CanvasExportPanel
            title={title}
            disabled={!shown}
            defaultVersion={savedVersionShown()}
            latestVersion={data.latest?.version ?? null}
            versions={data.versions}
            versionsLoading={data.versionsLoading}
            onLoadVersions={data.loadVersions}
            pending={exporter.pending}
            unsaved={Boolean(save && save.status !== "saved")}
            onSaveFirst={flush}
            onExport={exportVersion}
            onCopyMarkdown={copyMarkdown}
          />
        }
        onSelectDocument={selectDocument}
        onToggleOutline={() => setOutlineOpen((open) => !open)}
        onToggleFullscreen={onToggleFullscreen}
        onClose={() => leave(onClose)}
      />

      {/* A row: on desktop the history takes its own column, so the document
          and a compare narrow beside it instead of sliding under. */}
      <div className="relative flex min-h-0 flex-1">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">{body}</div>
        <CanvasHistory
          open={historyOpen}
          compact={compact}
          versions={data.versions}
          loading={data.versionsLoading}
          shownVersion={compare?.kind === "versions" ? null : (shown?.version ?? null)}
          compareSelection={compareSelection}
          restoring={restoring}
          canRestore={save?.status !== "conflict"}
          onView={viewVersion}
          onToggleCompare={toggleCompare}
          onCompare={openCompare}
          onRestore={(version) => void restore(version)}
          onClose={closePanel}
        />
      </div>

      <CanvasUnsavedDialog
        open={pendingAction !== null}
        title={title}
        onCancel={() => setPendingAction(null)}
        onSave={saveAndContinue}
        onDiscard={discardAndContinue}
      />

      <CanvasUnsavedDialog
        open={pendingAsk !== null}
        title={title}
        purpose="send"
        onCancel={() => setPendingAsk(null)}
        onSave={saveAndSend}
      />

      {conflict ? (
        <CanvasConflictDialog
          open={conflictOpen}
          version={conflict.currentVersion}
          byAgent={conflictAuthor === null ? null : conflictAuthor === "agent"}
          onOpenChange={setConflictOpen}
          onCompare={compareConflict}
          onKeepTheirs={keepTheirs}
          onKeepMine={keepMine}
        />
      ) : null}
    </section>
  );
}

/** The compare view's data: two versions' texts, or the conflict's two texts. */
function CompareBody({
  compare,
  userId,
  conversationId,
  path,
  onClose,
  onKeepTheirs,
  onKeepMine,
}: {
  compare: CanvasCompareState;
  userId: string;
  conversationId: string;
  path: string;
  onClose: () => void;
  onKeepTheirs: () => void;
  onKeepMine: () => void;
}) {
  const versions = compare.kind === "versions";
  const before = useCanvasVersionText(userId, conversationId, path, versions ? compare.from : null);
  const after = useCanvasVersionText(userId, conversationId, path, versions ? compare.to : null);

  if (compare.kind === "conflict") {
    return (
      <CanvasCompareView
        fromLabel={`v${compare.version} (theirs)`}
        toLabel="Your unsaved text"
        before={compare.theirs}
        after={compare.mine}
        onClose={onClose}
        actions={
          <>
            <Button size="sm" variant="outline" onClick={onKeepTheirs}>
              Keep theirs
            </Button>
            <Button size="sm" onClick={onKeepMine}>
              Keep mine
            </Button>
          </>
        }
      />
    );
  }
  return (
    <CanvasCompareView
      fromLabel={`v${compare.from}`}
      toLabel={`v${compare.to}`}
      before={before}
      after={after}
      onClose={onClose}
    />
  );
}

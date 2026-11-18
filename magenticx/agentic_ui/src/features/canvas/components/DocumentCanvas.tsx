/**
 * The document canvas (plan 44, Phases 4.1–4.2): one document of the
 * conversation, open beside the chat. Its header switches between the
 * conversation's documents and holds the save status, find, history, full
 * screen and close; the body is the document in the editor
 * (`CanvasDocumentView`) — editable at its latest version, read-only at an
 * earlier one — or a compare of two versions, or its loading skeleton, a
 * failed load with Retry, or (when the document is gone) a way to the file's
 * normal preview.
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
import { useCallback, useEffect, useState } from "react";

import type {
  CanvasBylineValue,
  CanvasCompareState,
  CanvasDocumentAuthor,
  CanvasMode,
} from "@/shared/lib/types";
import { Button } from "@/shared/ui/button";

import { useCanvasDocument } from "../hooks/useCanvasDocument";
import { useCanvasEditing } from "../hooks/useCanvasEditing";
import { useCanvasVersionText, useFetchCanvasVersionText } from "../hooks/useCanvasVersionText";
import { documentTitle } from "../lib/documentTitle";
import { isApplePlatform, isSaveShortcut } from "../lib/shortcuts";
import { CanvasCompareView } from "./canvas_parts/CanvasCompareView";
import { CanvasConflictDialog } from "./canvas_parts/CanvasConflictDialog";
import { CanvasDocumentView } from "./canvas_parts/CanvasDocumentView";
import { CanvasHeader } from "./canvas_parts/CanvasHeader";
import { CanvasHistory } from "./canvas_parts/CanvasHistory";
import { CanvasSaveStatus } from "./canvas_parts/CanvasSaveStatus";
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
}: DocumentCanvasProps) {
  const data = useCanvasDocument(userId, conversationId, path, revision);
  const [findOpen, setFindOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
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

  const selectDocument = (next: string) => {
    if (next === path) return;
    leave(() => onSelectPath(next));
  };

  const changeMode = (next: CanvasMode) => setMode(next);

  const viewVersion = (version: number) => {
    setCompare(null);
    data.pickVersion(version === data.latest?.version ? null : version);
    if (compact) setHistoryOpen(false);
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
    if (compact) setHistoryOpen(false);
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

  const conflictAuthor = conflict ? authorOf(conflict.currentVersion) : null;
  const editingLatest = data.isLatest && save !== null;
  const byline: CanvasBylineValue | null = shown
    ? {
        version: editingLatest ? save.head.version : shown.version,
        author: editingLatest ? save.head.author : shown.author,
        createdAt: (editingLatest && save.head.createdAt) || shown.createdAt,
        isLatest: data.isLatest,
        versions: data.versions,
        versionsLoading: data.versionsLoading,
        onLoadVersions: data.loadVersions,
        onPickVersion: (version) =>
          version === null ? data.pickVersion(null) : viewVersion(version),
      }
    : null;

  const view = {
    title,
    compact,
    findOpen,
    outlineOpen,
    onCloseFind: () => setFindOpen(false),
    onToggleOutline: () => setOutlineOpen((open) => !open),
    onCloseOutline: () => setOutlineOpen(false),
    mode,
    onModeChange: changeMode,
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
          byline={byline}
          canEdit
          onAttach={editing.attach}
          onEdited={editing.edited}
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
        findOpen={findOpen}
        canFind={Boolean(shown)}
        historyOpen={historyOpen}
        status={
          save && (mode === "editing" || save.status !== "saved") ? (
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
        onSelectDocument={selectDocument}
        onToggleOutline={() => setOutlineOpen((open) => !open)}
        onToggleFind={() => setFindOpen((open) => !open)}
        onToggleHistory={() => {
          if (!historyOpen) loadVersions();
          setHistoryOpen((open) => !open);
        }}
        onToggleFullscreen={onToggleFullscreen}
        onClose={() => leave(onClose)}
      />

      {/* A row: on desktop the history panel takes its own column, so the
          document and a compare narrow beside it instead of sliding under. */}
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
          onClose={() => setHistoryOpen(false)}
        />
      </div>

      <CanvasUnsavedDialog
        open={pendingAction !== null}
        title={title}
        onCancel={() => setPendingAction(null)}
        onSave={saveAndContinue}
        onDiscard={discardAndContinue}
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

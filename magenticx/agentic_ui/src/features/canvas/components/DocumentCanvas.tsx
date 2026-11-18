/**
 * The document canvas (plan 44, Phase 4.1): one document of the conversation,
 * open beside the chat, read-only. Its header switches between the
 * conversation's documents and holds find, full screen and close; the body is
 * the document itself (`CanvasDocumentView`), or its loading skeleton, a
 * failed load with Retry, or — when the document is gone — a way to the
 * file's normal preview.
 *
 * The default export is what `CanvasDock` lazy-loads, so Plate and the
 * markdown pipeline stay out of the app's main chunk until a document opens.
 */
import { useState } from "react";

import type { CanvasBylineValue } from "@/shared/lib/types";

import { useCanvasDocument } from "../hooks/useCanvasDocument";
import { documentTitle } from "../lib/documentTitle";
import { CanvasDocumentView } from "./canvas_parts/CanvasDocumentView";
import { CanvasHeader } from "./canvas_parts/CanvasHeader";
import {
  CanvasError,
  CanvasGone,
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
  /** Phone layout: always full screen, outline toggle in the header. */
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

export default function DocumentCanvas({
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
  const shown = data.document;

  const name =
    shown?.name ??
    data.documents.find((doc) => doc.path === path)?.name ??
    path.slice(path.lastIndexOf("/") + 1);
  const title = documentTitle(name);

  const byline: CanvasBylineValue | null = shown
    ? {
        version: shown.version,
        author: shown.author,
        createdAt: shown.createdAt,
        isLatest: data.isLatest,
        versions: data.versions,
        versionsLoading: data.versionsLoading,
        onLoadVersions: data.loadVersions,
        onPickVersion: data.pickVersion,
      }
    : null;

  const selectDocument = (next: string) => {
    if (next === path) return;
    setFindOpen(false);
    setOutlineOpen(false);
    onSelectPath(next);
  };

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
        onSelectDocument={selectDocument}
        onToggleOutline={() => setOutlineOpen((open) => !open)}
        onToggleFind={() => setFindOpen((open) => !open)}
        onToggleFullscreen={onToggleFullscreen}
        onClose={onClose}
      />

      {shown && byline ? (
        <>
          {data.isLatest ? null : (
            <CanvasVersionBanner
              version={shown.version}
              onShowLatest={() => data.pickVersion(null)}
            />
          )}
          <CanvasDocumentView
            key={`${shown.path}@${shown.version}`}
            markdown={shown.content}
            title={title}
            byline={byline}
            compact={compact}
            findOpen={findOpen}
            outlineOpen={outlineOpen}
            onCloseFind={() => setFindOpen(false)}
            onToggleOutline={() => setOutlineOpen((open) => !open)}
            onCloseOutline={() => setOutlineOpen(false)}
          />
        </>
      ) : data.gone ? (
        <CanvasGone onPreviewFile={onPreviewFile} onClose={onClose} />
      ) : data.errorMessage ? (
        <CanvasError message={data.errorMessage} onRetry={data.retry} />
      ) : (
        <CanvasSkeleton />
      )}
    </section>
  );
}

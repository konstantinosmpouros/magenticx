/**
 * One version of a document, in the editor: the find bar, the sticky row
 * with the outline and the mode menu, the serif title with its byline and
 * the reading column, the outline panel over the left of the text and, while
 * editing, the floating toolbar at the bottom (plan 44, Phases 4.1–4.2).
 *
 * Built on Plate (`platejs`): the markdown is parsed once into the editor
 * value (`lib/markdown.ts`), and the parent remounts this view (by key) for
 * another document, an earlier version or a reload, rather than replacing
 * the value of a live editor. Editing toggles Plate's `readOnly` without a
 * remount, so switching modes keeps the caret, the folds and the undo stack.
 *
 * Saving is not this view's business: it hands its serializer to the parent
 * (`onAttach`) and reports edits and blur; the save controller decides when
 * to read the text and send it.
 *
 * Comments (Phase 4.4) are painted here, not stored here: the view finds
 * each open thread's quote in its text (`lib/commentAnchors.ts`), reports
 * where (or "detached") to the parent, paints the passages with the CSS
 * Custom Highlight API (`lib/commentHighlight.ts`), and measures them to
 * place the marks in the right margin (`CanvasCommentMarkers`): a bubble and
 * a count beside each commented line, opening a card with its threads. Only
 * the mark opens a card: a click on a painted passage is a click into the
 * text. The comments with no line are behind the document row's button.
 *
 * While the agent writes this document (plan 44 v2, `agentWriting`) the
 * editor is read-only, as during Ask agent, and an accent bar with "Agent is
 * writing here" marks the block it is changing (found by `edit_file`'s
 * `old_string`), or the top of the document when there is no such block.
 *
 * With a mouse, the selection bar floats over selected text
 * (`CanvasSelectionMenu`) and the orb at the caret (`CanvasCaretOrb`) offers
 * Ask agent for the block the caret rests in.
 *
 * A Suggesting review (plan 44, Phase 4.6, `review`) mounts the view on the
 * review's value (the agent's changes marked as suggestions), read-only,
 * with the suggestions bar under the document row and a check / cross pill on
 * each suggestion. Each decision swaps the value in place (`setValue`), so
 * the page stays where it is; nothing here is attached to the save controller.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Value } from "platejs";
import { Plate, usePlateEditor } from "platejs/react";
import { Loader2, PencilLine } from "lucide-react";

import type {
  CanvasAgentEdit,
  CanvasAgentWriting,
  CanvasAnchorPlacement,
  CanvasAskPassage,
  CanvasAskControl,
  CanvasBylineValue,
  CanvasCommentAnchor,
  CanvasCommentControl,
  CanvasCommentMarker,
  CanvasCommentMarks,
  CanvasMode,
  CanvasShineTexts,
  CanvasSuggestionReview,
} from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";
import { Editor, EditorContainer } from "@/shared/ui/plate/editor";

import { useCoarsePointer } from "../../hooks/useCoarsePointer";
import { CanvasBylineContext } from "../../lib/bylineContext";
import { canvasViewPlugin, refreshFolds, setFolds } from "../../lib/canvasView";
import { CANVAS_NODE_ID, canvasEditorPlugins, findPlugin } from "../../lib/editorKit";
import { headingPathAt } from "../../lib/askAgent";
import { showAskHighlight } from "../../lib/askHighlight";
import {
  buildTextIndex,
  locateAnchor,
  placementRange,
  type CanvasTextIndex,
} from "../../lib/commentAnchors";
import { paintCommentHighlights, scrollBehavior } from "../../lib/commentHighlight";
import { measureCommentMarkers } from "../../lib/commentMarkers";
import { countMatches } from "../../lib/find";
import { markdownToValue, valueToMarkdown } from "../../lib/markdown";
import { shineChanges, shineTexts as shineTextsIn } from "../../lib/changeShine";
import { getHiddenBlocks, getOutline } from "../../lib/outline";
import { CanvasByline } from "./CanvasByline";
import { CanvasCaretOrb } from "./CanvasCaretOrb";
import { CanvasCommentMarkers } from "./CanvasCommentMarkers";
import { CanvasReadingCommentBar } from "./CanvasCommentButton";
import { CanvasDocBar } from "./CanvasDocBar";
import { CanvasFindBar } from "./CanvasFindBar";
import { CanvasOutline } from "./CanvasOutline";
import { CanvasSelectionMenu } from "./CanvasSelectionMenu";
import {
  CanvasSuggestionBar,
  CanvasSuggestionControls,
  type CanvasSuggestionSpot,
} from "./CanvasSuggestionBar";
import { CanvasToolbar } from "./CanvasToolbar";

/** An empty document still needs one block for Plate to render. */
const EMPTY_DOCUMENT: Value = [{ type: "p", children: [{ text: "" }] }];

/**
 * Where `passage` (a line of the agent's `old_string`, as it reads) is in the
 * text: the whole line, else its start (the rest may differ by formatting
 * the plain-text reading drops).
 */
function findWritingPlacement(
  index: CanvasTextIndex,
  passage: string,
): { start: number; end: number } | null {
  for (const length of [passage.length, 40, 20]) {
    const probe = passage.slice(0, length).trim();
    if (probe.length < Math.min(8, passage.length)) continue;
    const at = index.text.indexOf(probe);
    if (at !== -1) return { start: at, end: at + probe.length };
  }
  return null;
}

export function CanvasDocumentView({
  markdown,
  title,
  byline,
  compact,
  findOpen,
  outlineOpen,
  onToggleFind,
  onCloseFind,
  onToggleOutline,
  onCloseOutline,
  mode,
  canEdit,
  onModeChange,
  onAttach,
  onEdited,
  onBlur,
  ask = null,
  comment = null,
  marks = null,
  agentEdit = null,
  agentWriting = null,
  onAttachPassages,
  shineFrom = null,
  shineTexts = null,
  review = null,
}: {
  markdown: string;
  /** The document's title, for the editor's accessible name. */
  title: string;
  byline: CanvasBylineValue;
  /** Phone layout: the outline toggle lives in the header, not the document row. */
  compact: boolean;
  findOpen: boolean;
  outlineOpen: boolean;
  /** Find's button in the document row (Ctrl/Cmd+F opens it too). */
  onToggleFind: () => void;
  onCloseFind: () => void;
  onToggleOutline: () => void;
  onCloseOutline: () => void;
  mode: CanvasMode;
  /** The latest version can be edited; an earlier one is read-only. */
  canEdit: boolean;
  /** `remember: false` for a quick switch that should not become the default (the phone's pencil). */
  onModeChange: (mode: CanvasMode, remember?: boolean) => void;
  /** Receives the editor's serializer on mount, null on unmount (editable views only). */
  onAttach?: (serialize: (() => string) | null) => void;
  onEdited?: () => void;
  onBlur?: () => void;
  /** Ask agent on a selection (Phase 4.3), where the canvas can send one. */
  ask?: CanvasAskControl | null;
  /** Comment on a selection (Phase 4.4), editing or reading. */
  comment?: CanvasCommentControl | null;
  /** The open threads to paint in the text, their margin marks and cards. */
  marks?: CanvasCommentMarks | null;
  /** The agent is changing a passage: the editor is read-only and the passage tinted. */
  agentEdit?: CanvasAgentEdit | null;
  /** The agent is writing this document now (its tool call): read-only, and marked where. */
  agentWriting?: CanvasAgentWriting | null;
  /**
   * Receives, on mount, how to turn a comment's anchor into a passage of this
   * text (`@agent` asks with it); null on unmount.
   */
  onAttachPassages?: (
    resolve: ((anchor: CanvasCommentAnchor) => CanvasAskPassage | null) | null,
  ) => void;
  /** The text before the agent's version loaded: its changed blocks shine once on mount. */
  shineFrom?: string | null;
  /** Blocks to shine by their text (opened from an Ask agent card); a new id shines again. */
  shineTexts?: CanvasShineTexts | null;
  /** Suggesting mode: the agent's changes to review; the view is read-only meanwhile. */
  review?: CanvasSuggestionReview | null;
}) {
  // Parsed once per mount: the parent remounts the view for new text.
  const [initial] = useState(() => {
    if (review) return review.value;
    const parsed = markdownToValue(markdown);
    return parsed.length > 0 ? parsed : EMPTY_DOCUMENT;
  });
  const editor = usePlateEditor({
    plugins: canvasEditorPlugins,
    value: initial,
    nodeId: CANVAS_NODE_ID,
  });
  const [value, setValue] = useState<Value>(initial);
  const [query, setQuery] = useState("");
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Suggesting edits like Editing once nothing is left to review.
  const editing = canEdit && mode !== "viewing" && review === null;
  // While the agent changes a passage nobody else writes: no conflict mid-run.
  const agentBusy = agentEdit !== null || agentWriting !== null;
  const writable = editing && !agentBusy;
  const agentRange = agentEdit?.range ?? null;
  // The orb at the caret is a mouse's way in; touch has the pill's Ask agent.
  const coarse = useCoarsePointer();

  const outline = useMemo(() => (outlineOpen ? getOutline(value) : []), [value, outlineOpen]);
  const titleFirst = value[0]?.type === "h1";

  // The serializer reads the live value only when a save is due.
  useEffect(() => {
    if (!canEdit || !onAttach) return;
    onAttach(() => valueToMarkdown(editor.children as Value));
    return () => onAttach(null);
  }, [editor, canEdit, onAttach]);

  useEffect(
    () => (agentRange ? showAskHighlight(editor, agentRange) : undefined),
    [editor, agentRange],
  );

  // `@agent` in a comment asks about the thread's passage: found here, in
  // this text, like the painting below; null when its quote is gone.
  useEffect(() => {
    if (!onAttachPassages) return;
    onAttachPassages((anchor) => {
      const index = buildTextIndex(editor);
      const placement = locateAnchor(index.text, anchor);
      const range = placement ? placementRange(index, placement) : null;
      if (!range) return null;
      return {
        text: anchor.quote,
        headingPath: headingPathAt(editor, range.anchor.path[0]),
        range: structuredClone(range),
      };
    });
    return () => onAttachPassages(null);
  }, [editor, onAttachPassages]);

  // Once, after the first paint of an agent's version: shine what changed.
  // The text is read from a ref: the view remounts for each new version.
  const shineFromRef = useRef(shineFrom);
  useEffect(() => {
    const previous = shineFromRef.current;
    if (!previous) return;
    let stop: () => void = () => undefined;
    const frame = window.requestAnimationFrame(() => {
      stop = shineChanges(editor, previous);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      stop();
    };
  }, [editor]);

  // Asked from the chat (an Ask agent card): shine that request's change.
  useEffect(() => {
    if (!shineTexts || shineTexts.texts.length === 0) return;
    let stop: () => void = () => undefined;
    const frame = window.requestAnimationFrame(() => {
      stop = shineTextsIn(editor, shineTexts.texts);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      stop();
    };
  }, [editor, shineTexts]);

  useEffect(() => {
    editor.setOption(findPlugin, "search", findOpen ? query : "");
    editor.api.redecorate();
  }, [editor, query, findOpen]);

  // Comments: where each open thread's quote is in this text, reported to
  // the panel ("detached" when it is gone), and painted.
  const threads = marks?.threads;
  const onPlaced = marks?.onPlaced;
  const textIndex = useMemo(
    () => buildTextIndex(editor),
    // The index reads the editor's children, which `value` follows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor, value],
  );
  const placements = useMemo(() => {
    const found: Record<string, CanvasAnchorPlacement> = {};
    for (const thread of threads ?? []) {
      if (thread.comment.anchor) {
        found[thread.comment.id] = locateAnchor(textIndex.text, thread.comment.anchor);
      }
    }
    return found;
  }, [threads, textIndex]);
  useEffect(() => onPlaced?.(placements), [onPlaced, placements]);

  // The passages as DOM ranges, kept for bringing the active one into view.
  const paintedRef = useRef<{ id: string; range: Range }[]>([]);
  const activeId = marks?.activeId ?? null;
  const [markers, setMarkers] = useState<CanvasCommentMarker[]>([]);
  // The column's width changes where lines wrap: re-measure the marks then.
  const [layoutTick, setLayoutTick] = useState(0);
  useEffect(() => {
    const column = contentRef.current;
    if (!column || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setLayoutTick((tick) => tick + 1));
    observer.observe(column);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let stop: () => void = () => undefined;
    // After the paint: the ranges map onto the text the editor just rendered.
    const frame = window.requestAnimationFrame(() => {
      const painted: { id: string; range: Range }[] = [];
      for (const [id, placement] of Object.entries(placements)) {
        if (!placement) continue;
        const range = placementRange(textIndex, placement);
        if (!range) continue;
        try {
          const dom = editor.api.toDOMRange(range);
          if (dom) painted.push({ id, range: dom });
        } catch {
          // Folded away or not rendered: nothing to paint for it now.
        }
      }
      paintedRef.current = painted;
      setMarkers((previous) => {
        const next = measureCommentMarkers(painted, contentRef.current);
        return JSON.stringify(next) === JSON.stringify(previous) ? previous : next;
      });
      stop = paintCommentHighlights(
        painted.map((item) => item.range),
        painted.find((item) => item.id === activeId)?.range ?? null,
      );
    });
    return () => {
      window.cancelAnimationFrame(frame);
      stop();
    };
  }, [editor, placements, textIndex, activeId, layoutTick]);

  // The panel picked a thread: bring its passage into view. Only a new
  // request scrolls, not every repaint of the active passage.
  const focusNonce = marks?.focusNonce ?? 0;
  const focusTarget = useRef(activeId);
  focusTarget.current = activeId;
  useEffect(() => {
    if (focusNonce === 0) return;
    const frame = window.requestAnimationFrame(() => {
      const id = focusTarget.current;
      const target = paintedRef.current.find((item) => item.id === id)?.range;
      const scroller = scrollRef.current;
      if (!target || !scroller) return;
      const rect = target.getBoundingClientRect();
      const box = scroller.getBoundingClientRect();
      scroller.scrollTo({
        top: scroller.scrollTop + rect.top - box.top - box.height / 3,
        behavior: scrollBehavior(),
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusNonce]);

  // A decision in the review: the value changes in place, the page stays put.
  const reviewValue = review?.value ?? null;
  useEffect(() => {
    if (reviewValue && reviewValue !== initial) editor.tf.setValue(reviewValue);
  }, [editor, reviewValue, initial]);

  // Each undecided suggestion's pill sits at the bottom of its last block,
  // overlapping it a little so the pointer can move onto it.
  const remaining = review?.remaining ?? null;
  const [spots, setSpots] = useState<CanvasSuggestionSpot[]>([]);
  const [activeSuggestion, setActiveSuggestion] = useState<string | null>(null);
  useEffect(() => {
    if (!remaining || remaining.length === 0) {
      setSpots([]);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const column = contentRef.current;
      if (!column) return;
      const box = column.getBoundingClientRect();
      const next: CanvasSuggestionSpot[] = [];
      for (const suggestion of remaining) {
        const blocks = column.querySelectorAll<HTMLElement>(
          `[data-canvas-block][data-canvas-suggestion-id="${suggestion.id}"]`,
        );
        const last = blocks[blocks.length - 1];
        if (last) next.push({ suggestion, top: last.getBoundingClientRect().bottom - box.top });
      }
      setSpots(next);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [remaining, value, layoutTick]);
  const trackSuggestion = (target: EventTarget | null) => {
    const el = target instanceof Element ? target.closest("[data-canvas-suggestion-id]") : null;
    setActiveSuggestion(el?.getAttribute("data-canvas-suggestion-id") ?? null);
  };

  // "Agent is writing here": the block the agent's edit is on (tinted too),
  // or the top of the document. Measured after the paint, like the marks.
  const [writingSpot, setWritingSpot] = useState<WritingSpot | null>(null);
  const writingTool = agentWriting?.tool ?? null;
  const writingPassage = agentWriting?.passage ?? null;
  useEffect(() => {
    if (!writingTool) {
      setWritingSpot(null);
      return;
    }
    let stop: () => void = () => undefined;
    const frame = window.requestAnimationFrame(() => {
      const placement = writingPassage ? findWritingPlacement(textIndex, writingPassage) : null;
      const range = placement ? placementRange(textIndex, placement) : null;
      const column = contentRef.current;
      const block = range
        ? column?.querySelector<HTMLElement>(`[data-canvas-block="${range.anchor.path[0]}"]`)
        : null;
      if (!range || !block || !column) {
        setWritingSpot({ top: 0, height: 0, atTop: true });
        return;
      }
      const box = column.getBoundingClientRect();
      const rect = block.getBoundingClientRect();
      setWritingSpot({ top: rect.top - box.top, height: Math.max(rect.height, 20), atTop: false });
      stop = showAskHighlight(editor, range, "canvas-writing");
    });
    return () => {
      window.cancelAnimationFrame(frame);
      stop();
    };
  }, [editor, writingTool, writingPassage, textIndex, layoutTick]);

  const pickHeading = (index: number) => {
    // Unfold whatever hides the heading, then bring it under the sticky row.
    const folded = editor.getOption(canvasViewPlugin, "folded");
    setFolds(
      editor,
      folded.filter((start) => !getHiddenBlocks(value, [start]).includes(index)),
    );
    requestAnimationFrame(() => {
      contentRef.current
        ?.querySelector(`[data-canvas-block="${index}"]`)
        ?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
    if (compact) onCloseOutline();
  };

  return (
    <CanvasBylineContext.Provider value={byline}>
      <Plate
        editor={editor}
        readOnly={!writable}
        onValueChange={({ value: next }) => {
          setValue(next);
          // A section grew or shrank: the folds hide by index.
          refreshFolds(editor);
          onEdited?.();
        }}
      >
        {findOpen ? (
          <CanvasFindBar
            query={query}
            matches={countMatches(value, query)}
            onQueryChange={setQuery}
            onClose={onCloseFind}
          />
        ) : null}

        <div className="relative min-h-0 flex-1">
          <div
            ref={scrollRef}
            data-canvas-scroller=""
            className="h-full overflow-y-auto overflow-x-hidden overscroll-contain [scrollbar-gutter:stable]"
          >
            <CanvasDocBar
              showOutlineButton={!compact}
              outlineOpen={outlineOpen}
              onToggleOutline={onToggleOutline}
              findOpen={findOpen}
              onToggleFind={onToggleFind}
              mode={canEdit ? mode : "viewing"}
              canEdit={canEdit}
              onModeChange={onModeChange}
              showUndoRedo={writable}
              others={marks?.others ?? null}
            />
            {review && review.remaining.length > 0 ? (
              <CanvasSuggestionBar
                count={review.remaining.length}
                onAcceptAll={review.onAcceptAll}
                onRejectAll={review.onRejectAll}
              />
            ) : null}
            <div
              className={cn(
                "flex justify-center px-6 pt-6 sm:px-10 sm:pt-8",
                // Room under the last line for the floating toolbar / ✎ button.
                editing || (compact && canEdit) ? "pb-36" : "pb-24",
              )}
            >
              {/* The comment cards open from their margin marks only. */}
              <div
                ref={contentRef}
                className="relative w-full min-w-0 max-w-[680px]"
                onPointerOver={review ? (event) => trackSuggestion(event.target) : undefined}
                onPointerLeave={
                  review
                    ? (event) => {
                        // A finger "leaves" as it lifts: a tapped suggestion keeps its pill.
                        if (event.pointerType !== "touch") setActiveSuggestion(null);
                      }
                    : undefined
                }
              >
                {titleFirst ? null : <CanvasByline className="mb-8" />}
                {/* While editing, the editable reaches into the side margins:
                    a drag that starts there selects whole blocks (Plate's
                    block selection starts only on the editable's own box, not
                    on its text), and the ⋮⋮ handles sit in the left one. */}
                <EditorContainer className={editing ? undefined : "cursor-default"}>
                  <Editor
                    aria-label={
                      writable
                        ? `${title}, editing`
                        : editing
                          ? `${title}, read-only while the agent edits`
                          : review
                            ? `${title}, read-only until the suggestions are reviewed`
                            : `${title}, read-only`
                    }
                    className={
                      editing ? "sm:-mx-10 sm:w-[calc(100%+5rem)] sm:px-10" : "cursor-default"
                    }
                    onBlur={onBlur}
                  />
                </EditorContainer>
                {writable && ask && !compact && !coarse ? (
                  <CanvasCaretOrb ask={ask} columnRef={contentRef} />
                ) : null}
                {marks ? (
                  <CanvasCommentMarkers
                    markers={markers}
                    activeId={activeId}
                    onOpen={marks.onOpen}
                    onClose={marks.onClose}
                    renderThreads={marks.renderThreads}
                  />
                ) : null}
                {agentWriting && writingSpot ? <WritingMarker spot={writingSpot} /> : null}
                {review ? (
                  <CanvasSuggestionControls
                    spots={spots}
                    activeId={activeSuggestion}
                    onAccept={review.onAccept}
                    onReject={review.onReject}
                  />
                ) : null}
              </div>
            </div>
          </div>

          {outlineOpen ? (
            <CanvasOutline items={outline} onPick={pickHeading} onClose={onCloseOutline} />
          ) : null}

          {writable ? <CanvasToolbar ask={ask} comment={comment} /> : null}
          {!compact && (writable || comment) ? (
            <CanvasSelectionMenu ask={writable ? ask : null} comment={comment} />
          ) : null}
          {!writable && comment && !(editing && agentBusy) ? (
            <CanvasReadingCommentBar comment={comment} />
          ) : null}
          {editing && agentBusy ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-3 sm:bottom-6">
              <p
                aria-hidden="true"
                className="flex items-center gap-2 rounded-full border border-border/70 bg-background/95 px-4 py-2.5 text-[13px] text-muted-foreground shadow-lg shadow-foreground/5 backdrop-blur-md animate-in fade-in-0 duration-200 motion-reduce:animate-none"
              >
                <Loader2
                  className="size-4 shrink-0 animate-spin text-primary motion-reduce:animate-none"
                  aria-hidden="true"
                />
                {agentEdit ? "Agent is editing…" : "Agent is writing…"}
                <span className="hidden sm:inline">· it unlocks when the reply ends</span>
              </p>
            </div>
          ) : null}

          {/* Phone: the document opens for reading; ✎ switches to editing. */}
          {compact && canEdit && !editing && !review ? (
            <button
              type="button"
              aria-label="Edit document"
              onClick={() => {
                onModeChange("editing", false);
                requestAnimationFrame(() => editor.tf.focus({ edge: "end" }));
              }}
              className="absolute bottom-6 right-5 z-20 flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg shadow-primary/25 transition-transform duration-150 hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background animate-in fade-in-0 zoom-in-90 duration-200 motion-reduce:animate-none motion-reduce:transition-none"
            >
              <PencilLine className="size-6" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </Plate>
    </CanvasBylineContext.Provider>
  );
}

/** Where the "Agent is writing" marker sits in the column (px from its top). */
interface WritingSpot {
  top: number;
  height: number;
  /** No block found: the marker is a label at the top of the document. */
  atTop: boolean;
}

/**
 * The accent bar beside the block the agent is writing, with its label
 * above it (or, with no block, the label alone at the top of the document).
 */
function WritingMarker({ spot }: { spot: WritingSpot }) {
  return (
    <>
      {spot.atTop ? null : (
        <span
          aria-hidden="true"
          data-canvas-writing-bar=""
          style={{ top: spot.top, height: spot.height }}
          className="pointer-events-none absolute -left-3 w-[3px] rounded-full bg-primary animate-pulse motion-reduce:animate-none sm:-left-5"
        />
      )}
      <span
        role="status"
        style={{ top: spot.top }}
        className={cn(
          "pointer-events-none absolute left-0 z-10 flex items-center gap-1.5 whitespace-nowrap rounded-full border border-primary/30 bg-background/95 px-2.5 py-1 text-xs font-medium text-primary shadow-sm shadow-foreground/5 animate-in fade-in-0 duration-200 motion-reduce:animate-none",
          spot.atTop ? "-translate-y-[calc(100%+2px)]" : "-translate-y-[calc(100%+4px)]",
        )}
      >
        <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        {spot.atTop ? "Agent is writing…" : "Agent is writing here"}
      </span>
    </>
  );
}

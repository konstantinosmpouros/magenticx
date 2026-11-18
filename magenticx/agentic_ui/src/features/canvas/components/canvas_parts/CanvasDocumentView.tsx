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
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Value } from "platejs";
import { Plate, usePlateEditor } from "platejs/react";
import { PencilLine } from "lucide-react";

import type { CanvasBylineValue, CanvasMode } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";
import { Editor, EditorContainer } from "@/shared/ui/plate/editor";

import { CanvasBylineContext } from "../../lib/bylineContext";
import { canvasViewPlugin, refreshFolds, setFolds } from "../../lib/canvasView";
import { CANVAS_NODE_ID, canvasEditorPlugins, findPlugin } from "../../lib/editorKit";
import { countMatches } from "../../lib/find";
import { markdownToValue, valueToMarkdown } from "../../lib/markdown";
import { getHiddenBlocks, getOutline } from "../../lib/outline";
import { CanvasByline } from "./CanvasByline";
import { CanvasDocBar } from "./CanvasDocBar";
import { CanvasFindBar } from "./CanvasFindBar";
import { CanvasOutline } from "./CanvasOutline";
import { CanvasToolbar } from "./CanvasToolbar";

/** An empty document still needs one block for Plate to render. */
const EMPTY_DOCUMENT: Value = [{ type: "p", children: [{ text: "" }] }];

export function CanvasDocumentView({
  markdown,
  title,
  byline,
  compact,
  findOpen,
  outlineOpen,
  onCloseFind,
  onToggleOutline,
  onCloseOutline,
  mode,
  canEdit,
  onModeChange,
  onAttach,
  onEdited,
  onBlur,
}: {
  markdown: string;
  /** The document's title, for the editor's accessible name. */
  title: string;
  byline: CanvasBylineValue;
  /** Phone layout: the outline toggle lives in the header, not the document row. */
  compact: boolean;
  findOpen: boolean;
  outlineOpen: boolean;
  onCloseFind: () => void;
  onToggleOutline: () => void;
  onCloseOutline: () => void;
  mode: CanvasMode;
  /** The latest version can be edited; an earlier one is read-only. */
  canEdit: boolean;
  onModeChange: (mode: CanvasMode) => void;
  /** Receives the editor's serializer on mount, null on unmount (editable views only). */
  onAttach?: (serialize: (() => string) | null) => void;
  onEdited?: () => void;
  onBlur?: () => void;
}) {
  // Parsed once per mount: the parent remounts the view for new text.
  const [initial] = useState(() => {
    const parsed = markdownToValue(markdown);
    return parsed.length > 0 ? parsed : EMPTY_DOCUMENT;
  });
  const editor = usePlateEditor({ plugins: canvasEditorPlugins, value: initial, nodeId: CANVAS_NODE_ID });
  const [value, setValue] = useState<Value>(initial);
  const [query, setQuery] = useState("");
  const contentRef = useRef<HTMLDivElement>(null);
  const editing = canEdit && mode === "editing";

  const outline = useMemo(() => (outlineOpen ? getOutline(value) : []), [value, outlineOpen]);
  const titleFirst = value[0]?.type === "h1";

  // The serializer reads the live value only when a save is due.
  useEffect(() => {
    if (!canEdit || !onAttach) return;
    onAttach(() => valueToMarkdown(editor.children as Value));
    return () => onAttach(null);
  }, [editor, canEdit, onAttach]);

  useEffect(() => {
    editor.setOption(findPlugin, "search", findOpen ? query : "");
    editor.api.redecorate();
  }, [editor, query, findOpen]);

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
        readOnly={!editing}
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
          <div className="h-full overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
            <CanvasDocBar
              showOutlineButton={!compact}
              outlineOpen={outlineOpen}
              onToggleOutline={onToggleOutline}
              mode={canEdit ? mode : "viewing"}
              canEdit={canEdit}
              onModeChange={onModeChange}
              showUndoRedo={editing}
            />
            <div
              className={cn(
                "flex justify-center px-6 pt-6 sm:px-10 sm:pt-8",
                // Room under the last line for the floating toolbar / ✎ button.
                editing || (compact && canEdit) ? "pb-36" : "pb-24",
              )}
            >
              <div ref={contentRef} className="relative w-full min-w-0 max-w-[680px]">
                {titleFirst ? null : <CanvasByline className="mb-8" />}
                {/* While editing, the editable reaches into the side margins:
                    a drag that starts there selects whole blocks (Plate's
                    block selection starts only on the editable's own box, not
                    on its text), and the ⋮⋮ handles sit in the left one. */}
                <EditorContainer className={editing ? undefined : "cursor-default"}>
                  <Editor
                    aria-label={editing ? `${title}, editing` : `${title}, read-only`}
                    className={editing ? "sm:-mx-10 sm:w-[calc(100%+5rem)] sm:px-10" : "cursor-default"}
                    onBlur={onBlur}
                  />
                </EditorContainer>
              </div>
            </div>
          </div>

          {outlineOpen ? (
            <CanvasOutline items={outline} onPick={pickHeading} onClose={onCloseOutline} />
          ) : null}

          {editing ? <CanvasToolbar /> : null}

          {/* Phone: the document opens for reading; ✎ switches to editing. */}
          {compact && canEdit && !editing ? (
            <button
              type="button"
              aria-label="Edit document"
              onClick={() => {
                onModeChange("editing");
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

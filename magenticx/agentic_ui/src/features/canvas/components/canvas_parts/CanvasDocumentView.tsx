/**
 * One version of a document, rendered read-only: the find bar, the sticky
 * row with the outline and the mode, the serif title with its byline and the
 * reading column, and the outline panel over the left of the text.
 *
 * Built on Plate (`platejs`) in read-only mode: the markdown is parsed once
 * into the editor value (`lib/markdown.ts`), and the parent remounts this
 * view (by key) for another document or version rather than replacing the
 * value of a live editor.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Value } from "platejs";
import { Plate, usePlateEditor } from "platejs/react";

import type { CanvasBylineValue } from "@/shared/lib/types";
import { Editor, EditorContainer } from "@/shared/ui/plate/editor";

import { CanvasBylineContext } from "../../lib/bylineContext";
import { canvasViewPlugin, setFolds } from "../../lib/canvasView";
import { canvasEditorPlugins, findPlugin } from "../../lib/editorKit";
import { countMatches } from "../../lib/find";
import { markdownToValue } from "../../lib/markdown";
import { getHiddenBlocks, getOutline } from "../../lib/outline";
import { CanvasByline } from "./CanvasByline";
import { CanvasDocBar } from "./CanvasDocBar";
import { CanvasFindBar } from "./CanvasFindBar";
import { CanvasOutline } from "./CanvasOutline";

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
}) {
  const value = useMemo(() => {
    const parsed = markdownToValue(markdown);
    return parsed.length > 0 ? parsed : EMPTY_DOCUMENT;
  }, [markdown]);
  const editor = usePlateEditor({ plugins: canvasEditorPlugins, value });
  const [query, setQuery] = useState("");
  const contentRef = useRef<HTMLDivElement>(null);

  // Read-only: the value never changes, so the outline is computed once.
  const outline = useMemo(() => getOutline(value), [value]);
  const titleFirst = value[0]?.type === "h1";

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
      <Plate editor={editor} readOnly>
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
            />
            <div className="flex justify-center px-6 pb-24 pt-6 sm:px-10 sm:pt-8">
              <div ref={contentRef} className="relative w-full min-w-0 max-w-[680px]">
                {titleFirst ? null : <CanvasByline className="mb-8" />}
                <EditorContainer className="cursor-default">
                  <Editor aria-label={`${title}, read-only`} className="cursor-default" />
                </EditorContainer>
              </div>
            </div>
          </div>

          {outlineOpen ? (
            <CanvasOutline items={outline} onPick={pickHeading} onClose={onCloseOutline} />
          ) : null}
        </div>
      </Plate>
    </CanvasBylineContext.Provider>
  );
}

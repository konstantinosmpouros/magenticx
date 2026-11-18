import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";

import { CANVAS_DOC_PARAM, isCanvasDocumentPath } from "@/shared/lib/canvasDocuments";

/**
 * The open canvas document, kept in the URL (`/c/:id?doc=<path>`) so a reload,
 * a new tab or the Artifacts page's link opens the same document. Opening
 * pushes a history entry (Back closes the canvas, as on a phone you'd expect);
 * switching documents and closing replace it. A path that cannot be a canvas
 * document (a hand-edited URL) is treated as no document at all.
 */
export function useCanvasRoute() {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get(CANVAS_DOC_PARAM);
  const path = raw && isCanvasDocumentPath(raw) ? raw : null;

  const update = useCallback(
    (next: string | null, replace: boolean) =>
      setSearchParams(
        (current) => {
          const params = new URLSearchParams(current);
          if (next === null) params.delete(CANVAS_DOC_PARAM);
          else params.set(CANVAS_DOC_PARAM, next);
          return params;
        },
        { replace },
      ),
    [setSearchParams],
  );

  return {
    path,
    open: useCallback((next: string) => update(next, false), [update]),
    switchTo: useCallback((next: string) => update(next, true), [update]),
    close: useCallback(() => update(null, true), [update]),
  };
}

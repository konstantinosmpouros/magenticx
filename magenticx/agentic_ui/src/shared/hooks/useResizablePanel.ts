import * as React from "react";

/** How a resizable side panel sits in its area. */
export type ResizablePanelLayout = "docked" | "drawer";

/** The sizing rules of one resizable side panel. */
export interface ResizablePanelOptions {
  /** localStorage key the dragged width is remembered under, on this device. */
  storageKey: string;
  /** The panel's narrowest and widest docked width, in px. */
  min: number;
  max: number;
  /** The width before the user drags: a number, or one computed from the area's width. */
  defaultWidth: number | ((areaWidth: number) => number);
  /** Room the content beside the panel always keeps, in px. */
  siblingMin: number;
  /** Below this area width the panel stops docking (`layout: "drawer"`). */
  dockMinArea: number;
  /** The separator's accessible name. */
  label: string;
}

const KEY_STEP = 16;

function storedWidth(storageKey: string): number | null {
  try {
    const raw = Number(window.localStorage.getItem(storageKey));
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * A right-hand side panel's sizing, shared by the agent builder's inspector
 * and the document canvas: watches the area the panel and its sibling share
 * and says whether the panel docks beside the sibling (wide enough) or
 * should cover it (too narrow to share). Docked, it owns the width the user
 * drags its left edge to, clamped so the sibling keeps room, and remembers it
 * on this device; until then it uses the default. Returns the area ref, the
 * layout, the width and the separator's props (pointer drag, arrow keys,
 * double-click to reset).
 */
export function useResizablePanel(options: ResizablePanelOptions) {
  const { storageKey, min, max: maxWidth, defaultWidth, siblingMin, dockMinArea, label } = options;
  const areaRef = React.useRef<HTMLDivElement>(null);
  const [areaWidth, setAreaWidth] = React.useState<number | null>(null);
  // null: never dragged on this device, so the default applies.
  const [preferred, setPreferred] = React.useState<number | null>(() => storedWidth(storageKey));
  const [dragging, setDragging] = React.useState(false);
  const drag = React.useRef<{ startX: number; startWidth: number } | null>(null);

  React.useEffect(() => {
    const element = areaRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setAreaWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const max =
    areaWidth === null ? maxWidth : Math.max(min, Math.min(maxWidth, areaWidth - siblingMin));
  const clamp = React.useCallback(
    (value: number) => Math.round(Math.min(max, Math.max(min, value))),
    [max, min],
  );
  const fallback =
    typeof defaultWidth === "function" ? defaultWidth(areaWidth ?? maxWidth) : defaultWidth;
  const width = clamp(preferred ?? fallback);
  const layout: ResizablePanelLayout =
    areaWidth !== null && areaWidth < dockMinArea ? "drawer" : "docked";

  const commit = React.useCallback(
    (value: number | null) => {
      const next = value === null ? null : clamp(value);
      setPreferred(next);
      try {
        if (next === null) window.localStorage.removeItem(storageKey);
        else window.localStorage.setItem(storageKey, String(next));
      } catch {
        // Storage off (private mode, quota): the width just isn't remembered.
      }
    },
    [clamp, storageKey],
  );

  // While dragging, the whole page shows the resize cursor and nothing gets text-selected.
  React.useEffect(() => {
    if (!dragging) return;
    const { cursor, userSelect } = document.body.style;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = cursor;
      document.body.style.userSelect = userSelect;
    };
  }, [dragging]);

  const separatorProps = {
    role: "separator",
    tabIndex: 0,
    "aria-orientation": "vertical",
    "aria-label": label,
    "aria-valuemin": min,
    "aria-valuemax": max,
    "aria-valuenow": width,
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { startX: event.clientX, startWidth: width };
      setDragging(true);
    },
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
      const start = drag.current;
      // The panel sits on the right: dragging its edge left widens it.
      if (start) setPreferred(clamp(start.startWidth + start.startX - event.clientX));
    },
    onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => {
      const start = drag.current;
      if (!start) return;
      drag.current = null;
      setDragging(false);
      commit(start.startWidth + start.startX - event.clientX);
    },
    onPointerCancel: () => {
      drag.current = null;
      setDragging(false);
    },
    onDoubleClick: () => commit(null),
    onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? KEY_STEP * 4 : KEY_STEP;
      const moves: Record<string, number> = {
        ArrowLeft: width + step,
        ArrowRight: width - step,
        Home: max,
        End: min,
      };
      if (!(event.key in moves)) return;
      event.preventDefault();
      commit(moves[event.key]);
    },
  } as const;

  return { areaRef, layout, width, dragging, separatorProps };
}

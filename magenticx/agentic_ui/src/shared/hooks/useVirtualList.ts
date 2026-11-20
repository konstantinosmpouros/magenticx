import { useCallback, useLayoutEffect, useMemo, useRef, useState, type FocusEvent } from "react";
import {
  defaultRangeExtractor,
  measureElement as measureElementSize,
  observeElementRect,
  useVirtualizer,
  type Range,
  type Rect,
  type Virtualizer,
} from "@tanstack/react-virtual";

/**
 * The height assumed for a scroll box that reports none: not laid out yet, or
 * a DOM without layout (happy-dom in tests). About a screen of rows, so the
 * list is never empty just because its box has not been measured.
 */
const UNMEASURED_VIEWPORT_PX = 640;

type ScrollBox = HTMLElement;

/** The scroll box's size, or a screen's worth when it reports zero. */
const observeRectOrFallback = (
  instance: Virtualizer<ScrollBox, Element>,
  cb: (rect: Rect) => void,
) =>
  observeElementRect(instance, (rect) =>
    cb(rect.height > 0 ? rect : { width: rect.width, height: UNMEASURED_VIEWPORT_PX }),
  );

const NO_KEYS: readonly (string | null | undefined)[] = [];

type VirtualListOptions = {
  /** One stable key per item, in display order. */
  keys: readonly string[];
  /** A row's expected height in px; rows are measured once rendered. */
  estimateSize: number;
  /** The scrolling ancestor of the list, found with `closest()` from the list element. */
  scrollContainerSelector: string;
  overscan?: number;
  /** Space between rows in px (instead of `space-y-*`, whose margins would shift absolutely placed rows). */
  gap?: number;
  /** Items rendered wherever the scroll is (a row being renamed). */
  keepMountedKeys?: readonly (string | null | undefined)[];
};

/**
 * A long list that keeps only the rows near the viewport in the DOM (plan 45,
 * Phase 6): `@tanstack/react-virtual` over a list element inside an existing
 * scroll box, shared by the sidebar's Chats section and the Artifacts page.
 *
 * What it adds over a bare `useVirtualizer`:
 * - the scroll box is found from the list (`closest`), so it works while the
 *   box and the list mount in the same commit (a parent's ref is not attached
 *   yet when the child's layout effects run);
 * - `initialOffset` is the box's current scroll, so a list that switches to
 *   this mode mid-scroll does not jump to the top;
 * - the list's offset inside the box (`scrollMargin`) is measured, so headers
 *   and toolbars above the list in the same scroll box are accounted for;
 * - a zero-size box or row (unlaid-out, or a test DOM) falls back to the
 *   estimate, so the first window renders instead of nothing (or everything);
 * - the row holding keyboard focus, and any `keepMountedKeys`, stay rendered
 *   when scrolled away, so focus is never dropped to `<body>` by a scroll.
 *
 * Rows must carry `data-index={index}` and `ref={measureElement}`, and be
 * placed at `translateY(start - scrollMargin)` inside a `position: relative`
 * list of height `totalSize`; attach `onFocus` to the list element.
 */
export function useVirtualList<L extends HTMLElement>({
  keys,
  estimateSize,
  scrollContainerSelector,
  overscan = 8,
  gap = 0,
  keepMountedKeys = NO_KEYS,
}: VirtualListOptions) {
  const listRef = useRef<L | null>(null);
  // Read by the range extractor, which runs during render with the current list.
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const keepRef = useRef(keepMountedKeys);
  keepRef.current = keepMountedKeys;
  const focusedKeyRef = useRef<string | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  const getScrollElement = useCallback(
    () => listRef.current?.closest<ScrollBox>(scrollContainerSelector) ?? null,
    [scrollContainerSelector],
  );

  const rangeExtractor = useCallback((range: Range) => {
    const indexes = defaultRangeExtractor(range);
    const first = indexes[0] ?? 0;
    const last = indexes[indexes.length - 1] ?? -1;
    // Only a row that still holds focus is kept: once focus has left the
    // list, a stale key must not pin a row forever.
    const list = listRef.current;
    const focused =
      list && typeof document !== "undefined" && list.contains(document.activeElement)
        ? focusedKeyRef.current
        : null;
    const extra: number[] = [];
    for (const key of [...keepRef.current, focused]) {
      if (key == null) continue;
      const index = keysRef.current.indexOf(key);
      if (index >= 0 && (index < first || index > last) && !extra.includes(index)) {
        extra.push(index);
      }
    }
    return extra.length > 0 ? [...indexes, ...extra].sort((a, b) => a - b) : indexes;
  }, []);

  // A new function when the keys change: the virtualizer recomputes its
  // positions on a new `getItemKey`, so a reorder of the same length is seen.
  const getItemKey = useCallback((index: number) => keys[index] ?? index, [keys]);

  const measureRow = useMemo(
    () =>
      (
        element: Element,
        entry: ResizeObserverEntry | undefined,
        instance: Virtualizer<ScrollBox, Element>,
      ) => {
        const size = measureElementSize(element, entry, instance);
        return size > 0 ? size : estimateSize;
      },
    [estimateSize],
  );

  const virtualizer = useVirtualizer<ScrollBox, Element>({
    count: keys.length,
    getScrollElement,
    estimateSize: () => estimateSize,
    getItemKey,
    overscan,
    gap,
    scrollMargin,
    initialRect: { width: 0, height: UNMEASURED_VIEWPORT_PX },
    initialOffset: () => getScrollElement()?.scrollTop ?? 0,
    observeElementRect: observeRectOrFallback,
    measureElement: measureRow,
    rangeExtractor,
  });

  // Where the list starts inside its scroll box: measured on mount and again
  // whenever the list's container resizes (a toolbar above it wrapping, a
  // banner appearing), which is when that offset can change.
  useLayoutEffect(() => {
    const measure = () => {
      const list = listRef.current;
      const box = getScrollElement();
      if (!list || !box) return;
      const boxRect = box.getBoundingClientRect();
      // A box with no layout (hidden, or a test DOM) has nothing to measure.
      if (boxRect.width === 0 && boxRect.height === 0) return;
      const margin = Math.round(
        list.getBoundingClientRect().top - boxRect.top - box.clientTop + box.scrollTop,
      );
      setScrollMargin((current) => (current === margin ? current : margin));
    };
    measure();
    const container = listRef.current?.parentElement;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [getScrollElement]);

  // Which row holds focus, by key: indexes shift when rows are added above.
  const onFocus = useCallback((event: FocusEvent<HTMLElement>) => {
    const row = (event.target as Element).closest?.("[data-index]");
    const index = Number(row?.getAttribute("data-index"));
    focusedKeyRef.current = Number.isInteger(index) ? (keysRef.current[index] ?? null) : null;
  }, []);

  return {
    listRef,
    virtualItems: virtualizer.getVirtualItems(),
    totalSize: virtualizer.getTotalSize(),
    scrollMargin,
    measureElement: virtualizer.measureElement,
    onFocus,
  };
}

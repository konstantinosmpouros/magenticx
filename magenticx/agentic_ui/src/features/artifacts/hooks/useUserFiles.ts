import { useCallback, useEffect, useRef, useState } from "react";

import { listUserFiles } from "@/shared/lib/api";
import type { UserFile } from "@/shared/lib/types";
import { FILES_PAGE_SIZE, type KindFilter, type TypeFilter } from "@/features/artifacts/lib/fileFilters";

export type UserFilesFilters = {
  kind: KindFilter;
  type: TypeFilter;
  /** Already debounced by the caller; trimmed here. */
  query: string;
};

/**
 * useUserFiles — the Artifacts page's list, a keyset page at a time.
 *
 * The filters define the list; changing any of them starts over from the first
 * page. `loadMore` follows the bridge's opaque cursor, so pages never repeat or
 * skip a file even while new ones land. A response for an outdated filter set
 * is dropped (the request counter), so a slow first search can never overwrite
 * a faster later one.
 */
export function useUserFiles(userId: string | null, filters: UserFilesFilters) {
  const [items, setItems] = useState<UserFile[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const { kind, type, query } = filters;

  const fetchPage = useCallback(
    (after: string | null) =>
      listUserFiles(userId ?? "", {
        kind: kind === "all" ? null : kind,
        type: type === "all" ? null : type,
        q: query.trim() || null,
        cursor: after,
        limit: FILES_PAGE_SIZE,
      }),
    [userId, kind, type, query],
  );

  const reload = useCallback(async () => {
    if (!userId) return;
    const request = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const page = await fetchPage(null);
      if (request !== requestRef.current) return;
      setItems(page.items);
      setCursor(page.nextCursor);
      setLoaded(true);
    } catch (err) {
      if (request === requestRef.current) {
        setError(err instanceof Error ? err.message : "Failed to load your files");
      }
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [userId, fetchPage]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    const request = requestRef.current;
    setLoadingMore(true);
    try {
      const page = await fetchPage(cursor);
      if (request !== requestRef.current) return;
      setItems((previous) => [...previous, ...page.items]);
      setCursor(page.nextCursor);
    } catch (err) {
      if (request === requestRef.current) {
        setError(err instanceof Error ? err.message : "Failed to load more files");
      }
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, fetchPage]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return {
    items,
    hasMore: cursor !== null,
    loaded,
    loading,
    loadingMore,
    error,
    reload: () => void reload(),
    loadMore: () => void loadMore(),
  };
}

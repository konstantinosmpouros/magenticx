import { useCallback, useEffect, useRef, useState } from "react";

import { deleteDocumentSuggestion, getDocumentSuggestion } from "@/shared/lib/api";
import type {
  CanvasDocumentSuggestion,
  CanvasDocumentVersion,
  CanvasSuggestionStart,
} from "@/shared/lib/types";

import { normalizeMarkdown } from "../lib/markdown";
import { rebaseProposed } from "../lib/suggestions";
import { useFetchCanvasVersionText } from "./useCanvasVersionText";

const NONE: CanvasSuggestionStart = { status: "ready", proposed: null, savedBase: null };

/**
 * The open document's pending suggestion set (plan 44, Phase 4.6), read once
 * when the document opens — in every mode: Editing and Viewing show a pending
 * set too. What it comes to, against the latest version as it was then:
 *
 * - none (404), or the read failed (fail open: the document still opens);
 * - the latest already says what the set proposed (the agent applied it) →
 *   the set is deleted silently, nothing to show;
 * - made on the latest → its proposed text, drawn over the latest;
 * - made on an older version (the agent edited meanwhile) → the user's
 *   changes rebased onto the latest (`rebaseProposed`); when they no longer
 *   fit, `stale`: shown read-only over their own base until discarded.
 *
 * Later versions are not this hook's: `useCanvasEditing` carries the live
 * suggestions onto them. The editor waits for this answer (`loading`), so a
 * set never appears under the user's caret after they started typing.
 *
 * `refresh` reads the set again — the canvas calls it when a run of the
 * conversation ends, as it re-reads the comments, because the agent may have
 * accepted or rejected the set on the user's request (`review_suggestions`).
 * It resolves the set, null when the server holds none, or undefined when
 * the read failed (nothing is concluded from a failure).
 */
export function useCanvasSuggestions(
  userId: string,
  conversationId: string,
  path: string,
  latest: CanvasDocumentVersion | null,
): {
  start: CanvasSuggestionStart;
  refresh: () => Promise<CanvasDocumentSuggestion | null | undefined>;
} {
  const fetchVersionText = useFetchCanvasVersionText(userId, conversationId, path);
  const [start, setStart] = useState<CanvasSuggestionStart>({ status: "loading" });
  const latestRef = useRef(latest);
  latestRef.current = latest;
  const known = latest !== null;

  useEffect(() => {
    const opened = latestRef.current;
    if (!known || !opened) return;
    let cancelled = false;
    const resolve = async (): Promise<CanvasSuggestionStart> => {
      let set;
      try {
        set = await getDocumentSuggestion(userId, conversationId, path);
      } catch {
        return NONE;
      }
      if (!set) return NONE;
      const target = normalizeMarkdown(opened.content);
      const clear = () => {
        // Nothing left to suggest: dropped quietly (a failure only leaves it for next time).
        void Promise.resolve()
          .then(() => deleteDocumentSuggestion(userId, conversationId, path))
          .catch(() => undefined);
        return NONE;
      };
      if (normalizeMarkdown(set.content) === target) return clear();
      if (set.baseVersion === opened.version)
        return { status: "ready", proposed: set.content, savedBase: set.baseVersion };
      let base: string;
      try {
        base = await fetchVersionText(set.baseVersion);
      } catch {
        // Its base cannot be read now: not shown this time, and left as it is.
        return { status: "ready", proposed: null, savedBase: set.baseVersion };
      }
      const rebased = rebaseProposed(base, set.content, opened.content);
      if (rebased === null)
        return { status: "stale", base, proposed: set.content, baseVersion: set.baseVersion };
      if (rebased === target) return clear();
      return { status: "ready", proposed: rebased, savedBase: set.baseVersion };
    };
    void resolve().then((next) => {
      if (!cancelled) setStart(next);
    });
    return () => {
      cancelled = true;
    };
  }, [known, userId, conversationId, path, fetchVersionText]);

  const refresh = useCallback(async () => {
    try {
      return await getDocumentSuggestion(userId, conversationId, path);
    } catch {
      return undefined;
    }
  }, [userId, conversationId, path]);

  return { start, refresh };
}

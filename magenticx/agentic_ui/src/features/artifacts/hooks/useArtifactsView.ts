import { useCallback, useState } from "react";

/** The Artifacts page's two layouts: cards in a grid, or dense rows. */
export type ArtifactsView = "grid" | "list";

const KEY = "mx_artifacts_view";

function readView(): ArtifactsView {
  try {
    return window.localStorage.getItem(KEY) === "list" ? "list" : "grid";
  } catch {
    // localStorage unavailable (blocked storage): the grid, the default.
    return "grid";
  }
}

/**
 * useArtifactsView — the layout the user picked for the Artifacts page,
 * remembered on this device. A UI preference, not account data, so it lives in
 * localStorage like the sidebar's open sections; the grid is the default.
 */
export function useArtifactsView() {
  const [view, setViewState] = useState<ArtifactsView>(readView);
  const setView = useCallback((next: ArtifactsView) => {
    setViewState(next);
    try {
      window.localStorage.setItem(KEY, next);
    } catch {
      // localStorage unavailable — the choice still holds for this visit.
    }
  }, []);
  return [view, setView] as const;
}

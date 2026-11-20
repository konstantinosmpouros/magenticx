import { createContext, useCallback, useContext, useEffect, useState } from "react";

/**
 * How long card layout animation stays on after a user change. The cards'
 * spring settles in about 0.4 s; a delete or pause first waits on the bridge
 * before the list changes, so the window leaves room for that round trip.
 */
const LAYOUT_WINDOW_MS = 1500;

/** The `layoutDependency` outside a window: a constant, so a render never measures. */
const LAYOUT_SETTLED = "settled";

const CardLayoutContext = createContext(false);

/** Tells the cards and grids below whether a user-made change is animating. */
export const CardLayoutProvider = CardLayoutContext.Provider;

/**
 * When the Automations page's cards may animate their layout (plan 45,
 * Phase 6): only for a change the user made — a filter, search, sort or area
 * change, or `arm()` from an action that reorders or removes cards (pause,
 * delete, create) — not for the poll that refreshes the list every few
 * seconds.
 *
 * Why: every card (and the grid) carried `layout="position"`, and Framer
 * measures every layout-animated element on every render — so each poll
 * re-measured every card. Framer skips the measurement while a component's
 * `layoutDependency` is unchanged; the window turns it off (`undefined`:
 * measure every render) for a moment after a user change, and back to a
 * constant afterwards.
 *
 * `changeKey` joins the user-controlled list inputs; when it differs from the
 * last render, the window opens in that same render, so the measurement
 * before the change is taken.
 */
export function useCardLayoutWindow(changeKey: string) {
  const [armed, setArmed] = useState(false);
  // Bumped by every arming, so a second change restarts the window.
  const [generation, setGeneration] = useState(0);
  const [lastKey, setLastKey] = useState(changeKey);
  if (lastKey !== changeKey) {
    setLastKey(changeKey);
    setArmed(true);
    setGeneration((value) => value + 1);
  }
  const arm = useCallback(() => {
    setArmed(true);
    setGeneration((value) => value + 1);
  }, []);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), LAYOUT_WINDOW_MS);
    return () => window.clearTimeout(timer);
  }, [armed, generation]);
  return { armed, arm };
}

/** A grid's or card's `layoutDependency` for an open (`true`) or closed window. */
export function cardLayoutDependency(armed: boolean): string | undefined {
  return armed ? undefined : LAYOUT_SETTLED;
}

/** The `layoutDependency` for a card or grid under a `CardLayoutProvider`. */
export function useCardLayoutDependency(): string | undefined {
  return cardLayoutDependency(useContext(CardLayoutContext));
}

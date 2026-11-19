import { useEffect, type RefObject } from "react";

import { scrollBehavior } from "../lib/commentHighlight";

/**
 * Keeps a just-opened comment field in sight (plan 44, comment cards). A
 * card's Reply box opens at the card's bottom, which on a phone is often
 * below the screen — and the on-screen keyboard then covers what was left.
 * So: once on mount, and again whenever the visual viewport shrinks while the
 * field has the focus (the keyboard sliding up), the field is scrolled into
 * view inside every scroller around it (the card, the canvas, the page).
 */
export function useKeepFieldInView(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const reveal = () =>
      ref.current?.scrollIntoView({ block: "nearest", behavior: scrollBehavior() });
    const frame = window.requestAnimationFrame(reveal);
    const viewport = window.visualViewport;
    const onResize = () => {
      if (ref.current?.contains(document.activeElement)) reveal();
    };
    viewport?.addEventListener("resize", onResize);
    return () => {
      window.cancelAnimationFrame(frame);
      viewport?.removeEventListener("resize", onResize);
    };
  }, [ref]);
}

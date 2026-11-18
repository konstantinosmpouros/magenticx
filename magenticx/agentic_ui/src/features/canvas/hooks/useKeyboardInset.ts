import { useEffect, useState, type RefObject } from "react";

/**
 * How far the on-screen keyboard covers the bottom of an element, in CSS
 * pixels (plan 44, Phase 4.2: the canvas toolbar on a phone).
 *
 * A phone's keyboard shrinks the *visual* viewport, not the layout one, so
 * an element pinned to the bottom of the canvas stays where it was — under
 * the keyboard. This measures the overlap between the element's box and the
 * visual viewport's bottom edge, so the toolbar can sit just above the
 * keyboard. Zero on a desktop, with no keyboard, or without the
 * `visualViewport` API.
 */
export function useKeyboardInset(ref: RefObject<HTMLElement | null>): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const viewport = window.visualViewport;
    const element = ref.current;
    if (!viewport || !element) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const bottom = element.getBoundingClientRect().bottom;
        const visibleBottom = viewport.offsetTop + viewport.height;
        // Under ~80px is browser chrome moving (the URL bar), not a keyboard.
        const overlap = Math.round(bottom - visibleBottom);
        setInset(overlap > 80 ? overlap : 0);
      });
    };
    measure();
    viewport.addEventListener("resize", measure);
    viewport.addEventListener("scroll", measure);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", measure);
      viewport.removeEventListener("scroll", measure);
    };
  }, [ref]);

  return inset;
}

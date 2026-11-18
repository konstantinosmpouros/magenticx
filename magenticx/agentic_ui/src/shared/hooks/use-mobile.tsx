import * as React from "react";

const MOBILE_BREAKPOINT = 768;

/**
 * Whether the screen is phone-sized (below 768px), live.
 *
 * Reads the media query's own `matches`, not `window.innerWidth`: on a phone
 * the layout viewport (`innerWidth`) widens for a moment whenever content
 * overflows sideways while the page lays out — e.g. 896px for one frame on
 * a 390px iPhone — and a read in that moment kept the whole app in its
 * desktop layout (the canvas opened for editing instead of reading). The
 * media query follows the device width and does not jump.
 */
export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined);

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => setIsMobile(mql.matches);
    mql.addEventListener("change", onChange);
    setIsMobile(mql.matches);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return !!isMobile;
}

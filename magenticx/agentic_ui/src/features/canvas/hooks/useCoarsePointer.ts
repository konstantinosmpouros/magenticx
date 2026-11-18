import { useEffect, useState } from "react";

const QUERY = "(pointer: coarse)";

const matches = (): boolean => {
  try {
    return typeof window !== "undefined" && window.matchMedia(QUERY).matches;
  } catch {
    return false;
  }
};

/**
 * Whether the main pointer is a finger (a phone or a tablet), kept current.
 * The canvas uses it where touch and mouse need different ways in: with a
 * mouse, Ask agent is the floating menu over a selection; with a finger,
 * which has no such menu, it is a pill button shown while text is selected.
 */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(matches);
  useEffect(() => {
    let media: MediaQueryList;
    try {
      media = window.matchMedia(QUERY);
    } catch {
      return;
    }
    const update = () => setCoarse(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return coarse;
}

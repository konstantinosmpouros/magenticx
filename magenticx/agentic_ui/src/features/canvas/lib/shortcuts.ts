/**
 * Keyboard shortcuts of the canvas editor: how the hints spell the modifier
 * (⌘ on Apple keyboards, Ctrl elsewhere) and which key press is Save.
 */

/** Whether the keyboard is an Apple one (for the shortcut hints only). */
export function isApplePlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

/** The modifier as the hints write it before a key: "⌘" or "Ctrl+". */
export const modKeyLabel = (): string => (isApplePlatform() ? "⌘" : "Ctrl+");

/** Ctrl+S, or ⌘S on a Mac: save now instead of the browser's "Save page". */
export function isSaveShortcut(event: KeyboardEvent): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "s"
  );
}

/** Ctrl+F, or ⌘F on a Mac: Find in the document instead of the browser's find. */
export function isFindShortcut(event: KeyboardEvent): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "f"
  );
}

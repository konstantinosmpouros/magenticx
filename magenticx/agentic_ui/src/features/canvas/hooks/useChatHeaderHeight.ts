import { useEffect, useState, type RefObject } from "react";

/**
 * The height of the chat's header (`[data-chat-header]`) inside `columnRef`,
 * kept current: the canvas docked beside the chat gives its own header the
 * same height, so the two bottom lines meet across the split. The chat
 * header's height is not a constant — it follows the controls it shows — so
 * it is measured, not assumed. Null while there is none (or `enabled` is off).
 */
export function useChatHeaderHeight(
  columnRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): number | null {
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    const column = columnRef.current;
    if (!enabled || !column) {
      setHeight(null);
      return;
    }
    let observed: Element | null = null;
    const sizes = new ResizeObserver(([entry]) => {
      const box = entry?.borderBoxSize?.[0];
      setHeight(Math.round(box ? box.blockSize : entry.target.getBoundingClientRect().height));
    });
    // The header can mount after the column (a conversation loading), or be
    // replaced: follow whichever one is there now.
    const track = () => {
      const header = column.querySelector("[data-chat-header]");
      if (header === observed) return;
      if (observed) sizes.unobserve(observed);
      observed = header;
      if (header) sizes.observe(header);
      else setHeight(null);
    };
    track();
    const changes = new MutationObserver(track);
    changes.observe(column, { childList: true, subtree: true });
    return () => {
      changes.disconnect();
      sizes.disconnect();
    };
  }, [columnRef, enabled]);

  return height;
}

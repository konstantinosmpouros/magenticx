/**
 * Inline nodes: link, inline code and the find-in-document highlight, from
 * Plate's shadcn registry (`link-node`, `code-node`, `search-highlight-node`),
 * adapted to the app's tokens.
 */
import type { TLinkElement } from "platejs";
import { getLinkAttributes } from "@platejs/link";
import {
  PlateElement,
  PlateLeaf,
  type PlateElementProps,
  type PlateLeafProps,
} from "platejs/react";

export function LinkElement(props: PlateElementProps<TLinkElement>) {
  return (
    <PlateElement
      {...props}
      as="a"
      className="font-medium text-primary underline decoration-primary/40 underline-offset-[3px] transition-colors hover:decoration-primary"
      attributes={{
        ...props.attributes,
        ...getLinkAttributes(props.editor, props.element),
        // A document link always opens away from the app, never with its opener.
        target: "_blank",
        rel: "noopener noreferrer nofollow",
        onMouseOver: (event) => event.stopPropagation(),
      }}
    >
      {props.children}
    </PlateElement>
  );
}

export function CodeLeaf(props: PlateLeafProps) {
  return (
    <PlateLeaf
      {...props}
      as="code"
      className="whitespace-pre-wrap rounded-[5px] border border-border/70 bg-muted px-[0.35em] py-[0.1em] font-mono text-[0.86em] text-foreground"
    >
      {props.children}
    </PlateLeaf>
  );
}

export function SearchHighlightLeaf(props: PlateLeafProps) {
  return (
    <PlateLeaf {...props} className="rounded-[3px] bg-warning/35 text-foreground">
      {props.children}
    </PlateLeaf>
  );
}

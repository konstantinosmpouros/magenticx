/**
 * The simple block nodes — paragraph, blockquote, horizontal rule, code block,
 * image — from Plate's shadcn registry (`paragraph-node`, `blockquote-node`,
 * `hr-node`), adapted to the document's spacing and tokens. The registry's code
 * block (syntax highlighting, language picker) and image (resize, captions,
 * upload) bring far more than a markdown document needs, so those two are
 * plain renderings here.
 */
import type { TImageElement } from "platejs";
import {
  PlateElement,
  useFocused,
  useReadOnly,
  useSelected,
  type PlateElementProps,
} from "platejs/react";

import { cn } from "@/shared/lib/utils";

export function ParagraphElement(props: PlateElementProps) {
  return (
    <PlateElement {...props} className="m-0 py-[0.3rem]">
      {props.children}
    </PlateElement>
  );
}

export function BlockquoteElement(props: PlateElementProps) {
  return (
    <PlateElement
      as="blockquote"
      className="my-3 border-l-2 border-primary/50 pl-5 italic text-muted-foreground"
      {...props}
    />
  );
}

export function HrElement(props: PlateElementProps) {
  const readOnly = useReadOnly();
  const selected = useSelected();
  const focused = useFocused();

  return (
    <PlateElement {...props}>
      <div className="py-5" contentEditable={false}>
        <hr
          className={cn(
            "h-px border-none bg-border bg-clip-content",
            selected && focused && "ring-2 ring-ring ring-offset-2 ring-offset-background",
            !readOnly && "cursor-pointer",
          )}
        />
      </div>
      {props.children}
    </PlateElement>
  );
}

export function CodeBlockElement(props: PlateElementProps) {
  return (
    <PlateElement
      {...props}
      className="my-3 overflow-x-auto rounded-lg border border-border bg-muted/60 px-4 py-3 font-mono text-[13.5px] leading-relaxed text-foreground"
    >
      <pre className="m-0 whitespace-pre">
        <code>{props.children}</code>
      </pre>
    </PlateElement>
  );
}

export function CodeLineElement(props: PlateElementProps) {
  return <PlateElement {...props} className="block" />;
}

export function ImageElement(props: PlateElementProps<TImageElement>) {
  const selected = useSelected();
  const { url } = props.element;
  // The markdown `![alt](url)` arrives as a one-text caption.
  const caption = props.element.caption as Array<{ text?: string }> | undefined;
  const alt = caption?.map((node) => node.text ?? "").join("");

  return (
    <PlateElement {...props} className="my-4">
      <figure contentEditable={false} className="m-0">
        <img
          src={url}
          alt={alt ?? ""}
          // A model-written URL: no referrer, lazy, never upscaled.
          referrerPolicy="no-referrer"
          loading="lazy"
          className={cn(
            "mx-auto block max-h-[420px] max-w-full rounded-lg border border-border object-contain",
            selected && "ring-2 ring-ring ring-offset-2 ring-offset-background",
          )}
        />
        {alt ? (
          <figcaption className="mt-2 text-center text-[13px] text-muted-foreground">
            {alt}
          </figcaption>
        ) : null}
      </figure>
      {props.children}
    </PlateElement>
  );
}

/**
 * Headings, from Plate's shadcn registry (`platejs.org/r/heading-node`),
 * adapted to the document look: a serif display face for every level, a large
 * title (h1), and room on the right (`pr-10`) for a fold chevron the canvas
 * places there.
 */
import { cva, type VariantProps } from "class-variance-authority";
import { PlateElement, type PlateElementProps } from "platejs/react";

const headingVariants = cva("relative pr-10 font-serif text-foreground", {
  variants: {
    variant: {
      h1: "mb-3 mt-10 text-[2.15rem] font-medium leading-[1.12] tracking-[-0.015em] first:mt-0 sm:text-[2.6rem]",
      h2: "mb-2 mt-10 text-[1.45rem] font-medium leading-snug tracking-[-0.01em] sm:text-[1.6rem]",
      h3: "mb-1.5 mt-7 text-[1.2rem] font-medium leading-snug",
      h4: "mb-1 mt-6 text-[1.05rem] font-semibold leading-snug",
    },
  },
});

export function HeadingElement({
  variant = "h1",
  ...props
}: PlateElementProps & VariantProps<typeof headingVariants>) {
  return (
    <PlateElement as={variant ?? "h1"} className={headingVariants({ variant })} {...props}>
      {props.children}
    </PlateElement>
  );
}

export const H1Element = (props: PlateElementProps) => <HeadingElement variant="h1" {...props} />;
export const H2Element = (props: PlateElementProps) => <HeadingElement variant="h2" {...props} />;
export const H3Element = (props: PlateElementProps) => <HeadingElement variant="h3" {...props} />;
export const H4Element = (props: PlateElementProps) => <HeadingElement variant="h4" {...props} />;

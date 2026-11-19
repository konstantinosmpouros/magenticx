/**
 * A file-type mark people recognise at a glance (plan 44, the export panel),
 * drawn the way Claude Docs' export list draws them — no tile behind, about
 * 24px: Word as a blue page with a white W (Office-file style), PDF as a
 * small red rounded badge reading "PDF", Markdown as the plain Markdown mark
 * (M↓) in the text colour. Generic marks in the colours those files are
 * known by — not the vendors' logos, which are their trademarks; the
 * Markdown mark is public domain (CC0, Dustin Curtis).
 *
 * Written from scratch: lucide has no file-type marks and none of the
 * prebuilt sources (shadcn, AI Elements) ship them. Colours come from the
 * `--file-word` / `--file-pdf` / `--file-mark-fg` tokens (styles/theme),
 * never raw values.
 */
import { cn } from "@/shared/lib/utils";

export type FileTypeKind = "docx" | "pdf" | "md";

export function FileTypeIcon({ kind, className }: { kind: FileTypeKind; className?: string }) {
  const box = cn("flex size-6 shrink-0 items-center justify-center", className);

  if (kind === "docx") {
    return (
      <span aria-hidden="true" className={box}>
        <svg viewBox="0 0 24 24" className="size-6">
          {/* A page with a folded corner… */}
          <path
            className="fill-file-word"
            d="M6.4 1.5h7.9c.4 0 .78.16 1.06.44l4.2 4.2c.28.28.44.66.44 1.06V21a1.5 1.5 0 0 1-1.5 1.5H6.4A1.5 1.5 0 0 1 4.9 21V3a1.5 1.5 0 0 1 1.5-1.5z"
          />
          <path
            className="fill-file-fg"
            fillOpacity="0.4"
            d="M14.2 1.6v4.3c0 .55.45 1 1 1h4.3z"
          />
          {/* …and a bold W on it. */}
          <path
            className="fill-file-fg"
            transform="translate(6.2 8.4) scale(0.54)"
            d="M2.6 4.5h3.3l2.2 10.1 2.5-10.1h2.8l2.5 10.1 2.2-10.1h3.3l-3.8 15h-3.1L12 9.6l-2.5 9.9H6.4z"
          />
        </svg>
      </span>
    );
  }

  if (kind === "pdf") {
    return (
      <span aria-hidden="true" className={box}>
        <span className="rounded-[4px] bg-file-pdf px-[3px] py-[3px] text-[8.5px] font-extrabold leading-none tracking-[0.03em] text-file-fg">
          PDF
        </span>
      </span>
    );
  }

  return (
    <span aria-hidden="true" className={cn(box, "text-foreground")}>
      <svg viewBox="0 0 208 128" className="w-[22px]" fill="currentColor">
        {/* The Markdown mark (CC0). */}
        <path d="M30 98V30h20l20 25 20-25h20v68H90V59L70 84 50 59v39zm125 0-30-33h20V30h20v35h20z" />
        <rect
          x="7"
          y="7"
          width="194"
          height="114"
          rx="12"
          fill="none"
          stroke="currentColor"
          strokeWidth="14"
        />
      </svg>
    </span>
  );
}

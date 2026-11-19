/**
 * A file-type mark people recognise at a glance (plan 44, the export panel),
 * about 24px, drawn the way the user asked for (2026-11-19): Word as the
 * Office-style tile — a blue square with a white W in front of a stack of
 * pages in three shades of the same blue; PDF as a red rounded square reading
 * "PDF"; Markdown as the Markdown mark (M↓) in a rounded frame, in the text
 * colour. Generic drawings in the colours those files are known by; the
 * Markdown mark is public domain (CC0, Dustin Curtis).
 *
 * Written from scratch: lucide has no file-type marks and none of the
 * prebuilt sources (shadcn, AI Elements) ship them. Colours come from the
 * `--file-word` / `--file-pdf` / `--file-mark-fg` tokens (styles/theme) —
 * the Word shades are that one blue at lower opacity and, for the front tile,
 * a CSS brightness filter — never raw values.
 */
import { useId } from "react";

import { cn } from "@/shared/lib/utils";

export type FileTypeKind = "docx" | "pdf" | "md";

/** The W, drawn on a 24-unit grid (x 2.6–21.4, y 4.5–19.5). */
const W_PATH =
  "M2.6 4.5h3.3l2.2 10.1 2.5-10.1h2.8l2.5 10.1 2.2-10.1h3.3l-3.8 15h-3.1L12 9.6l-2.5 9.9H6.4z";

function WordMark() {
  // Unique per instance: several marks can be on screen at once.
  const clip = useId();
  return (
    <svg viewBox="0 0 24 24" className="size-6">
      <defs>
        <clipPath id={clip}>
          <rect x="7" y="2" width="15.5" height="20" rx="2.6" />
        </clipPath>
      </defs>
      {/* The pages behind: three bands, lighter at the top. */}
      <g clipPath={`url(#${clip})`}>
        <rect className="fill-file-word" fillOpacity="0.5" x="7" y="2" width="15.5" height="6.7" />
        <rect className="fill-file-word" fillOpacity="0.72" x="7" y="8.7" width="15.5" height="6.7" />
        <rect className="fill-file-word" fillOpacity="0.92" x="7" y="15.4" width="15.5" height="6.6" />
      </g>
      {/* The tile in front, a shade deeper, with the W. */}
      <rect className="fill-file-word brightness-[0.8]" x="1.5" y="6" width="12" height="12" rx="2.2" />
      <path className="fill-file-fg" transform="translate(1.5 6) scale(0.5)" d={W_PATH} />
    </svg>
  );
}

export function FileTypeIcon({ kind, className }: { kind: FileTypeKind; className?: string }) {
  const box = cn("flex size-6 shrink-0 items-center justify-center", className);

  if (kind === "docx") {
    return (
      <span aria-hidden="true" className={box}>
        <WordMark />
      </span>
    );
  }

  if (kind === "pdf") {
    return (
      <span aria-hidden="true" className={box}>
        <span className="flex size-[22px] items-center justify-center rounded-[5px] bg-file-pdf text-[7.5px] font-extrabold leading-none tracking-[0.02em] text-file-fg">
          PDF
        </span>
      </span>
    );
  }

  return (
    <span aria-hidden="true" className={cn(box, "text-foreground")}>
      <svg viewBox="0 0 208 128" className="w-[22px]" fill="currentColor">
        {/* The Markdown mark (CC0) in its frame. */}
        <path d="M30 98V30h20l20 25 20-25h20v68H90V59L70 84 50 59v39zm125 0-30-33h20V30h20v35h20z" />
        <rect
          x="7"
          y="7"
          width="194"
          height="114"
          rx="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="14"
        />
      </svg>
    </span>
  );
}

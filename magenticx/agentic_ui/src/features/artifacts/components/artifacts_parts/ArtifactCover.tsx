/**
 * A card's cover on the Artifacts page: the file's family drawn as a small
 * sheet of paper — prose lines, a spreadsheet grid, a slide with a chart, a
 * framed picture, indented code — on a wash of the family's colour, with a
 * second sheet behind it. On the card's hover the front sheet rises and tilts
 * and the back one fans out (transform only, so it stays on the compositor).
 *
 * Written from scratch: it is an illustration of the file's kind, not a
 * control, and no prebuilt source draws one. Colours are the `--file-*` and
 * semantic tokens (via `FileAccent`), never raw values. It never loads the
 * file itself — a cover costs no request.
 */
import type { ReactNode } from "react";

import { cn } from "@/shared/lib/utils";
import type { FileAccent, FileVisual } from "@/features/artifacts/lib/fileFilters";

/** A grey line of "text" on a sheet. */
function Line({ className }: { className?: string }) {
  return <span className={cn("block h-[3px] rounded-full bg-muted-foreground/25", className)} />;
}

function ProseSheet({ accent, heading = true }: { accent: FileAccent; heading?: boolean }) {
  return (
    <div className="space-y-[5px]">
      {heading ? <span className={cn("mb-2 block h-[5px] w-3/5 rounded-full opacity-80", accent.dot)} /> : null}
      <Line className="w-full" />
      <Line className="w-11/12" />
      <Line className="w-4/5" />
      <Line className="w-full" />
      <Line className="w-2/3" />
      <Line className="w-5/6" />
    </div>
  );
}

function PdfSheet({ accent }: { accent: FileAccent }) {
  return (
    <div>
      <span
        className={cn(
          "mb-2 inline-flex rounded-[3px] px-1 py-px text-[7px] font-bold leading-none tracking-wide text-file-fg",
          accent.dot,
        )}
      >
        PDF
      </span>
      <ProseSheet accent={accent} heading={false} />
    </div>
  );
}

function SheetGrid({ accent }: { accent: FileAccent }) {
  return (
    <div className="grid grid-cols-4 gap-px overflow-hidden rounded-[3px] bg-border/70 ring-1 ring-border/70">
      {Array.from({ length: 20 }, (_, i) => (
        <span
          key={i}
          className={cn(
            "h-[9px]",
            i < 4 ? cn(accent.soft, "brightness-110") : "bg-card",
            i % 4 === 0 && i >= 4 ? "bg-muted/60" : null,
          )}
        />
      ))}
    </div>
  );
}

function SlideFrame({ accent }: { accent: FileAccent }) {
  return (
    <div className="flex h-full flex-col">
      <span className={cn("mb-2 block h-[5px] w-1/2 rounded-full opacity-80", accent.dot)} />
      <div className="mt-auto flex h-[46%] items-end gap-[5px]">
        {[45, 70, 55, 90].map((height, i) => (
          <span
            key={i}
            className={cn("flex-1 rounded-t-[2px]", accent.dot, i === 3 ? "opacity-90" : "opacity-40")}
            style={{ height: `${height}%` }}
          />
        ))}
      </div>
    </div>
  );
}

function PictureFrame({ accent }: { accent: FileAccent }) {
  return (
    <div className={cn("relative h-full overflow-hidden rounded-[4px]", accent.soft)}>
      <span className={cn("absolute right-[18%] top-[18%] h-3 w-3 rounded-full opacity-70", accent.dot)} />
      <svg
        viewBox="0 0 100 60"
        preserveAspectRatio="none"
        className={cn("absolute inset-x-0 bottom-0 h-3/5 w-full", accent.text)}
        aria-hidden
      >
        <path d="M0 60 L0 38 L26 16 L46 36 L62 24 L100 52 L100 60 Z" fill="currentColor" opacity="0.55" />
        <path d="M0 60 L0 50 L34 34 L58 48 L80 40 L100 50 L100 60 Z" fill="currentColor" opacity="0.85" />
      </svg>
    </div>
  );
}

function CodeSheet({ accent }: { accent: FileAccent }) {
  const rows: [number, string, string][] = [
    [0, "w-1/3", "w-1/4"],
    [1, "w-1/4", "w-2/5"],
    [2, "w-1/5", "w-1/3"],
    [2, "w-1/3", "w-1/5"],
    [1, "w-1/6", "w-1/4"],
    [0, "w-1/4", ""],
  ];
  return (
    <div className="space-y-[5px] font-mono">
      {rows.map(([indent, a, b], i) => (
        <span key={i} className="flex gap-[3px]" style={{ paddingLeft: indent * 8 }}>
          <span className={cn("h-[3px] rounded-full opacity-75", accent.dot, a)} />
          {b ? <span className={cn("h-[3px] rounded-full bg-muted-foreground/25", b)} /> : null}
        </span>
      ))}
    </div>
  );
}

function OtherSheet({ accent }: { accent: FileAccent }) {
  return (
    <div className="grid h-full place-items-center">
      <span className={cn("grid h-9 w-9 place-items-center rounded-xl ring-1", accent.soft, accent.ring)}>
        <span className={cn("h-3 w-3 rotate-45 rounded-[3px] opacity-70", accent.dot)} />
      </span>
    </div>
  );
}

const DRAWINGS: Record<FileVisual, (accent: FileAccent) => ReactNode> = {
  doc: (accent) => <ProseSheet accent={accent} />,
  text: (accent) => <ProseSheet accent={accent} />,
  pdf: (accent) => <PdfSheet accent={accent} />,
  sheet: (accent) => <SheetGrid accent={accent} />,
  slides: (accent) => <SlideFrame accent={accent} />,
  image: (accent) => <PictureFrame accent={accent} />,
  code: (accent) => <CodeSheet accent={accent} />,
  other: (accent) => <OtherSheet accent={accent} />,
};

/** Slides and pictures are landscape; everything else is a page. */
const LANDSCAPE: ReadonlySet<FileVisual> = new Set(["slides", "image"]);

export function ArtifactCover({
  visual,
  accent,
  children,
}: {
  visual: FileVisual;
  accent: FileAccent;
  /** Badges laid over the cover (extension, size, the action dock). */
  children?: ReactNode;
}) {
  const landscape = LANDSCAPE.has(visual);
  return (
    <div
      className={cn(
        "relative h-36 overflow-hidden bg-gradient-to-br via-transparent to-transparent",
        accent.wash,
      )}
    >
      {/* A faint dot grid, so the wash reads as a surface rather than a stain. */}
      <div
        aria-hidden
        className="absolute inset-0 opacity-60 [background-image:radial-gradient(hsl(var(--border))_1px,transparent_1px)] [background-size:14px_14px] [mask-image:linear-gradient(to_bottom,black,transparent)]"
      />
      <div aria-hidden className={cn("absolute left-1/2 bottom-0", landscape ? "translate-y-[18%]" : "translate-y-[26%]")}>
        <div className={cn("relative", landscape ? "h-[5.25rem] w-[8.5rem]" : "h-32 w-[6.25rem]")}>
          <span
            className={cn(
              "absolute inset-0 -translate-x-1/2 rotate-[7deg] rounded-lg bg-card/70 shadow-sm ring-1 ring-border/60",
              "transition-transform duration-300 ease-out group-hover:translate-x-[-38%] group-hover:rotate-[11deg] motion-reduce:transition-none",
            )}
          />
          <div
            className={cn(
              "absolute inset-0 -translate-x-1/2 -rotate-[2deg] overflow-hidden rounded-lg bg-card p-2.5 shadow-[0_10px_30px_-12px_hsl(var(--foreground)/0.35)] ring-1 ring-border/70",
              "transition-transform duration-300 ease-out group-hover:-translate-y-2 group-hover:rotate-[-4deg] motion-reduce:transition-none",
            )}
          >
            {DRAWINGS[visual](accent)}
          </div>
        </div>
      </div>
      {children}
    </div>
  );
}

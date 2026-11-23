/**
 * The Artifacts page's illustration: three small file cards — a document, a
 * sheet, a picture — fanned over a soft glow in the theme's primary, each
 * drifting on its own slow loop. It sits beside the page's heading and over
 * the empty state, and says "your files, made and gathered" without words.
 *
 * Written from scratch: decorative art, not a control (aria-hidden). Motion is
 * transform-only and stops under reduced motion; colours are tokens.
 */
import { motion, useReducedMotion } from "framer-motion";
import { FileImage, FileSpreadsheet, FileText, Sparkles, type LucideIcon } from "lucide-react";

import { cn } from "@/shared/lib/utils";

type Tile = {
  icon: LucideIcon;
  /** Tailwind classes for its colour (the `--file-*` tokens). */
  tone: string;
  bar: string;
  /** Resting place: position and tilt. */
  place: string;
  rotate: number;
  /** One float loop, seconds; the three differ so they never move as one. */
  period: number;
};

const TILES: Tile[] = [
  { icon: FileSpreadsheet, tone: "text-file-sheet bg-file-sheet/10 ring-file-sheet/25", bar: "bg-file-sheet", place: "left-0 top-6", rotate: -9, period: 6.5 },
  { icon: FileImage, tone: "text-file-image bg-file-image/10 ring-file-image/25", bar: "bg-file-image", place: "right-0 top-3", rotate: 8, period: 7.5 },
  { icon: FileText, tone: "text-file-word bg-file-word/10 ring-file-word/25", bar: "bg-file-word", place: "left-1/2 top-0 -ml-12 z-10", rotate: -1, period: 5.5 },
];

export function FileStackArt({ className }: { className?: string }) {
  const reduceMotion = useReducedMotion();

  return (
    <div aria-hidden className={cn("relative h-40 w-64", className)}>
      <div className="absolute inset-x-6 inset-y-4 rounded-full bg-primary/20 blur-3xl" />
      {TILES.map((tile, i) => {
        const Icon = tile.icon;
        return (
          <motion.div
            key={i}
            className={cn("absolute", tile.place)}
            initial={reduceMotion ? false : { opacity: 0, y: 18, rotate: tile.rotate }}
            animate={
              reduceMotion
                ? { opacity: 1, rotate: tile.rotate }
                : { opacity: 1, y: [0, -7, 0], rotate: tile.rotate }
            }
            transition={
              reduceMotion
                ? { duration: 0 }
                : {
                    opacity: { duration: 0.5, delay: 0.1 + i * 0.08 },
                    y: { duration: tile.period, repeat: Infinity, ease: "easeInOut", delay: i * 0.4 },
                  }
            }
          >
            <div className="w-24 rounded-2xl bg-card p-2.5 shadow-[0_18px_40px_-18px_hsl(var(--foreground)/0.35)] ring-1 ring-border/70">
              <span className={cn("grid h-8 w-8 place-items-center rounded-lg ring-1", tile.tone)}>
                <Icon size={16} />
              </span>
              <span className={cn("mt-2.5 block h-[4px] w-3/4 rounded-full opacity-70", tile.bar)} />
              <span className="mt-1.5 block h-[3px] w-full rounded-full bg-muted-foreground/20" />
              <span className="mt-1 block h-[3px] w-2/3 rounded-full bg-muted-foreground/20" />
            </div>
          </motion.div>
        );
      })}
      <motion.span
        className="absolute -right-1 bottom-4 z-20 grid h-8 w-8 place-items-center rounded-full bg-primary text-primary-foreground shadow-lg shadow-primary/30"
        initial={reduceMotion ? false : { scale: 0.4, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 320, damping: 18, delay: 0.45 }}
      >
        <Sparkles size={15} />
      </motion.span>
    </div>
  );
}

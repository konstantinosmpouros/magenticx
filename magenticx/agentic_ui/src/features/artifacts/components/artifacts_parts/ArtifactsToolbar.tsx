import { useEffect, useId, useRef } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { LayoutGrid, List, Search, X } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import {
  KIND_FILTERS,
  TYPE_FILTERS,
  typeAccent,
  type KindFilter,
  type TypeFilter,
} from "@/features/artifacts/lib/fileFilters";
import type { ArtifactsView } from "@/features/artifacts/hooks/useArtifactsView";

const PILL_SPRING = { type: "spring", stiffness: 520, damping: 40, mass: 0.8 } as const;

/** Typing in a field (or an editor) keeps "/" for itself. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * The Artifacts page's search, filters and layout switch — one bar that stays
 * pinned to the top of the page while the files scroll under it (frosted, so
 * the files stay faintly visible through it).
 *
 * - Search: "/" focuses it from anywhere on the page; Escape clears it, then
 *   leaves it.
 * - Kind (All / Inputs / Outputs) and type chips: toggle buttons
 *   (`aria-pressed`) whose selection is a pill that glides to the chosen one
 *   (a shared framer-motion layout id). Each type chip carries its family's
 *   colour, the same as the cards. The chips scroll sideways on a phone
 *   instead of wrapping into a wall.
 * - Grid / List.
 *
 * Custom rather than the shared `Segmented`: that one is a radiogroup that
 * fills its row; these are toggle buttons sized to their labels, three groups
 * in one bar.
 */
export function ArtifactsToolbar({
  query,
  onQueryChange,
  kind,
  onKindChange,
  type,
  onTypeChange,
  view,
  onViewChange,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  kind: KindFilter;
  onKindChange: (kind: KindFilter) => void;
  type: TypeFilter;
  onTypeChange: (type: TypeFilter) => void;
  view: ArtifactsView;
  onViewChange: (view: ArtifactsView) => void;
}) {
  const reduceMotion = useReducedMotion();
  const pillTransition = reduceMotion ? { duration: 0 } : PILL_SPRING;
  const id = useId();
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="group/search relative min-w-[12rem] flex-1">
          <Search
            size={15}
            aria-hidden
            className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors group-focus-within/search:text-primary"
          />
          <label htmlFor="artifacts-search" className="sr-only">
            Search files by name
          </label>
          <input
            ref={searchRef}
            id="artifacts-search"
            type="search"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              // Clear first, leave second — and never let Escape reach the
              // page's own handlers (closing a panel) while it has work here.
              e.stopPropagation();
              if (query) onQueryChange("");
              else e.currentTarget.blur();
            }}
            placeholder="Search by file name…"
            maxLength={200}
            className="h-11 w-full rounded-xl border border-border/60 bg-card/70 pl-10 pr-12 text-sm text-foreground shadow-[0_1px_0_hsl(var(--foreground)/0.03)] transition-[border-color,box-shadow] placeholder:text-muted-foreground focus-visible:border-primary/40 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/10 [&::-webkit-search-cancel-button]:hidden"
          />
          {query ? (
            <button
              type="button"
              onClick={() => {
                onQueryChange("");
                searchRef.current?.focus();
              }}
              aria-label="Clear search"
              className="absolute right-1.5 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-[hsl(var(--hover-surface))] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              <X size={14} aria-hidden />
            </button>
          ) : (
            <kbd
              aria-hidden
              className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded-md border border-border/70 bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground [@media(hover:hover)]:inline-block"
            >
              /
            </kbd>
          )}
        </div>

        <div role="group" aria-label="Show" className="inline-flex items-center gap-0.5 rounded-xl bg-muted/50 p-1 ring-1 ring-inset ring-border/40">
          {KIND_FILTERS.map((option) => {
            const active = kind === option.id;
            const Icon = option.icon;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => onKindChange(option.id)}
                aria-pressed={active}
                className={cn(
                  "relative inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition-colors active:scale-[0.97]",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                  active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {active ? (
                  <motion.span
                    layoutId={`${id}-kind`}
                    transition={pillTransition}
                    className="absolute inset-0 rounded-lg bg-background shadow-sm ring-1 ring-border/50"
                  />
                ) : null}
                <Icon size={14} aria-hidden className={cn("relative", active && option.id === "output" && "text-primary")} />
                <span className="relative">{option.label}</span>
              </button>
            );
          })}
        </div>

        <div role="group" aria-label="Layout" className="inline-flex items-center gap-0.5 rounded-xl bg-muted/50 p-1 ring-1 ring-inset ring-border/40">
          {(
            [
              { id: "grid", label: "Grid view", icon: LayoutGrid },
              { id: "list", label: "List view", icon: List },
            ] as const
          ).map((option) => {
            const active = view === option.id;
            const Icon = option.icon;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => onViewChange(option.id)}
                aria-pressed={active}
                aria-label={option.label}
                title={option.label}
                className={cn(
                  "relative grid h-9 w-9 place-items-center rounded-lg transition-colors active:scale-[0.95]",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                  active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {active ? (
                  <motion.span
                    layoutId={`${id}-view`}
                    transition={pillTransition}
                    className="absolute inset-0 rounded-lg bg-background shadow-sm ring-1 ring-border/50"
                  />
                ) : null}
                <Icon size={16} aria-hidden className="relative" />
              </button>
            );
          })}
        </div>
      </div>

      {/* Bleeds to the screen edge on a phone so the row reads as scrollable. */}
      <div
        role="group"
        aria-label="File type"
        className="scrollbar-none -mx-4 flex gap-1.5 overflow-x-auto px-4 pb-0.5 sm:mx-0 sm:flex-wrap sm:px-0"
      >
        {TYPE_FILTERS.map((option) => {
          const active = type === option.id;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => onTypeChange(option.id)}
              aria-pressed={active}
              className={cn(
                "relative inline-flex h-8 flex-shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors active:scale-[0.97]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                active
                  ? "text-primary"
                  : "bg-muted/40 text-muted-foreground hover:bg-muted/70 hover:text-foreground",
              )}
            >
              {active ? (
                <motion.span
                  layoutId={`${id}-type`}
                  transition={pillTransition}
                  className="absolute inset-0 rounded-full bg-primary/10 ring-1 ring-inset ring-primary/25"
                />
              ) : null}
              {option.id === "all" ? null : (
                <span aria-hidden className={cn("relative h-1.5 w-1.5 rounded-full", typeAccent(option.id).dot)} />
              )}
              <span className="relative">{option.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

import { useState } from "react";
import { AnimatePresence, motion, type MotionProps } from "framer-motion";
import { ChevronDown, FileStack, Lock, RotateCw } from "lucide-react";

import { Button } from "@/shared/ui/button";
import { cn } from "@/shared/lib/utils";
import type { PlatformSkillsState } from "@/features/settings/hooks/usePlatformSkills";
import { InfoCard, SoftPanel } from "./shared";
import SkillFilesViewer from "./SkillFilesViewer";
import SkillProvenance from "./SkillProvenance";

/**
 * PlatformSkillsView — the Skills tab's "Platform" page (plan 44): the skills
 * that ship with mAgenticX and are on for every deep agent.
 *
 * Read-only by design, so it is a sibling of the pool view rather than a mode
 * of it: the same InfoCard → SoftPanel card chrome and expand-to-read pattern,
 * but no remove control and no toggle — a "Platform · Always on" badge says why
 * instead. Composed from the tab's own parts (no shadcn primitive covers a
 * provenance card list).
 */
type PlatformSkillsViewProps = {
  platform: PlatformSkillsState;
  cardMotion: (index: number) => MotionProps;
  prefersReducedMotion: boolean | null;
};

const fileCountLabel = (n: number) => `${n} file${n === 1 ? "" : "s"}`;

export default function PlatformSkillsView({
  platform,
  cardMotion,
  prefersReducedMotion,
}: PlatformSkillsViewProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const toggle = (name: string) => {
    const willOpen = !expanded[name];
    if (willOpen) platform.loadDetail(name);
    setExpanded((prev) => ({ ...prev, [name]: willOpen }));
  };

  return (
    <InfoCard>
      <div className="flex flex-col gap-3">
        <p className="flex items-start gap-2 rounded-[1.1rem] bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary/70" aria-hidden />
          <span>
            Every deep agent has these, read-only — they can't be removed or switched off per
            agent. A skill of yours with the same name takes precedence.
          </span>
        </p>

        {platform.error ? (
          <div className="flex flex-col items-start gap-2 rounded-[1.1rem] bg-destructive/5 px-4 py-4">
            <p className="text-sm text-foreground">Could not load the platform skills.</p>
            <p className="text-xs text-muted-foreground">{platform.error}</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={platform.retry}
              className="h-8 gap-1.5 px-3 text-xs"
            >
              <RotateCw className="h-3.5 w-3.5" aria-hidden />
              Try again
            </Button>
          </div>
        ) : platform.loading && platform.skills.length === 0 ? (
          <div className="flex flex-col gap-3" aria-hidden>
            {[0, 1, 2].map((row) => (
              <SoftPanel key={row} className="p-4">
                <div className="flex flex-col gap-2">
                  <div className="h-3.5 w-32 animate-pulse rounded bg-muted" />
                  <div className="h-3 w-full animate-pulse rounded bg-muted/70" />
                  <div className="h-3 w-1/2 animate-pulse rounded bg-muted/50" />
                </div>
              </SoftPanel>
            ))}
          </div>
        ) : platform.skills.length === 0 ? (
          <p className="rounded-[1.1rem] bg-muted/30 px-4 py-4 text-sm text-muted-foreground">
            Platform skills are switched off on this server. Your own skills still work as usual.
          </p>
        ) : (
          <AnimatePresence initial={false}>
            {platform.skills.map((skill, index) => {
              const isOpen = Boolean(expanded[skill.name]);
              const detail = platform.details[skill.name];
              const detailError = platform.detailErrors[skill.name];
              const loadingDetail = platform.isDetailLoading(skill.name);
              return (
                <motion.div key={skill.name} {...cardMotion(index)}>
                  <SoftPanel className="p-4">
                    <button
                      type="button"
                      onClick={() => toggle(skill.name)}
                      className="flex w-full items-start justify-between gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-expanded={isOpen}
                    >
                      <div className="flex min-w-0 flex-col gap-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <p className="truncate text-sm font-semibold text-foreground">
                            {skill.name}
                          </p>
                          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/30 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                            <Lock className="h-2.5 w-2.5" aria-hidden />
                            Platform
                          </span>
                          <span className="inline-flex shrink-0 items-center rounded-md border border-border/40 bg-background/50 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            Always on
                          </span>
                        </div>
                        <p className="line-clamp-2 text-xs text-muted-foreground">
                          {skill.description || "No description provided."}
                        </p>
                      </div>
                      <ChevronDown
                        className={cn(
                          "mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                          isOpen && "rotate-180",
                        )}
                        aria-hidden
                      />
                    </button>
                    {/* Outside the toggle: the provenance carries a link, and a
                        link inside a button is invalid and unreachable by Tab. */}
                    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <SkillProvenance
                        sourceLabel={skill.sourceLabel || "mAgenticX"}
                        commit={skill.sourceCommit}
                        licence={skill.licence}
                        upstreamUrl={skill.upstreamUrl}
                      />
                      {skill.fileCount > 0 ? (
                        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                          <FileStack className="h-3 w-3 shrink-0" aria-hidden />
                          {fileCountLabel(skill.fileCount)}
                        </span>
                      ) : null}
                    </div>
                    {isOpen ? (
                      <div className="mt-3">
                        {detail ? (
                          <SkillFilesViewer
                            files={[]}
                            fallbackContent={detail.content}
                            prefersReducedMotion={prefersReducedMotion}
                          />
                        ) : detailError ? (
                          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            <span>Could not load SKILL.md.</span>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => platform.loadDetail(skill.name)}
                              className="h-7 gap-1 px-2 text-xs"
                            >
                              <RotateCw className="h-3 w-3" aria-hidden />
                              Retry
                            </Button>
                          </div>
                        ) : loadingDetail ? (
                          <p className="text-xs text-muted-foreground">Loading SKILL.md…</p>
                        ) : null}
                      </div>
                    ) : null}
                  </SoftPanel>
                </motion.div>
              );
            })}
          </AnimatePresence>
        )}
      </div>
    </InfoCard>
  );
}

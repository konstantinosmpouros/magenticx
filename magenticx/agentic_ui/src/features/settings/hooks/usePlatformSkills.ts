import { useCallback, useEffect, useRef, useState } from "react";

import { getPlatformSkillDetail, getPlatformSkills } from "@/shared/lib/api";
import type { PlatformSkill, PlatformSkillDetail } from "@/shared/lib/types";

// The Skills tab's platform skills (plan 44): the document skills that ship with
// the agents image and are on for every deep agent. Read-only — there is nothing
// to add, assign or remove — so the hook only reads:
//
// - the list once per tab entry (the tab mounts on entry), feeding the hub
//   row's count and the Platform view;
// - a skill's SKILL.md on demand, when its card is opened, kept for the visit
//   (unlike a pool skill, a platform skill only changes with a release);
// - failures surface inline with a retry, never as a toast.

export type PlatformSkillsState = {
  skills: PlatformSkill[];
  loading: boolean;
  error: string | null;
  retry: () => void;
  details: Record<string, PlatformSkillDetail>;
  detailErrors: Record<string, string>;
  isDetailLoading: (name: string) => boolean;
  loadDetail: (name: string) => void;
};

export function usePlatformSkills(): PlatformSkillsState {
  const [skills, setSkills] = useState<PlatformSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [details, setDetails] = useState<Record<string, PlatformSkillDetail>>({});
  const [detailErrors, setDetailErrors] = useState<Record<string, string>>({});
  const [loadingDetails, setLoadingDetails] = useState<Set<string>>(new Set());
  // Synchronous guard so two quick opens of one card fetch once.
  const inFlightRef = useRef<Set<string>>(new Set());
  const detailsRef = useRef<Record<string, PlatformSkillDetail>>({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getPlatformSkills()
      .then((rows) => {
        if (cancelled) return;
        setSkills(rows);
        setError(null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Could not load the platform skills.");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const loadDetail = useCallback((name: string) => {
    if (detailsRef.current[name] || inFlightRef.current.has(name)) return;
    inFlightRef.current.add(name);
    setLoadingDetails(new Set(inFlightRef.current));
    setDetailErrors((prev) => {
      if (!(name in prev)) return prev;
      const { [name]: _cleared, ...rest } = prev;
      return rest;
    });
    getPlatformSkillDetail(name)
      .then((detail) => {
        detailsRef.current = { ...detailsRef.current, [name]: detail };
        setDetails(detailsRef.current);
      })
      .catch((err: unknown) => {
        setDetailErrors((prev) => ({
          ...prev,
          [name]: err instanceof Error ? err.message : "Could not load the skill.",
        }));
      })
      .finally(() => {
        inFlightRef.current.delete(name);
        setLoadingDetails(new Set(inFlightRef.current));
      });
  }, []);

  const isDetailLoading = useCallback((name: string) => loadingDetails.has(name), [loadingDetails]);

  return { skills, loading, error, retry, details, detailErrors, isDetailLoading, loadDetail };
}

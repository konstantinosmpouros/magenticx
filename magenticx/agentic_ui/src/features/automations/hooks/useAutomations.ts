import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  createScheduledTask,
  deleteScheduledTask,
  listScheduledTasks,
  updateScheduledTask,
} from "@/shared/lib/api";
import type {
  ScheduleAutomationItem,
  ScheduledTask,
  ScheduledTaskCreatePayload,
  ScheduledTaskUpdatePayload,
} from "@/shared/lib/types";
import { isRunningTask } from "@/features/automations/lib/schedule";

// While the Automations page is active we poll fast for snappy live status;
// while the user is elsewhere we poll slowly just to keep the sidebar "running"
// badge fresh (there is no push channel for work the client hasn't subscribed
// to — discovery is by poll).
const ACTIVE_POLL_MS = 8000;
const BACKGROUND_POLL_MS = 60000;

const isTabHidden = () => typeof document !== "undefined" && document.hidden;

/**
 * Whether a polled list says nothing new (plan 45): the same tasks, in the same
 * order, with the same fields. The list is small (a user's automations), so a
 * JSON compare is cheap and catches every field a card shows (status, last
 * run, next run) without naming them. Keeping the previous array when nothing
 * changed is what stops a poll from re-rendering the page and the sidebar.
 */
const sameTasks = (a: ScheduledTask[], b: ScheduledTask[]): boolean =>
  a.length === b.length && JSON.stringify(a) === JSON.stringify(b);

// `active` is the "/automations" route flag (the page is URL-driven, not
// state-driven), and only controls poll cadence — the route decides what renders.
type UseAutomationsArgs = { userId: string | null | undefined; active: boolean };

/**
 * The user's automations: the list (polled), its CRUD, and the running count
 * for the sidebar badge. The wire is still scheduled tasks in Phase 1; the list
 * is handed out as `ScheduleAutomationItem`s, the Schedules area's cards.
 */
export function useAutomations({ userId, active }: UseAutomationsArgs) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  // `loading` is the first load only: a background poll must not swap the page
  // for skeletons (that remounted the empty state's animated mark every 8s).
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);

  useEffect(() => {
    loadedRef.current = false;
  }, [userId]);

  const refresh = useCallback(async () => {
    if (!userId) return;
    if (!loadedRef.current) setLoading(true);
    try {
      const next = await listScheduledTasks(userId);
      setTasks((prev) => (sameTasks(prev, next) ? prev : next));
      setError(null);
    } catch (err) {
      if (import.meta.env.DEV) console.error("Failed to load automations:", err);
      setError("Could not load your automations.");
    } finally {
      loadedRef.current = true;
      setLoading(false);
    }
  }, [userId]);

  const create = useCallback(
    async (payload: ScheduledTaskCreatePayload) => {
      if (!userId) throw new Error("Not signed in.");
      const task = await createScheduledTask(userId, payload);
      setTasks((prev) => [task, ...prev]);
      return task;
    },
    [userId],
  );

  const update = useCallback(
    async (taskId: string, payload: ScheduledTaskUpdatePayload) => {
      if (!userId) throw new Error("Not signed in.");
      const task = await updateScheduledTask(userId, taskId, payload);
      setTasks((prev) => prev.map((t) => (t.id === taskId ? task : t)));
      return task;
    },
    [userId],
  );

  const remove = useCallback(
    async (taskId: string) => {
      if (!userId) throw new Error("Not signed in.");
      let rolledBack: ScheduledTask[] = [];
      setTasks((cur) => {
        rolledBack = cur;
        return cur.filter((t) => t.id !== taskId);
      });
      try {
        await deleteScheduledTask(userId, taskId);
      } catch (err) {
        setTasks(rolledBack);
        throw err;
      }
    },
    [userId],
  );

  // Initial load + cadence-switching poll (fast on /automations, slow off it).
  // A hidden tab polls nothing (plan 45): no one is looking at the badge or the
  // cards. Coming back into view polls at once if a tick was missed, then the
  // cadence carries on.
  useEffect(() => {
    if (!userId) {
      setTasks((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    const intervalMs = active ? ACTIVE_POLL_MS : BACKGROUND_POLL_MS;
    let cancelled = false;
    let lastPollAt = 0;
    const tick = () => {
      if (cancelled || isTabHidden()) return;
      lastPollAt = Date.now();
      void refresh();
    };
    tick();
    const timer = window.setInterval(tick, intervalMs);
    const onVisibilityChange = () => {
      if (!isTabHidden() && Date.now() - lastPollAt >= intervalMs) tick();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [userId, active, refresh]);

  const items = useMemo<ScheduleAutomationItem[]>(
    () => tasks.map((task) => ({ kind: "schedule", task })),
    [tasks],
  );
  const runningCount = useMemo(() => tasks.filter(isRunningTask).length, [tasks]);

  return { items, loading, error, refresh, create, update, remove, runningCount };
}

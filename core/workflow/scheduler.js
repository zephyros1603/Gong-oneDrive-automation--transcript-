/**
 * core/workflow/scheduler.js — when each schedule is due.
 *
 * The semantics that matter are unchanged from the single-pipeline version and
 * are the reason this is a timer in-process rather than launchd: it cannot wake
 * the Mac, and while the Mac sleeps a slot simply passes. On wake, a slot
 * inside its grace window still runs; past it, the day is recorded as missed.
 */

import { listSchedules, getWorkflow, markScheduleRan } from './store.js';
import { runWorkflow } from './run.js';
import { ymd } from '../../gong.js';
import * as runs from '../../runs.js';

const slotFor = (date, time) => {
  const [h, m] = String(time || '09:00').split(':').map(Number);
  const d = new Date(date);
  d.setHours(h || 0, m || 0, 0, 0);
  return d;
};

export function scheduleState(s, now = new Date()) {
  const today = ymd(now);
  const slot = slotFor(now, s.time);
  const lateMs = now - slot;
  const graceMs = (s.graceMinutes || 20) * 60000;

  const scheduledToday = (s.days || []).includes(now.getDay());
  const alreadyHandled = s.lastSlot === today;

  let next = slotFor(now, s.time);
  if (now >= next) next = slotFor(new Date(now.getTime() + 86400e3), s.time);
  for (let i = 0; i < 8 && !(s.days || []).includes(next.getDay()); i++) {
    next = slotFor(new Date(next.getTime() + 86400e3), s.time);
  }

  return {
    scheduledToday,
    alreadyHandled,
    dueNow: Boolean(s.enabled && scheduledToday && !alreadyHandled && lateMs >= 0 && lateMs <= graceMs),
    missed: Boolean(s.enabled && scheduledToday && !alreadyHandled && lateMs > graceMs),
    lateMinutes: Math.round(lateMs / 60000),
    nextRunAt: s.enabled ? next.getTime() : null,
  };
}

let ticking = false;

/** Called on a timer by instrumentation.node.js. */
export async function tickSchedules({ onRun } = {}) {
  if (ticking) return [];
  ticking = true;
  const fired = [];

  try {
    const now = new Date();
    for (const s of listSchedules()) {
      const state = scheduleState(s, now);

      // Claim the slot before starting, so a slow run cannot be double-fired
      // by the next tick thirty seconds later.
      if (state.missed) { markScheduleRan(s.id, ymd(now)); continue; }
      if (!state.dueNow) continue;
      if (runs.list({ active: true }).some((r) => r.meta?.scheduleId === s.id)) continue;

      markScheduleRan(s.id, ymd(now));
      const w = getWorkflow(s.workflowId);
      if (!w) continue;

      try {
        const started = await runWorkflow(w, { trigger: 'schedule' });
        fired.push({ schedule: s.id, run: started.runId });
        onRun?.(started);
      } catch (err) {
        console.error(`  ! schedule ${s.name || s.id} failed:`, err.message);
      }
    }
  } finally {
    ticking = false;
  }
  return fired;
}

/**
 * core/workflow/window.js — one date range, understood the same way everywhere.
 *
 * Every sync needs to answer "how far back". Until now each one answered it
 * differently: the Gong pull counted days, the transcript scope counted days
 * from a different table, and the CX Portal fetch did not bother — it took the
 * customer's whole tracker history regardless of what the workflow said. So a
 * workflow set to "last 7 days" sent Claude one week of calls beside every
 * project the customer has ever had.
 *
 * This resolves a window once, into real dates, and every source is filtered
 * against the same pair.
 *
 * ## Calendar, not rolling
 *
 * "Week" means this calendar week, not the last 168 hours, because the reports
 * these windows feed are calendar things — a weekly status report covers
 * Monday to Friday, and a rolling window run on Wednesday would cover half of
 * last week and quietly restate it.
 *
 * The cost is a trap on the first morning of a period: "this week" run at
 * 09:00 on Monday covers nine hours. That is what `anchor: 'previous'` is for,
 * and why the resolved dates are shown in the UI rather than left implied.
 */

const DAY_MS = 86400e3;

/** The three buttons, in the order they are shown. */
export const PRESETS = [
  { id: 'day', label: 'Day', hint: 'Today' },
  { id: 'week', label: 'Week', hint: 'Monday to now' },
  { id: 'month', label: 'Month', hint: 'The 1st to now' },
];

export const ANCHORS = [
  { id: 'this', label: 'This' },
  { id: 'previous', label: 'Previous' },
];

/**
 * What the old string windows meant, so a workflow saved before this existed
 * keeps running unchanged rather than silently widening to a calendar month.
 */
const LEGACY = {
  all: { preset: 'custom', days: 0 },
  last2d: { preset: 'custom', days: 2 },
  last7d: { preset: 'custom', days: 7 },
  last14d: { preset: 'custom', days: 14 },
  last30d: { preset: 'custom', days: 30 },
  last90d: { preset: 'custom', days: 90 },
};

const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

/** Monday, because a working week starts there and a WSR is written about it. */
function startOfWeek(d) {
  const x = startOfDay(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

const startOfMonth = (d) => {
  const x = startOfDay(d);
  x.setDate(1);
  return x;
};

/** `YYYY-MM-DD` in local time — the form Gong's day parameters take. */
export const ymd = (t) => {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/**
 * Turn a window setting into concrete bounds.
 *
 * @param window  `'week'`, `{ preset, anchor, days, from, to }`, or one of the
 *                legacy strings.
 * @returns {{preset, anchor, from, to, days, label, fromDay, toDay, custom}}
 *          `from`/`to` are epoch ms; `to` is exclusive.
 */
export function resolveWindow(window, now = Date.now()) {
  const spec = typeof window === 'string'
    ? (LEGACY[window] || { preset: window })
    : (window || {});

  const preset = spec.preset || 'week';
  const anchor = spec.anchor === 'previous' ? 'previous' : 'this';

  // An explicit range wins over everything: if someone typed two dates they
  // mean those dates, not the preset that happens to still be selected.
  if (spec.from && spec.to) {
    const from = startOfDay(spec.from).getTime();
    const to = startOfDay(spec.to).getTime() + DAY_MS;
    return finish({ preset: 'custom', anchor, from, to, custom: true, label: `${ymd(from)} → ${ymd(to - DAY_MS)}` });
  }

  if (preset === 'custom') {
    const days = Number(spec.days) || 0;
    if (!days) {
      return finish({ preset: 'custom', anchor, from: 0, to: now, days: 0, label: 'Everything' });
    }
    return finish({
      preset: 'custom', anchor, days,
      from: startOfDay(now - (days - 1) * DAY_MS).getTime(),
      to: now,
      label: `Last ${days} day${days === 1 ? '' : 's'}`,
    });
  }

  const starts = {
    day: startOfDay(now),
    week: startOfWeek(now),
    month: startOfMonth(now),
  };
  const begin = starts[preset] || starts.week;

  if (anchor === 'this') {
    return finish({ preset, anchor, from: begin.getTime(), to: now, label: labelFor(preset, 'this') });
  }

  // The previous complete period: back up one unit from this period's start.
  const prev = new Date(begin);
  if (preset === 'day') prev.setDate(prev.getDate() - 1);
  if (preset === 'week') prev.setDate(prev.getDate() - 7);
  if (preset === 'month') prev.setMonth(prev.getMonth() - 1);

  return finish({
    preset, anchor,
    from: prev.getTime(),
    to: begin.getTime(),
    label: labelFor(preset, 'previous'),
  });
}

const labelFor = (preset, anchor) => ({
  day: anchor === 'this' ? 'Today' : 'Yesterday',
  week: anchor === 'this' ? 'This week' : 'Last week',
  month: anchor === 'this' ? 'This month' : 'Last month',
}[preset] || 'This week');

function finish(w) {
  const days = w.days ?? (w.from ? Math.max(1, Math.ceil((w.to - w.from) / DAY_MS)) : 0);
  return {
    ...w,
    days,
    fromDay: w.from ? ymd(w.from) : null,
    toDay: ymd(w.to - 1),
    custom: Boolean(w.custom),
  };
}

/** True when `t` falls inside the window. A window with no start takes all. */
export const within = (w, t) => {
  const at = Number(t) || 0;
  if (!at) return !w.from;
  return (!w.from || at >= w.from) && at < w.to;
};

/**
 * Days to ask Gong for.
 *
 * The pull is expressed in whole days back from today, so a window ending in
 * the past still has to reach far enough back to include its start — asking
 * for "last week" on a Wednesday means pulling 10 days, not 7.
 */
export function pullDays(w) {
  if (!w.from) return 0;
  return Math.max(1, Math.ceil((Date.now() - w.from) / DAY_MS));
}

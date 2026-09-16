/**
 * lib/format.js — the small formatters, defined once.
 *
 * In the vanilla build `esc` existed three times, `kb` and `stripName` twice
 * each, and `money` twice. They agreed, but only by luck.
 */

export const kb = (n) =>
  n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

/** Transcript filenames all end the same way; the tail is noise in a list. */
export const stripName = (name) =>
  String(name).replace(/-transcript\.(md|txt|srt|vtt)$/i, '').replace(/\.(md|txt|docx|pdf)$/i, '');

export const money = (n) => `$${Number(n || 0).toFixed(2)}`;

/** Four decimals, because a cheap question costs $0.0213 and $0.02 hides it. */
export const money4 = (n) => `$${Number(n || 0).toFixed(4)}`;

export const secs = (ms) => `${(Number(ms || 0) / 1000).toFixed(0)}s`;

/** "$0.6043 · 15s · 4 turns", skipping whatever is missing. */
export const runMeta = ({ cost, durationMs, turns }) =>
  [
    cost != null ? money4(cost) : '',
    durationMs ? secs(durationMs) : '',
    turns ? `${turns} turn${turns === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' · ');

export const ago = (ts) => {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
};

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

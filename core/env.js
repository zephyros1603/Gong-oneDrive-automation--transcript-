/**
 * core/env.js — reading and writing gong.env.
 *
 * gong.env stays a plain file rather than moving into the database: the CLI
 * (`node gong.js me`) reads it without a server running, the Chrome extension
 * writes a cookie into it, and it is the one file that must be chmod 600.
 */

import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { loadConfig, ymd, daysAgo } from '../gong.js';
import { ENV_PATH } from './paths.js';

/** Raw values straight out of gong.env, for prefilling the form. */
export function envDefaults() {
  const cfg = loadConfig();
  return {
    GONG_HOST: cfg.host,
    GONG_COOKIE: cfg.cookie,
    GONG_WORKSPACE_ID: cfg.workspaceId,
    GONG_USER_ID: cfg.userId,
    GONG_ACCOUNT_ID: cfg.accountId,
    GONG_DAY_FROM: cfg.dayFrom || daysAgo(7),
    GONG_DAY_TO: cfg.dayTo || ymd(new Date()),
    GONG_FORMAT: cfg.format,
    GONG_OUT_DIR: cfg.outDir,
    GONG_RAW_DIR: cfg.rawDir,
    GONG_CONCURRENCY: String(cfg.concurrency),
    GONG_SORTED_DIR: cfg.sortedDir,
  };
}

/**
 * Rewrite values in gong.env in place, preserving comments, ordering and any
 * key the UI does not manage (NODE_BIN). A .bak copy is kept because this
 * overwrites the file holding a credential.
 */
export function saveEnv(updates) {
  const original = readFileSync(ENV_PATH, 'utf8');
  copyFileSync(ENV_PATH, `${ENV_PATH}.bak`);

  const lines = original.split('\n');
  const seen = new Set();

  const rewritten = lines.map((line) => {
    const m = /^(\s*(?:export\s+)?)([A-Za-z_]\w*)(\s*=\s*)(.*)$/.exec(line);
    if (!m) return line;

    const [, lead, key, eq, rest] = m;
    if (!(key in updates)) return line;
    seen.add(key);

    // Keep any inline comment that followed the old value.
    const quoted = /^(['"])((?:\\.|(?!\1).)*)\1(.*)$/.exec(rest);
    const trailing = quoted ? quoted[3] : '';
    return `${lead}${key}${eq}'${String(updates[key]).replace(/'/g, "'\\''")}'${trailing}`;
  });

  const missing = Object.keys(updates).filter((k) => !seen.has(k));
  if (missing.length) {
    rewritten.push('', '# --- added by the web UI ---');
    for (const k of missing) rewritten.push(`${k}='${updates[k]}'`);
  }

  writeFileSync(ENV_PATH, rewritten.join('\n'), { mode: 0o600 });
  return { saved: Object.keys(updates).length, backup: `${ENV_PATH}.bak` };
}

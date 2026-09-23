/**
 * core/workflow/digest.js — one cheap file standing in for everything.
 *
 * Every generation run today pays to read the raw material again: the full
 * transcripts, the full tracker markdown, every time. For a customer with a
 * dozen calls and a busy tracker record, that is the majority of a run's
 * input tokens spent re-establishing facts nothing about them has changed
 * since the last run.
 *
 * A digest is a compact, Claude-written summary of a customer — decisions
 * made, open items, current delivery state, key dates, risks — built once
 * from the raw material and reused until the raw material actually changes.
 * It is a *file*, not a cache entry, for the same reason context.js's CX
 * Portal render is a file: it costs nothing when a run does not choose it as
 * a source, and it is something a person can open and read.
 *
 * The saving is entirely in not regenerating it. Building the digest itself
 * still costs a real (small) run; the win is every report after the first one
 * reading ~1 file instead of N raw ones, and never paying to rebuild it until
 * something in it would actually be wrong.
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfig, slug } from '../../gong.js';
import { contextDir } from './context.js';
import { startChatRun } from '../chat.js';
import * as runs from '../../runs.js';
import * as projects from '../../projects.js';
import * as library from '../../library.js';

const INSTRUCTION = `Read every transcript and tracker file attached to this message. Produce a
compact factual digest of this customer for reuse in future reports — not
prose, a dense reference. Cover:

- Who is involved (names, roles) and how to reach them if stated
- Every decision made, with the call/date it was made on
- Every open item or blocker, with owner if known
- Current delivery status: phase, target go-live, any slip and its reason
- Anything explicitly promised to the customer that has not been delivered

Keep it under 500 words. State only what a source supports — if something is
unclear or contradicted between sources, say so rather than picking one. Do
not editorialise or summarise sentiment; this is a lookup table for a future
run, not a report a customer will read.`;

export function digestPathFor(customer, cfg = loadConfig()) {
  return join(contextDir(cfg), slug(customer), 'digest.md');
}

/**
 * A cheap fingerprint of what the digest was built from: every input file's
 * path and mtime. Any change to that set — a new call, a refreshed tracker
 * pull — changes the hash, which is the only trigger for a rebuild. A digest
 * is otherwise reused forever, which is the entire point.
 */
export function inputsHash(files) {
  const h = createHash('sha1');
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    h.update(`${f.path}:${Math.floor(f.mtime || 0)}\n`);
  }
  return h.digest('hex').slice(0, 16);
}

function stampOf(hash) { return `<!-- warp:digest ${hash} -->`; }

function currentStamp(path) {
  if (!existsSync(path)) return null;
  try { return readFileSync(path, 'utf8').split('\n', 1)[0]; } catch { return null; }
}

/** Rough order of magnitude, not a billing figure — ~4 chars per token. */
export const estimateTokens = (text) => Math.ceil(String(text || '').length / 4);

/**
 * Build or reuse one customer's digest.
 *
 * @returns {{path, cached, rebuiltFrom, tokensSaved?}} `tokensSaved` is only
 *   present on a rebuild, and is the raw-input estimate the digest replaces —
 *   the number worth watching over time.
 */
export async function refreshDigest(projectId, { force = false } = {}) {
  const project = projects.getProject(projectId);
  if (!project) throw new Error('no such project');

  const inputs = [
    ...project.transcripts.map((p) => ({ path: p })),
    ...project.context.map((c) => ({ path: c.path })),
  ].map((f) => {
    const meta = library.listFiles().find((x) => x.path === f.path);
    return { path: f.path, mtime: meta?.mtime || 0 };
  });

  if (!inputs.length) {
    return { path: null, skipped: 'nothing to digest yet — no transcripts or context for this customer' };
  }

  const path = digestPathFor(project.name);
  const hash = inputsHash(inputs);

  if (!force && currentStamp(path) === stampOf(hash)) {
    return { path, cached: true };
  }

  // The one real cost here: a small, scoped run to read the raw material and
  // write the digest. `resetSession: true` so it starts clean rather than
  // inheriting whatever conversation this project happens to have open.
  const started = await startChatRun({
    projectId,
    message: INSTRUCTION,
    files: inputs.map((f) => f.path),
    resetSession: true,
    silent: true,   // not a chat turn, not a session change, not an approval
    label: `${project.name} — digest`,
    meta: { digest: true },
  });

  // startChatRun streams; wait for this specific run to close before reading
  // its text back out, the same way core/chat.js itself does internally.
  const text = await new Promise((resolve, reject) => {
    const off = runs.subscribe(started.runId, (e) => {
      if (e.type === 'closed-buffer' || e.type === 'finished') {
        off?.();
        const run = runs.get(started.runId);
        if (run?.status === 'done') resolve(run.text || '');
        else reject(new Error(`digest run ended as ${run?.status || 'unknown'}`));
      }
    });
  });

  if (!text.trim()) throw new Error('the digest run produced no text');

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${stampOf(hash)}\n# ${project.name} — digest\n\n${text.trim()}\n`, 'utf8');
  library.refresh();
  projects.attachContext(projectId, path, 'digest', 'digest');

  const rawTokens = inputs.reduce((n, f) => {
    try { return n + estimateTokens(readFileSync(f.path, 'utf8')); } catch { return n; }
  }, 0);
  const digestTokens = estimateTokens(text);

  return {
    path, cached: false, rebuiltFrom: inputs.length,
    tokensSaved: Math.max(0, rawTokens - digestTokens),
    rawTokensEstimate: rawTokens, digestTokensEstimate: digestTokens,
  };
}

/** Every project's digest freshness, for the Context application's Data tab. */
export function digestStatus() {
  return projects.listProjects().map((p) => {
    const inputs = [
      ...p.transcripts.map((path) => ({ path })),
      ...p.context.map((c) => ({ path: c.path })),
    ].map((f) => {
      const meta = library.listFiles().find((x) => x.path === f.path);
      return { path: f.path, mtime: meta?.mtime || 0 };
    });

    const path = digestPathFor(p.name);
    const hash = inputs.length ? inputsHash(inputs) : null;
    const stamp = currentStamp(path);
    const exists = existsSync(path);

    let bytes = 0, tokens = 0;
    if (exists) {
      try { const s = statSync(path); bytes = s.size; tokens = estimateTokens(readFileSync(path, 'utf8')); } catch {}
    }

    return {
      id: p.id, name: p.name,
      exists, bytes, tokensEstimate: tokens,
      inputs: inputs.length,
      fresh: exists && hash && stamp === stampOf(hash),
      path: exists ? path : null,
    };
  });
}

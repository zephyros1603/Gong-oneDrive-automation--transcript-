/**
 * claude-runner.js — drive the Claude Code CLI and manage its skills.
 *
 * The CLI is used rather than the API because it authenticates off the
 * existing Claude Code login, so no API key is needed. Conversations persist
 * by session id, which is what lets the Workbench offer follow-ups on a
 * document it already generated.
 */

import { spawn, execSync } from 'node:child_process';
import {
  readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, statSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { slug } from './gong.js';

export const SKILLS_DIR = join(homedir(), '.claude', 'skills');

/** Locate the CLI. A GUI-launched server has a bare PATH, so search too. */
export function claudeBin() {
  if (process.env.CLAUDE_BIN && existsSync(process.env.CLAUDE_BIN)) {
    return process.env.CLAUDE_BIN;
  }
  for (const c of [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    join(homedir(), '.claude', 'local', 'claude'),
  ]) {
    if (existsSync(c)) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// skills
// ---------------------------------------------------------------------------

/** Parse the YAML-ish frontmatter at the top of a SKILL.md. */
function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return {};

  const out = {};
  // Only name/description matter here, and description is often a long
  // quoted string, so a full YAML parser would be overkill.
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[kv[1]] = value;
  }
  return out;
}

export function listSkills() {
  if (!existsSync(SKILLS_DIR)) return [];

  const out = [];
  for (const name of readdirSync(SKILLS_DIR)) {
    if (name.startsWith('.')) continue;
    const file = join(SKILLS_DIR, name, 'SKILL.md');
    if (!existsSync(file)) continue;

    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    const fm = frontmatter(text);

    out.push({
      dir: name,
      name: fm.name || name,
      description: fm.description || '',
      path: file,
      mtime: statSync(file).mtimeMs,
      // Extra files a skill carries (scripts/, references/) are a good signal
      // that it is a full skill rather than a bare prompt.
      files: countFiles(join(SKILLS_DIR, name)),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function countFiles(dir) {
  let n = 0;
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === '__pycache__') continue;
      if (e.isDirectory()) walk(join(d, e.name));
      else n++;
    }
  };
  walk(dir);
  return n;
}

/**
 * Create or overwrite a skill. Claude Code discovers skills from disk on each
 * invocation, so writing the file is all that "adding a skill" requires — no
 * daemon to reload, nothing to restart.
 */
export function addSkill({ name, description, body }) {
  const dir = slug(name || '').toLowerCase();
  if (!dir) throw new Error('the skill needs a name');
  if (!description || !description.trim()) {
    // Claude Code selects a skill from its description, so an empty one means
    // the skill would never trigger.
    throw new Error('the skill needs a description — it is how Claude decides to use it');
  }

  const target = join(SKILLS_DIR, dir, 'SKILL.md');
  const existed = existsSync(target);

  const md = [
    '---',
    `name: ${dir}`,
    `description: ${JSON.stringify(description.trim())}`,
    '---',
    '',
    (body || '').trim() || `# ${name}\n\nDescribe the steps for this skill here.`,
    '',
  ].join('\n');

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, md, 'utf8');

  return { dir, name: dir, path: target, created: !existed };
}

// ---------------------------------------------------------------------------
// running
// ---------------------------------------------------------------------------

/**
 * The query the UI sends, kept in one place so it stays consistent:
 *
 *   "<skill>, <instruction>, and generated report in <outputDir>"
 *
 * followed by the selected files. Claude reads them itself via its own file
 * tools, so nothing is pasted into the prompt.
 */
export const EMAIL_OPEN = '=== EMAIL ===';
export const EMAIL_CLOSE = '=== END EMAIL ===';

export function buildPrompt({ skill, instruction, outputDir, files }) {
  const lines = [
    skill
      ? `${skill}, ${instruction}, and generated report in ${outputDir}`
      : instruction,
  ];

  if (files.length) {
    lines.push(
      '',
      files.length === 1 ? 'Transcript file:' : `Transcript files (${files.length}):`,
      ...files.map((f) => `- ${f}`)
    );
  }

  lines.push(
    '',
    `Write every generated document into ${outputDir}.`,
    'Do not use /mnt/user-data or /mnt/skills paths — this is a local machine,',
    'so use the output directory above and local python for any .docx work.',
    '',
    // A covering email is something you paste into a mail client, so a .docx
    // of it is a file nobody opens. Ask for it inline, fenced by markers the
    // UI can find, and render it as a copyable email box instead.
    'Do NOT save the covering email as a file. If you write a covering email,',
    'put it in your final reply between these exact markers:',
    '',
    EMAIL_OPEN,
    'Subject: <subject line>',
    '',
    '<email body>',
    EMAIL_CLOSE,
    '',
    'Only the call notes and reports become documents on disk.',
  );

  return lines.join('\n');
}

/**
 * Map Claude Code's stream-json events onto the three phases the UI shows.
 * Reading files is "analysing", writing them is "writing", prose in between
 * is "generating".
 */
function phaseFor(event) {
  if (event.type === 'system' && event.subtype === 'init') return 'starting';

  if (event.type === 'assistant') {
    const blocks = event.message?.content || [];
    for (const b of blocks) {
      if (b.type !== 'tool_use') continue;
      if (['Read', 'Glob', 'Grep'].includes(b.name)) return 'analysing';
      if (['Write', 'Edit', 'NotebookEdit'].includes(b.name)) return 'writing';
      if (b.name === 'Bash') return 'writing';
      return 'working';
    }
    if (blocks.some((b) => b.type === 'text' && b.text?.trim())) return 'generating';
  }
  return null;
}

/** Short human label for whatever the current event is doing. */
function describe(event) {
  if (event.type !== 'assistant') return null;

  for (const b of event.message?.content || []) {
    if (b.type !== 'tool_use') continue;

    const input = b.input || {};
    let detail = '';

    // A file path reads best as its basename; a shell command does not — it
    // has slashes of its own, so splitting it produced nonsense labels.
    if (input.file_path) detail = String(input.file_path).split('/').pop();
    else if (input.pattern) detail = String(input.pattern);
    else if (input.command) detail = String(input.command).replace(/\s+/g, ' ').slice(0, 60);
    else if (input.skill) detail = String(input.skill);

    return detail ? `${b.name} · ${detail}` : b.name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// job registry
// ---------------------------------------------------------------------------

/**
 * Every child this process spawns, so nothing can be left running.
 *
 * A spawned `claude` does not die when its parent does, and closing the
 * browser tab used to leave one running to completion — billing for work
 * nobody would see. Everything is tracked here and killed on disconnect,
 * on cancel, and on server shutdown.
 */
const jobs = new Map();

export function listJobs() {
  return [...jobs.values()].map((j) => ({
    id: j.id,
    pid: j.child.pid,
    action: j.action,
    label: j.label,
    files: j.files,
    startedAt: j.startedAt,
    elapsedMs: Date.now() - j.startedAt,
    cancelling: j.cancelling === true,
  }));
}

export const jobCount = () => jobs.size;

/**
 * Stop a job. SIGTERM first so the CLI can wind down, then SIGKILL if it
 * ignores that — a hung child must not survive a cancel.
 */
export function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return false;

  job.cancelling = true;
  try { job.child.kill('SIGTERM'); } catch { /* already gone */ }

  setTimeout(() => {
    if (jobs.has(id)) {
      try { job.child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }, 4000);

  return true;
}

export function cancelAll() {
  const ids = [...jobs.keys()];
  for (const id of ids) cancelJob(id);
  return ids.length;
}

// ---------------------------------------------------------------------------
// system-wide sweep
// ---------------------------------------------------------------------------

/**
 * Find every Claude Code CLI process on this machine and say what each one is.
 *
 * Blanket-matching "claude" is dangerous: it also hits Claude Desktop (a
 * separate Electron app, nine processes) and the VS Code extension host, which
 * is the Claude Code session that may be editing this very project. So each
 * match is classified and the destructive ones are opt-in.
 */
export function scanClaudeProcesses() {
  let out = '';
  try {
    out = execSync('/bin/ps -axo pid=,ppid=,etime=,command=', {
      encoding: 'utf8',
      maxBuffer: 4e6,
    });
  } catch {
    return [];
  }

  const ours = new Set([...jobs.values()].map((j) => j.child.pid));
  const found = [];

  for (const raw of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(raw);
    if (!m) continue;

    const [, pid, ppid, etime, command] = m;
    if (!/claude/i.test(command)) continue;
    if (Number(pid) === process.pid) continue;

    // Claude Desktop is a different application. Never a candidate.
    if (command.includes('/Applications/Claude.app/')) continue;

    // The binary must actually be a `claude` executable, not something that
    // merely mentions the word (a grep, an editor with the file open).
    if (!/(^|\/)claude(\s|$)/.test(command)) continue;

    let kind = 'terminal';
    let note = 'a session you started in a terminal';

    if (ours.has(Number(pid)) || / -p /.test(command)) {
      kind = 'app';
      note = 'a document job started by this app';
    } else if (/\.vscode\/extensions\/anthropic\.claude-code/.test(command)) {
      kind = 'ide';
      note = 'the Claude Code session running in your editor';
    }

    found.push({
      pid: Number(pid),
      ppid: Number(ppid),
      elapsed: etime,
      kind,
      note,
      command: command.slice(0, 160),
    });
  }

  return found;
}

/**
 * Kill specific PIDs, but only ones the scanner recognises as Claude CLI
 * processes — so this endpoint can never become a general "kill any pid".
 */
export function killClaudePids(pids) {
  const allowed = new Map(scanClaudeProcesses().map((p) => [p.pid, p]));
  const killed = [];

  for (const pid of pids.map(Number)) {
    const proc = allowed.get(pid);
    if (!proc) continue;
    try {
      process.kill(pid, 'SIGTERM');
      killed.push(proc);
    } catch { /* already gone */ }
  }

  // Anything that ignored SIGTERM gets SIGKILL shortly after.
  if (killed.length) {
    setTimeout(() => {
      for (const p of killed) {
        try { process.kill(p.pid, 0); process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ }
      }
    }, 3000);
  }

  return killed;
}

/** Kill everything synchronously — for process exit, where timers never run. */
export function killAllNow() {
  for (const job of jobs.values()) {
    try { job.child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  const n = jobs.size;
  jobs.clear();
  return n;
}

/**
 * Run one skill invocation. Returns the child so a caller can cancel it.
 *
 * onEvent receives {type: 'phase'|'text'|'tool'|'done'|'error', ...}.
 */
export function runSkill({
  skill, instruction, outputDir, files, sessionId, model, cwd, addDirs = [],
  maxTurns = 0, jobId, label,
  onEvent = () => {},
}) {
  const bin = claudeBin();
  if (!bin) throw new Error('the Claude Code CLI was not found — set CLAUDE_BIN');
  if (!files?.length) throw new Error('select at least one file first');

  const prompt = buildPrompt({ skill, instruction, outputDir, files });
  const session = sessionId || randomUUID();

  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];

  // Resuming keeps the conversation, so follow-ups ("shorten it") land in the
  // same context; a fresh id starts clean.
  if (sessionId) args.push('--resume', sessionId);
  else args.push('--session-id', session);

  if (model) args.push('--model', model);

  // Claude needs read access to the transcripts and write access to the
  // output directory; --add-dir grants exactly those.
  for (const d of [...new Set([outputDir, ...addDirs])].filter(Boolean)) {
    args.push('--add-dir', d);
  }

  // Generating a document means reading files and writing one. Anything
  // outside that set is refused rather than silently permitted.
  args.push('--allowed-tools', 'Read,Glob,Grep,Write,Edit,Bash');
  args.push('--permission-mode', 'acceptEdits');

  // A hard ceiling on turns, so a confused run cannot spin up an unbounded
  // bill. A MOM takes about a dozen turns, so the default leaves headroom.
  if (maxTurns > 0) args.push('--max-turns', String(maxTurns));

  const child = spawn(bin, args, {
    cwd: cwd || process.cwd(),
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Deliberately NOT detached: staying in this process group means a
    // shutdown signal reaches the child too.
    detached: false,
  });

  const id = jobId || randomUUID();
  jobs.set(id, {
    id, child, session,
    action: skill,
    label: label || skill,
    files: files.length,
    startedAt: Date.now(),
    cancelling: false,
  });

  onEvent({ type: 'phase', phase: 'starting', session, prompt, jobId: id });

  let buf = '';
  let lastPhase = null;
  let stderr = '';

  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();

    // stream-json is newline-delimited JSON.
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;

      let event;
      try { event = JSON.parse(line); } catch { continue; }

      const phase = phaseFor(event);
      if (phase && phase !== lastPhase) {
        lastPhase = phase;
        onEvent({ type: 'phase', phase });
      }

      const label = describe(event);
      if (label) onEvent({ type: 'tool', label });

      if (event.type === 'assistant') {
        for (const b of event.message?.content || []) {
          if (b.type === 'text' && b.text) onEvent({ type: 'text', text: b.text });
        }
      }

      if (event.type === 'result') {
        onEvent({
          type: 'done',
          session: event.session_id || session,
          isError: Boolean(event.is_error),
          result: event.result || '',
          costUsd: event.total_cost_usd,
          durationMs: event.duration_ms,
          turns: event.num_turns,
        });
      }
    }
  });

  child.stderr.on('data', (c) => { stderr += c.toString(); });

  child.on('error', (err) => onEvent({ type: 'error', message: err.message }));

  child.on('close', (code, signal) => {
    const wasCancelled = jobs.get(id)?.cancelling === true;
    jobs.delete(id);

    if (wasCancelled || signal) {
      onEvent({ type: 'cancelled', signal: signal || 'SIGTERM' });
    } else if (code !== 0) {
      onEvent({
        type: 'error',
        message: stderr.trim().split('\n').slice(-3).join(' ') || `claude exited ${code}`,
      });
    }
    onEvent({ type: 'closed', code, cancelled: wasCancelled });
  });

  return { child, session, jobId: id };
}

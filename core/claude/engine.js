/**
 * core/claude/engine.js — one interface, so the engine is a choice.
 *
 * Today everything runs through the Claude Code CLI on this machine, under
 * your subscription: no API key, no per-token bill, and skills and file
 * writing work because the CLI already does them. That is the right engine
 * for a local tool and the wrong one for a hosted product, because it can
 * only ever run where someone is logged in.
 *
 * Rather than decide that now, everything above this file talks to `Engine`,
 * and swapping implementations is a config change. `CliEngine` is complete.
 * `ApiEngine` is deliberately a stub — see the note on it.
 *
 * The contract:
 *
 *   run(opts) -> { jobId, session, cancel() }
 *
 *   opts.onEvent receives, in order:
 *     {type:'phase',   phase}          coarse progress
 *     {type:'session', session, jobId} the conversation id, once known
 *     {type:'tool',    label}          one line per tool call
 *     {type:'text',    text}           assistant prose, incrementally
 *     {type:'done',    result, costUsd, durationMs, turns, session, isError}
 *     {type:'closed',  code, cancelled} always last, whatever happened
 */

/** @typedef {object} EngineRunOptions
 * @property {string}   [skill]       installed skill name, '' for a plain chat
 * @property {string}   instruction   what to do
 * @property {string}   outputDir     where documents may be written
 * @property {string[]} [files]       transcripts to put in scope
 * @property {string}   [sessionId]   continue this conversation
 * @property {string}   [model]
 * @property {number}   [maxTurns]    0 = no cap
 * @property {string}   [label]
 * @property {string}   [cwd]
 * @property {string[]} [addDirs]     directories the agent may read
 * @property {(e: object) => void} onEvent
 */

/**
 * The Claude Code CLI on this machine.
 *
 * Wraps claude-runner.js unchanged — it already tracks every child it spawns
 * so nothing can be left running and billing after the server exits.
 */
export class CliEngine {
  constructor() { this.name = 'cli'; }

  /** @param {EngineRunOptions} opts */
  async run(opts) {
    const { runSkill, claudeBin } = await import('../../claude-runner.js');
    if (!claudeBin()) {
      throw new Error('the Claude Code CLI was not found — set CLAUDE_BIN');
    }
    const started = runSkill(opts);
    return {
      jobId: started.jobId,
      session: started.session,
      cancel: async () => {
        const { cancelJob } = await import('../../claude-runner.js');
        return cancelJob(started.jobId);
      },
    };
  }

  async available() {
    const { claudeBin } = await import('../../claude-runner.js');
    return Boolean(claudeBin());
  }
}

/**
 * The Anthropic API. NOT IMPLEMENTED, and deliberately so.
 *
 * The interface above is the part worth having now, because it is what stops
 * the engine choice leaking into feature code. Actually implementing this one
 * is a project rather than a detail: the CLI gives us skill loading from
 * ~/.claude/skills, filesystem tools scoped by --add-dir, an agent loop with
 * a turn cap, and session resumption. Against the raw API every one of those
 * has to be rebuilt — a tool-use loop with Read/Write/Edit/Glob/Grep/Bash
 * implementations, a sandbox for them, skill resolution, and conversation
 * persistence — and it bills per token instead of riding a subscription.
 *
 * Left as a marked gap rather than a half-working adapter that looks usable.
 */
export class ApiEngine {
  constructor({ apiKey } = {}) {
    this.name = 'api';
    this.apiKey = apiKey || process.env.ANTHROPIC_API_KEY || '';
  }

  async available() { return false; }

  async run() {
    throw new Error(
      'the Anthropic API engine is not implemented yet — it needs the tool loop, ' +
      'skill loading and sandboxing that the CLI provides for free. Use the CLI engine.'
    );
  }
}

/**
 * Pick an engine. One place to change when the API adapter lands.
 *
 * GONG_ENGINE=api would select it; until ApiEngine is real that fails loudly
 * at start rather than quietly producing nothing.
 */
export function getEngine(name = process.env.GONG_ENGINE || 'cli') {
  switch (name) {
    case 'api': return new ApiEngine();
    case 'cli':
    default: return new CliEngine();
  }
}

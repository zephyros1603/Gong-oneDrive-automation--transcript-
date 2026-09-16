/**
 * instrumentation.node.js — everything that must happen once per server process.
 *
 * Reached only from instrumentation.js's `NEXT_RUNTIME === 'nodejs'` branch,
 * so it is free to import the database and child_process. Keeping it in a
 * separate file is not tidiness: it is what stops the edge compiler ever
 * resolving these imports.
 *
 * Two things live here that serve.js used to do at module scope:
 *
 *   - the scheduler tick, which is what makes the Automation tab work
 *   - the shutdown hooks that SIGKILL every `claude` child this server spawned
 *
 * That second one is not housekeeping. A headless `claude` run bills for as
 * long as it lives and does not die with its parent, so a server that exits
 * without killing its children leaves them running and charging.
 *
 * Guarded on globalThis because Next re-evaluates modules on edit in dev, and
 * a second scheduler racing the first would double-run the pipeline.
 */

import * as runs from './runs.js';
import { tick } from './automation.js';
import { killAllNow, cancelAll } from './claude-runner.js';

const g = globalThis;

if (!g.__gong_instrumented) {
  g.__gong_instrumented = true;

  // A run still marked running belongs to a process that is gone; its child
  // died with it. Clear them so the UI does not show a job it cannot stop.
  const reaped = runs.reapOrphans();
  if (reaped) console.log(`  · cleared ${reaped} run(s) orphaned by a restart`);

  // ---- the scheduler -----------------------------------------------------
  // Deliberately a timer inside this process, not launchd: it therefore
  // cannot wake the Mac, and while the Mac sleeps the slot simply passes.
  const scheduler = setInterval(() => {
    try {
      tick({ onRun: (run) => console.log(`  · automation started (${run.id})`) });
    } catch (err) {
      console.error('  ! scheduler tick failed:', err?.message || err);
    }
  }, 30000);

  const pruner = setInterval(() => {
    try { runs.prune(); } catch { /* not worth crashing over */ }
  }, 15 * 60000);

  // ---- nothing we spawned may outlive us ---------------------------------
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n  ${signal} — stopping Claude processes…`);
    clearInterval(scheduler);
    clearInterval(pruner);
    try { cancelAll(); } catch { /* fall through to the hard kill */ }
    try { killAllNow(); } catch { /* nothing more to try */ }
    process.exit(0);
  };

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => shutdown(sig));
  }

  // Timers cannot run during exit, so this has to be synchronous.
  process.on('exit', () => {
    try { killAllNow(); } catch { /* the process is going away anyway */ }
  });

  console.log('  · scheduler armed, shutdown hooks installed');
}

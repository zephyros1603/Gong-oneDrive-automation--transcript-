'use client';

/**
 * lib/useRunStream.js — one place that knows how to follow a run.
 *
 * This replaces four hand-rolled copies of the same reader loop (one per page
 * in the vanilla build), each of which handled a slightly different subset of
 * the event types and none of which handled `finished` or `closed-buffer`.
 *
 * Two properties matter and are easy to get wrong:
 *
 *   - Detaching must not cancel. Unmounting aborts the fetch, which unsubscribes
 *     server-side; the run carries on and can be re-attached later.
 *   - Re-attaching must replay. The server records every event, so a component
 *     that mounts late — a tab switch, a reload, even a server restart — is
 *     handed the whole story before live events resume.
 */

import { useEffect, useRef, useState, useCallback } from 'react';

/** The phases the CLI reports, in the words the UI shows. */
export const PHASES = {
  starting: 'Starting',
  analysing: 'Analysing transcripts',
  generating: 'Generating',
  writing: 'Writing documents',
  working: 'Working',
};

const EMPTY = {
  status: 'idle',      // idle | running | done | cancelled | error
  phase: '',
  tool: '',
  trace: [],
  text: '',
  errors: [],
  session: null,
  cost: null,
  durationMs: null,
  turns: null,
  documents: [],
  usage: null,
  startedAt: null,
  events: [],
};

/**
 * Read an SSE body as a sequence of parsed events.
 * Frames are separated by a blank line; a frame can span chunk boundaries.
 */
export async function* readEvents(body, signal) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });

      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        try {
          yield JSON.parse(line.slice(5).trim());
        } catch { /* a truncated frame is not worth failing the stream over */ }
      }
    }
  } finally {
    if (signal?.aborted) { try { await reader.cancel(); } catch { /* already gone */ } }
  }
}

/** Fold one event into the accumulated view of a run. */
export function reduceEvent(state, ev) {
  switch (ev.type) {
    case 'start':
      return { ...state, status: 'running', startedAt: ev.at || Date.now() };
    case 'phase':
      return { ...state, phase: PHASES[ev.phase] || ev.phase };
    case 'tool':
      return { ...state, tool: ev.label, trace: [...state.trace, ev.label] };
    case 'session':
      return { ...state, session: ev.session || state.session };
    case 'text':
      return { ...state, text: state.text + (ev.text || '') };
    case 'cancelled':
      return { ...state, status: 'cancelled' };
    case 'error':
      return { ...state, errors: [...state.errors, ev.message] };
    case 'done':
      return {
        ...state,
        text: ev.result || state.text,
        session: ev.session || state.session,
        cost: ev.costUsd ?? state.cost,
        durationMs: ev.durationMs ?? state.durationMs,
        turns: ev.turns ?? state.turns,
      };
    case 'output':
      return {
        ...state,
        // A document belongs to this run if it was written after the run began.
        // Anchoring on "the last ten minutes" instead silently dropped the
        // early documents of any run longer than that.
        documents: (ev.files || []).filter(
          (f) => !state.startedAt || f.mtime >= state.startedAt - 60000
        ),
        outputChanged: Boolean(ev.changed),
      };
    case 'usage':
      return { ...state, usage: ev.usage };
    case 'finished':
      return { ...state, status: ev.status || 'done' };
    case 'closed-buffer':
      return { ...state, status: state.status === 'running' ? (ev.status || 'done') : state.status };
    default:
      return state;
  }
}

/**
 * Follow the run at `runId`. Pass null to follow nothing.
 *
 * `onEvent` sees every raw event, for the cases a page needs more than the
 * folded state (the Pull tab's per-call rows, the Automation tab's steps).
 */
export function useRunStream(runId, { onEvent, onFinish } = {}) {
  const [state, setState] = useState(EMPTY);
  const abortRef = useRef(null);
  const cbRef = useRef({ onEvent, onFinish });
  cbRef.current = { onEvent, onFinish };

  useEffect(() => {
    if (!runId) { setState(EMPTY); return; }

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let live = true;
    setState({ ...EMPTY, status: 'running' });

    (async () => {
      try {
        const res = await fetch(`/api/runs/${runId}/stream`, { signal: ctrl.signal });
        if (!res.body) throw new Error(`server returned HTTP ${res.status}`);

        for await (const ev of readEvents(res.body, ctrl.signal)) {
          if (!live) return;
          setState((s) => reduceEvent(s, ev));
          cbRef.current.onEvent?.(ev);
        }
      } catch (err) {
        // An abort means the component went away; the run continues server-side.
        if (err?.name === 'AbortError' || !live) return;
        setState((s) => ({ ...s, status: 'error', errors: [...s.errors, err.message] }));
      }

      if (!live) return;
      setState((s) => {
        const settled = s.status === 'running' ? { ...s, status: 'done' } : s;
        cbRef.current.onFinish?.(settled);
        return settled;
      });
    })();

    return () => { live = false; ctrl.abort(); };
  }, [runId]);

  /** Stop the run server-side. Unmounting does not do this, deliberately. */
  const cancel = useCallback(async () => {
    if (!runId) return;
    try {
      await fetch(`/api/runs/${runId}/cancel`, { method: 'POST' });
    } catch { /* the poll will show whether it stopped */ }
  }, [runId]);

  return { ...state, cancel };
}

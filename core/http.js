/**
 * core/http.js — the small amount of HTTP shape the route handlers share.
 *
 * Route handlers stay thin: parse, call into core/, serialise. Anything that
 * looks like a decision belongs in a module, not here.
 */

/** JSON with no caching — every one of these reads live state. */
export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

export const fail = (err, status = 400) =>
  json({ error: err?.message || String(err) }, status);

/** Body parsing that treats an empty body as {} rather than throwing. */
export async function readBody(req) {
  try {
    const text = await req.text();
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

/**
 * Server-sent events over a ReadableStream.
 *
 * `start` is handed {send, end, open} and an `onCancel` registration. The
 * distinction matters: a browser navigating away cancels the stream, and for
 * a run that must only unsubscribe — never kill the child. That reversal is
 * the whole reason runs are owned by the server.
 */
export function sseResponse(start) {
  const encoder = new TextEncoder();
  let closed = false;
  let onCancel = () => {};

  const stream = new ReadableStream({
    start(controller) {
      const api = {
        send(event) {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          } catch {
            closed = true;   // the consumer went away mid-write
          }
        },
        end() {
          if (closed) return;
          closed = true;
          try { controller.close(); } catch { /* already closed */ }
        },
        get open() { return !closed; },
        onCancel(fn) { onCancel = fn; },
      };

      Promise.resolve(start(api)).catch((err) => {
        api.send({ type: 'error', message: err?.message || String(err) });
        api.end();
      });
    },
    cancel() {
      closed = true;
      try { onCancel(); } catch { /* nothing to do */ }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Next buffers responses behind a proxy unless told not to; without
      // this the whole run arrives at once when it finishes.
      'x-accel-buffering': 'no',
    },
  });
}

/**
 * The extension calls in from a chrome-extension:// origin, which needs CORS.
 * Only extension origins are allowed — a random web page must not be able to
 * push cookies into this server, even on loopback.
 */
export function extensionCors(req) {
  const origin = req.headers.get('origin') || '';
  if (!/^chrome-extension:\/\//.test(origin)) return null;
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
    vary: 'origin',
  };
}

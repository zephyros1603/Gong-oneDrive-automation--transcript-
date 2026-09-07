/**
 * Reads the Gong session cookies and POSTs them to the local puller.
 *
 * Why an extension: `g-session` is HttpOnly, so page JavaScript and
 * bookmarklets cannot see it — `chrome.cookies` is the only API that can.
 */

const $ = (id) => document.getElementById(id);
const DEFAULT_PORT = 7878;

const setStatus = (kind, title, body) => {
  const el = $('status');
  el.className = `status show ${kind}`;
  el.innerHTML = `<div class="title">${title}</div>${body || ''}`;
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const base = () => `http://127.0.0.1:${$('port').value || DEFAULT_PORT}`;

/** Decode a JWT payload; the `cell` cookie names the tenant host. */
function jwt(token) {
  try {
    const p = String(token).split('.')[1];
    return p ? JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/'))) : null;
  } catch { return null; }
}

/**
 * Collect every gong.io cookie into one header string.
 *
 * chrome.cookies.getAll matches by domain suffix, so this picks up both
 * `gong.io` and `us-81357.app.gong.io` cookies. A name can legitimately exist
 * twice on different domains or paths; the more specific host wins, since
 * that is what the browser itself would send to the tenant.
 */
async function collect() {
  const all = await chrome.cookies.getAll({ domain: 'gong.io' });
  if (!all.length) return { cookie: '', host: null, count: 0 };

  const best = new Map();
  for (const c of all) {
    const prev = best.get(c.name);
    const better =
      !prev ||
      c.domain.replace(/^\./, '').length > prev.domain.replace(/^\./, '').length ||
      (c.domain === prev.domain && c.path.length > prev.path.length);
    if (better) best.set(c.name, c);
  }

  const jar = [...best.values()];
  const cookie = jar.map((c) => `${c.name}=${c.value}`).join('; ');

  // Prefer the tenant named inside the `cell` JWT, then an open Gong tab.
  const cell = jwt(best.get('cell')?.value);
  let host = cell?.cell ? `${cell.cell}.app.gong.io` : null;

  if (!host) {
    const [tab] = await chrome.tabs.query({ url: '*://*.gong.io/*' });
    if (tab) host = new URL(tab.url).hostname;
  }

  return {
    cookie,
    host,
    count: jar.length,
    hasSession: best.has('last-login'),
  };
}

async function send() {
  const btn = $('send');
  btn.disabled = true;
  btn.textContent = 'Sending…';

  try {
    const jar = await collect();

    if (!jar.count) {
      setStatus('bad', '✕ Not signed in',
        '<div class="line">No gong.io cookies found. Open Gong in a tab and sign in, then try again.</div>');
      return;
    }
    if (!jar.hasSession) {
      setStatus('bad', '✕ Not signed in',
        '<div class="line">Found gong.io cookies but no session cookie. ' +
        'Open Gong, sign in, then try again.</div>');
      return;
    }

    // Everything else is sent as-is. The server verifies the session for
    // real, so guessing here about which cookies matter only produces false
    // rejections — an earlier version demanded cf_clearance, which Chrome
    // often does not have at all.

    let res;
    try {
      res = await fetch(`${base()}/api/cookie`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cookie: jar.cookie, host: jar.host, source: 'chrome extension' }),
      });
    } catch {
      setStatus('bad', '✕ Puller not running',
        `<div class="line">Nothing is listening on <b>${esc(base())}</b>. ` +
        'Double-click <code>Start Gong UI.command</code> first.</div>');
      return;
    }

    const d = await res.json();

    if (d.saved) {
      const ck = d.cookie || {};
      const expires = ck.cellExpires
        ? new Date(ck.cellExpires).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
        : '—';
      setStatus('ok', '✓ Session sent and saved', `
        <div class="rows">
          <div class="row"><span>account</span><b>${esc(ck.email || d.userId || '')}</b></div>
          <div class="row"><span>tenant</span><b>${esc(d.host || '')}</b></div>
          <div class="row"><span>your calls</span><b>${esc(d.myCalls ?? '')}</b></div>
          <div class="row"><span>cookies</span><b>${jar.count}</b></div>
          <div class="row"><span>expires</span><b>${esc(expires)}</b></div>
        </div>`);
      chrome.storage.local.set({ lastSent: Date.now(), port: $('port').value });
      showHint();
    } else {
      // The server verified it and refused, so say which step failed rather
      // than claiming success and letting the puller fail later.
      const failed = (d.checks || []).find((c) => !c.ok);
      setStatus('bad', '✕ Session rejected',
        `<div class="line">${esc(d.fatal || failed?.detail || 'the server could not verify this session')}</div>`);
    }
  } catch (err) {
    setStatus('bad', '✕ Something went wrong', `<div class="line">${esc(err.message)}</div>`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send session to puller';
  }
}

function showHint() {
  chrome.storage.local.get(['lastSent'], ({ lastSent }) => {
    $('hint').textContent = lastSent
      ? `Last sent ${new Date(lastSent).toLocaleString()}.`
      : 'Sign in to Gong in any tab, then click the button above.';
  });
}

$('send').onclick = send;
$('open').onclick = (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: base() });
};
$('port').onchange = () => chrome.storage.local.set({ port: $('port').value });

chrome.storage.local.get(['port'], ({ port }) => {
  if (port) $('port').value = port;
  showHint();
});

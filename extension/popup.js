/**
 * Reads the Gong session cookies and the CX Portal token, and POSTs each to
 * the local puller.
 *
 * Two different browser APIs for two different reasons:
 *   - Gong: `g-session` is HttpOnly, so page JavaScript and bookmarklets
 *     cannot see it — `chrome.cookies` is the only API that can.
 *   - CX Portal: the tokens live in that page's own `localStorage`
 *     (`accessToken` / `refreshToken` — see core/connectors/registry.js's
 *     credentialSchema hints, which is where these exact key names come
 *     from), not a cookie at all — `chrome.scripting.executeScript` reads
 *     them out of the CX Portal tab itself, the same way pasting
 *     `copy(localStorage.getItem('accessToken'))` into that tab's own
 *     DevTools console already does today, just without opening DevTools.
 */

const $ = (id) => document.getElementById(id);
const DEFAULT_PORT = 7878;
const CXPORTAL_URL_PATTERN = '*://cx-portal.aquera.io/*';

const setStatus = (elId, kind, title, body) => {
  const el = $(elId);
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
      setStatus('status', 'bad', '✕ Not signed in',
        '<div class="line">No gong.io cookies found. Open Gong in a tab and sign in, then try again.</div>');
      return;
    }
    if (!jar.hasSession) {
      setStatus('status', 'bad', '✕ Not signed in',
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
      setStatus('status', 'bad', '✕ Puller not running',
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
      setStatus('status', 'ok', '✓ Session sent and saved', `
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
      setStatus('status', 'bad', '✕ Session rejected',
        `<div class="line">${esc(d.fatal || failed?.detail || 'the server could not verify this session')}</div>`);
    }
  } catch (err) {
    setStatus('status', 'bad', '✕ Something went wrong', `<div class="line">${esc(err.message)}</div>`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send Gong session';
  }
}

/**
 * Pull `accessToken` / `refreshToken` out of an open CX Portal tab's own
 * localStorage — the same two keys core/connectors/registry.js's
 * credentialSchema hints document as what to paste by hand
 * (`copy(localStorage.getItem('accessToken'))`), just read via
 * chrome.scripting instead of a DevTools console.
 */
async function collectCxp() {
  const [tab] = await chrome.tabs.query({ url: CXPORTAL_URL_PATTERN });
  if (!tab) return { found: false };

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: () => ({
      accessToken: localStorage.getItem('accessToken') || '',
      refreshToken: localStorage.getItem('refreshToken') || '',
    }),
  });

  return { found: true, tabUrl: tab.url, ...result };
}

async function sendCxp() {
  const btn = $('sendCxp');
  btn.disabled = true;
  btn.textContent = 'Sending…';

  try {
    let jar;
    try {
      jar = await collectCxp();
    } catch (err) {
      setStatus('statusCxp', 'bad', '✕ Could not read the CX Portal tab',
        `<div class="line">${esc(err.message)}</div>`);
      return;
    }

    if (!jar.found) {
      setStatus('statusCxp', 'bad', '✕ No CX Portal tab open',
        `<div class="line">Open <b>${esc(CXPORTAL_URL_PATTERN.replace('*://', '').replace('/*', ''))}</b> and sign in, then try again.</div>`);
      return;
    }
    if (!jar.accessToken) {
      setStatus('statusCxp', 'bad', '✕ Not signed in',
        '<div class="line">Found the CX Portal tab but no accessToken in localStorage. Sign in there, then try again.</div>');
      return;
    }

    // Same principle as the Gong side: sent as-is, the server verifies for
    // real (core/connectors/cxportal-token.js's receiveCxpToken(), the same
    // check the Credentials tab's own Test button runs) rather than this
    // popup guessing at what a valid token looks like.

    let res;
    try {
      res = await fetch(`${base()}/api/cxportal/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: jar.accessToken, refreshToken: jar.refreshToken, source: 'chrome extension',
        }),
      });
    } catch {
      setStatus('statusCxp', 'bad', '✕ Puller not running',
        `<div class="line">Nothing is listening on <b>${esc(base())}</b>. ` +
        'Double-click <code>Start Gong UI.command</code> first.</div>');
      return;
    }

    const d = await res.json();

    if (d.saved) {
      const tokenCheck = (d.checks || []).find((c) => c.step === 'token');
      setStatus('statusCxp', 'ok', '✓ Token sent and saved', `
        <div class="rows">
          <div class="row"><span>token</span><b>${esc(tokenCheck?.detail || 'valid')}</b></div>
          <div class="row"><span>refresh token</span><b>${jar.refreshToken ? 'included' : 'not found'}</b></div>
        </div>`);
      chrome.storage.local.set({ lastSentCxp: Date.now(), port: $('port').value });
      showHint();
    } else {
      const failed = (d.checks || []).find((c) => !c.ok);
      setStatus('statusCxp', 'bad', '✕ Token rejected',
        `<div class="line">${esc(d.fatal || failed?.detail || 'the server could not verify this token')}</div>`);
    }
  } catch (err) {
    setStatus('statusCxp', 'bad', '✕ Something went wrong', `<div class="line">${esc(err.message)}</div>`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send CX Portal token';
  }
}

function showHint() {
  chrome.storage.local.get(['lastSent', 'lastSentCxp'], ({ lastSent, lastSentCxp }) => {
    const parts = [];
    parts.push(lastSent
      ? `Gong last sent ${new Date(lastSent).toLocaleString()}.`
      : 'Sign in to Gong in any tab, then click Send Gong session.');
    parts.push(lastSentCxp
      ? `CX Portal last sent ${new Date(lastSentCxp).toLocaleString()}.`
      : 'Sign in to CX Portal in a tab, then click Send CX Portal token.');
    $('hint').innerHTML = parts.join('<br>');
  });
}

$('send').onclick = send;
$('sendCxp').onclick = sendCxp;
$('open').onclick = (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: base() });
};
$('port').onchange = () => chrome.storage.local.set({ port: $('port').value });

chrome.storage.local.get(['port'], ({ port }) => {
  if (port) $('port').value = port;
  showHint();
});

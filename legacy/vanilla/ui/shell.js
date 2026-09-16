/**
 * shell.js — the chrome and render helpers every tab shares.
 *
 * The top bar is built here so the five tabs cannot disagree about navigation,
 * and so the global Stop button is present wherever a run might be going.
 */

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const kb = (n) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`;

export const stripName = (n) =>
  String(n).replace(/-transcript\.\w+$/, '').replace(/\.\w+$/, '');

export const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;
export const money4 = (n) => `$${(Number(n) || 0).toFixed(4)}`;

const TABS = [
  { id: 'projects', href: '/projects.html', label: 'Projects' },
  { id: 'workbench', href: '/workbench.html', label: 'Workbench' },
  { id: 'preview', href: '/preview.html', label: 'Preview' },
  { id: 'pull', href: '/', label: 'Pull' },
  { id: 'automation', href: '/automation.html', label: 'Automation' },
];

/**
 * Build the top bar and keep its live bits fresh.
 *
 * `current` is the tab id to highlight. The Stop button reflects server state
 * rather than this page's, so a run started in another tab is still visible
 * and stoppable from here.
 */
export async function mountTopbar(el, current) {
  el.innerHTML = `
    <div class="brand"><img src="assets/gong.png" alt="">Gong Transcripts</div>
    <nav class="seg">
      ${TABS.map((t) => `<a href="${t.href}"${t.id === current ? ' aria-current="page"' : ''}>${t.label}</a>`).join('')}
    </nav>
    <div class="spacer"></div>
    <button class="stop" id="shell-stop" type="button" title="Stop every running job">
      <span class="pulse"></span><span id="shell-stop-label">Stop</span>
    </button>
    <span class="chip" id="shell-auto" hidden></span>
    <span class="chip" id="shell-usage">$0.00</span>
    <a class="icon-btn" href="/workbench.html#config" title="Settings and skills"
       style="text-decoration:none">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6 1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.36.4.67.74.87"/>
      </svg>
    </a>`;

  const stop = el.querySelector('#shell-stop');
  stop.onclick = async () => {
    el.querySelector('#shell-stop-label').textContent = 'Stopping…';
    try {
      await fetch('/api/cancel', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
    } catch { /* ignore */ }
    poll();
  };

  async function poll() {
    try {
      const d = await fetch('/api/running').then((r) => r.json());
      const n = (d.jobs || []).length;
      stop.classList.toggle('show', n > 0);
      el.querySelector('#shell-stop-label').textContent = n === 1
        ? `Stop 1 job (${Math.round(d.jobs[0].elapsedMs / 1000)}s)`
        : `Stop ${n} jobs`;
      el.querySelector('#shell-usage').textContent = money(d.usage?.totalUsd);
    } catch { /* server restarting */ }

    try {
      const a = await fetch('/api/automation').then((r) => r.json());
      const chip = el.querySelector('#shell-auto');
      chip.hidden = !a.enabled;
      if (a.enabled) {
        chip.textContent = `auto ${a.time}`;
        chip.style.color = a.missed ? 'var(--warn)' : 'var(--ok)';
        chip.title = a.nextRunAt
          ? `Next run ${new Date(a.nextRunAt).toLocaleString()}`
          : '';
      }
    } catch { /* ignore */ }
  }

  await poll();
  setInterval(poll, 3000);
}

/** The covering email, as a copyable box rather than a file on disk. */
export function renderEmailBox(host, email, { attachCopy, COPY_ICON, mdToHtml, esc: e }) {
  const box = document.createElement('div');
  box.className = 'email';
  box.innerHTML = `
    <div class="h">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linejoin="round">
        <rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 7 10 6 10-6"/></svg>
      Email draft<span class="sp"></span><button class="copy" type="button"></button>
    </div>
    ${email.subject ? `<div class="subj"><span class="lbl">Subject</span>
      <span class="val">${e(email.subject)}</span></div>` : ''}
    <div class="body"><div class="md">${mdToHtml(email.body)}</div></div>`;

  host.append(box);
  const btn = box.querySelector('.copy');
  btn.innerHTML = COPY_ICON + 'Copy';
  btn.title = 'Copy the subject and body';
  attachCopy(btn, () => email.clipboard, () => box.querySelector('.md'));
  return box;
}

/** A generated document, collapsed by default. */
export function renderDocCard(host, file, { esc: e, kb: size, mdToHtml }) {
  const card = document.createElement('div');
  card.className = 'doc-card';
  const isMd = /\.md$/i.test(file.name);

  card.innerHTML = `
    <div class="h">
      <svg class="ic" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linejoin="round">
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>
      <span class="nm" title="${e(file.path)}">${e(file.name)}</span>
      <span class="sz">${size(file.size)}</span>
      ${isMd ? `<button class="toggle" type="button" title="Show contents">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2.4"><path d="m6 9 6 6 6-6" stroke-linecap="round"/></svg></button>` : ''}
    </div>
    <div class="b"></div>`;

  host.append(card);
  const body = card.querySelector('.b');

  if (!isMd) {
    card.classList.add('open');
    body.innerHTML = `<a class="dl" href="/api/file?path=${encodeURIComponent(file.path)}&raw=1" download>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>
      </svg>Download ${e(file.name)}</a>`;
    return card;
  }

  card.querySelector('.toggle').onclick = async () => {
    card.classList.toggle('open');
    if (!card.classList.contains('open') || body.dataset.loaded) return;
    body.dataset.loaded = '1';
    try {
      const d = await fetch(`/api/file?path=${encodeURIComponent(file.path)}`).then((r) => r.json());
      body.innerHTML = `<div class="md">${mdToHtml(d.content || '')}</div>`;
    } catch (err) {
      body.innerHTML = `<div class="empty">${e(err.message)}</div>`;
    }
  };
  return card;
}

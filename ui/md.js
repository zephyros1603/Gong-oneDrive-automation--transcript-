/**
 * md.js — markdown rendering and clipboard helpers, shared by the pages.
 *
 * A small parser rather than a CDN library: these pages are served locally and
 * should keep working with no network. The source is escaped before any inline
 * rule is applied, so transcript and document text cannot inject markup.
 */

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function mdToHtml(src) {
  const esc = (t) => String(t).replace(/[&<>]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  // Lift fenced code out first so inline rules never touch its contents.
  const fences = [];
  let text = String(src).replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code) => {
    fences.push(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
    return `\u001fF${fences.length - 1}\u001f`;
  });

  const inline = (t) => esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) =>
      // Only real web links become anchors; anything else stays plain text.
      /^(https?:|mailto:)/i.test(href)
        ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`
        : label);

  const out = [];
  const lines = text.split('\n');
  let para = [];
  let list = null;
  let quote = [];

  const flushPara = () => {
    if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; }
  };
  const flushList = () => {
    if (list) {
      out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
      list = null;
    }
  };
  const flushQuote = () => {
    if (quote.length) { out.push(`<blockquote>${inline(quote.join(' '))}</blockquote>`); quote = []; }
  };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\u001fF(\d+)\u001f$/.exec(line.trim());

    if (fence) { flushAll(); out.push(fences[Number(fence[1])]); continue; }
    if (!line.trim()) { flushAll(); continue; }

    if (/^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushAll(); out.push('<hr>'); continue; }

    const h = /^ {0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (h) { flushAll(); out.push(`<h${h[1].length}>${inline(h[2].trim())}</h${h[1].length}>`); continue; }

    // A pipe row followed by a dashed row is a table.
    if (line.includes('|') && /^\s*\|?[\s:-]*-[\s|:-]*$/.test(lines[i + 1] || '')) {
      flushAll();
      const cells = (l) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      const head = cells(line);
      const body = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|')) body.push(cells(lines[i++]));
      i--;
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>` +
        `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
      );
      continue;
    }

    const q = /^ {0,3}>\s?(.*)$/.exec(line);
    if (q) { flushPara(); flushList(); quote.push(q[1]); continue; }

    const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flushPara(); flushQuote();
      const tag = /\d/.test(li[1]) ? 'ol' : 'ul';
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push(li[2]);
      continue;
    }

    flushList(); flushQuote();
    para.push(line.trim());
  }
  flushAll();
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// email drafts
// ---------------------------------------------------------------------------

/**
 * The drafts write headers as `**Subject:** …` — the asterisks wrap the colon
 * too, so matching them in place is fiddly and left `**` in the subject.
 * Strip bold markers from the line first, then match plainly.
 */
const bareHeader = (line) => line.replace(/\*\*/g, '').trim();

/** Routing lines the skill emits that are not part of the message itself. */
const DROPPED_HEADERS = /^(to|from|cc|bcc|attachment|attachments)\s*:/i;
const SUBJECT_LINE = /^subject\s*:\s*(.*)$/i;

/** Does this look like one of the generated email drafts? */
export function looksLikeEmail(text) {
  return String(text)
    .slice(0, 600)
    .split('\n')
    .some((l) => {
      const bare = bareHeader(l);
      return SUBJECT_LINE.test(bare) || /^to\s*:/i.test(bare);
    });
}

/**
 * Split an email draft into subject and body, dropping the addressing lines.
 *
 * To / From / Cc / Attachment are routing metadata that gets re-entered in the
 * mail client anyway, so they are stripped from both the preview and the copy.
 */
export function parseEmail(text) {
  const lines = String(text).split('\n');
  let subject = '';
  const body = [];
  let inHeaders = true;

  for (const line of lines) {
    if (inHeaders) {
      const bare = bareHeader(line);

      const sub = SUBJECT_LINE.exec(bare);
      if (sub) { subject = sub[1].trim(); continue; }
      if (DROPPED_HEADERS.test(bare)) continue;

      // A horizontal rule or the first real prose ends the header block.
      if (/^-{3,}$/.test(bare)) { inHeaders = false; continue; }
      if (!bare) continue;

      inHeaders = false;
    }
    body.push(line);
  }

  return {
    subject,
    body: body.join('\n').trim(),
    /** What the copy button puts on the clipboard. */
    get clipboard() {
      return (this.subject ? `Subject: ${this.subject}\n\n` : '') + this.body;
    },
  };
}

// ---------------------------------------------------------------------------
// clipboard
// ---------------------------------------------------------------------------

/**
 * 127.0.0.1 counts as a secure context so the async clipboard API is normally
 * available; fall back to a hidden textarea when it is not (an unfocused
 * document, or a browser that refuses the permission).
 */
export async function writeClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }

  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.append(ta);
    ta.select();
    const done = document.execCommand('copy');
    ta.remove();
    return done;
  } catch {
    return false;
  }
}

export const COPY_ICON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<rect x="9" y="9" width="12" height="12" rx="2"/>' +
  '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

export const TICK_ICON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M20 6 9 17l-5-5"/></svg>';

/**
 * Wire a copy button. On failure it selects the rendered text and says so,
 * rather than claiming a selection that may not exist.
 */
export function attachCopy(button, getText, getSelectableEl) {
  button.onclick = async () => {
    const ok = await writeClipboard(getText());

    if (!ok) {
      let selected = false;
      try {
        const el = getSelectableEl?.();
        if (el) {
          const range = document.createRange();
          range.selectNodeContents(el);
          const sel = getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          selected = true;
        }
      } catch { /* nothing selectable */ }

      button.classList.remove('done');
      button.innerHTML = COPY_ICON + (selected ? 'Selected — press ⌘C' : 'Copy failed');
      setTimeout(() => { button.innerHTML = COPY_ICON + 'Copy'; }, 2600);
      return;
    }

    button.classList.add('done');
    button.innerHTML = TICK_ICON + 'Copied';
    setTimeout(() => {
      button.classList.remove('done');
      button.innerHTML = COPY_ICON + 'Copy';
    }, 1800);
  };
}

export const MD_STYLES = `
  .md { font-size: 13.5px; line-height: 1.65; }
  .md > :first-child { margin-top: 0; }
  .md h1, .md h2, .md h3, .md h4 {
    margin: 22px 0 12px; line-height: 1.3; font-weight: 620; letter-spacing: -.01em;
  }
  .md h1 { font-size: 21px; padding-bottom: 8px; border-bottom: 1px solid var(--line); }
  .md h2 { font-size: 17px; padding-bottom: 6px; border-bottom: 1px solid var(--line-soft); }
  .md h3 { font-size: 15px; }
  .md h4 { font-size: 13.5px; color: var(--muted); }
  .md p { margin: 0 0 13px; }
  .md strong { font-weight: 620; color: var(--text); }
  .md em { font-style: italic; }
  .md a { color: var(--accent); text-decoration: none; }
  .md a:hover { text-decoration: underline; }
  .md code {
    font: 12px/1.5 var(--mono);
    background: var(--surface-2); border: 1px solid var(--line-soft);
    border-radius: 5px; padding: 1px 5px;
  }
  .md pre {
    background: var(--surface-2); border: 1px solid var(--line);
    border-radius: 8px; padding: 12px 14px; overflow-x: auto; margin: 0 0 14px;
  }
  .md pre code { background: none; border: none; padding: 0; font-size: 11.5px; }
  .md blockquote {
    margin: 0 0 14px; padding: 2px 0 2px 14px;
    border-left: 3px solid var(--line); color: var(--muted);
  }
  .md ul, .md ol { margin: 0 0 14px; padding-left: 22px; }
  .md li { margin: 3px 0; }
  .md hr { border: none; border-top: 1px solid var(--line); margin: 20px 0; }
  .md table {
    border-collapse: collapse; margin: 0 0 14px; font-size: 12.5px;
    display: block; overflow-x: auto;
  }
  .md th, .md td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; }
  .md th { background: var(--surface-2); font-weight: 600; }
`;

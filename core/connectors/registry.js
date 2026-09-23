/**
 * core/connectors/registry.js — every application Warp can talk to.
 *
 * One shape for all of them, so the Applications page is a list rather than a
 * set of special cases, and adding Jira later is a file here plus whatever
 * client code it needs — no UI work.
 *
 * `configSchema` drives the form. `test()` is what the Credentials tab calls.
 * `capabilities` is what the rest of the app reads to decide what a workflow
 * may use as a source, so a disconnected application simply stops appearing.
 */

import { loadConfig } from '../../gong.js';
import { testConnection, inspectCookie } from '../gong/diagnose.js';
import { getEngine } from '../claude/engine.js';
import { listSkills } from '../../claude-runner.js';
import * as library from '../../library.js';
import { listProjects } from '../../projects.js';
import { listSchedules } from '../workflow/store.js';
import { listGraphs } from '../graph/store.js';
import { readSettings } from '../../settings.js';
import { CxPortal } from './cxportal.js';
import { cxClient } from './cx-client.js';
import { contextStatus } from '../workflow/projectContext.js';

/** Field kinds the Applications form knows how to render. */
export const FIELD = {
  TEXT: 'text',
  SECRET: 'secret',
  SELECT: 'select',
  NUMBER: 'number',
};

const gong = {
  id: 'gong',
  name: 'Gong',
  vendor: 'Gong.io',
  kind: 'Conversation intelligence',
  auth: 'Session cookie',
  capabilities: ['transcripts'],
  /** The Data tab of this application is the transcript pull. */
  dataTab: { label: 'Data', kind: 'pull' },
  tabs: ['Configuration', 'Credentials', 'Data', 'Schema'],

  configSchema: [
    { key: 'GONG_HOST', label: 'Host', type: FIELD.TEXT, section: 'Basic Details',
      hint: 'Your Gong tenant, e.g. us-81357.app.gong.io' },
    { key: 'GONG_WORKSPACE_ID', label: 'Workspace ID', type: FIELD.TEXT, section: 'Basic Details',
      hint: 'Blank auto-detects. Not global — most tenants have more than one' },
    { key: 'GONG_USER_ID', label: 'User ID', type: FIELD.TEXT, section: 'Config',
      hint: 'Blank reads it from the CSRF token' },
    { key: 'GONG_ACCOUNT_ID', label: 'Account ID', type: FIELD.TEXT, section: 'Config',
      hint: 'Used by account-scoped pulls' },
    { key: 'GONG_OUT_DIR', label: 'Transcript folder', type: FIELD.TEXT, section: 'Config' },
    { key: 'GONG_FORMAT', label: 'Format', type: FIELD.SELECT, section: 'Config',
      options: ['md', 'text', 'srt', 'vtt'] },
  ],
  credentialSchema: [
    { key: 'GONG_COOKIE', label: 'Session cookie', type: FIELD.SECRET, multiline: true,
      hint: 'Sign in to Gong in Chrome and click the extension — no copy-paste needed' },
  ],

  async status() {
    const cfg = loadConfig();
    const cookie = inspectCookie(cfg.cookie);
    const expiresAt = cookie.cellExpires || cookie.loginExpires || null;
    return {
      configured: Boolean(cfg.cookie && cfg.host),
      connected: cookie.missing.length === 0,
      detail: cookie.email || cfg.host,
      expiresAt,
      host: cfg.host,
    };
  },

  async test(overrides = {}) {
    return testConnection(overrides);
  },
};

const claude = {
  id: 'claude',
  name: 'Claude Code',
  vendor: 'Anthropic',
  kind: 'Generation engine',
  auth: 'CLI subscription',
  capabilities: ['generate'],
  // No data of its own and nothing to map, but skills are Claude's
  // configuration surface and have to live somewhere.
  tabs: ['Configuration', 'Skills'],

  configSchema: [
    { key: 'model', label: 'Model', type: FIELD.TEXT, section: 'Basic Details',
      hint: 'Blank uses whatever the CLI defaults to' },
    { key: 'maxTurns', label: 'Maximum turns per run', type: FIELD.NUMBER, section: 'Basic Details',
      hint: 'A circuit breaker on a run that loops. A MOM takes 11–18' },
    { key: 'outputDir', label: 'Output folder', type: FIELD.TEXT, section: 'Basic Details' },
  ],
  credentialSchema: [],

  async status() {
    const engine = getEngine();
    const ok = await engine.available();
    const skills = listSkills();
    return {
      configured: true,
      connected: ok,
      detail: ok ? `${skills.length} skill(s) installed` : 'CLI not found on PATH',
      engine: engine.name,
    };
  },

  async test() {
    const engine = getEngine();
    const ok = await engine.available();
    return {
      ok,
      checks: [{
        step: 'cli', ok,
        detail: ok ? 'the Claude Code CLI is on PATH and responding' : 'not found — set CLAUDE_BIN',
      }],
    };
  },
};

const cxportal = {
  id: 'cxportal',
  name: 'CX Portal',
  vendor: 'Aquera',
  kind: 'Project tracker',
  auth: 'Cognito bearer token',
  capabilities: ['projects', 'tasks', 'customers', 'stations'],
  tabs: ['Configuration', 'Credentials', 'Data', 'Schema'],
  dataTab: { label: 'Data', kind: 'cxportal' },

  configSchema: [
    { key: 'CXPORTAL_HOST', label: 'API host', type: FIELD.TEXT, section: 'Basic Details',
      hint: 'https://saapi.aquera.com' },
    { key: 'CXPORTAL_CONSULTANT', label: 'Your name in the tracker', type: FIELD.TEXT, section: 'Config',
      hint: 'The IC display name, e.g. Sanjan. Used to scope "my projects"' },
    { key: 'CXPORTAL_HIDE_CLOSED', label: 'Hide closed and blocked', type: FIELD.SELECT,
      section: 'Config', options: ['on', 'off'],
      hint: 'On matches the on-screen counts in the portal; off returns everything' },
  ],

  credentialSchema: [
    { key: 'CXPORTAL_TOKEN', label: 'Access token', type: FIELD.SECRET, multiline: true,
      hint: "Cognito accessToken, NOT idToken. In the portal console: copy(localStorage.getItem('accessToken')). Lasts about an hour." },
    { key: 'CXPORTAL_REFRESH_TOKEN', label: 'Refresh token', type: FIELD.SECRET, multiline: true,
      hint: "copy(localStorage.getItem('refreshToken')). With this, the access token renews itself and schedules work unattended. Without it this connector only works while you are here to paste a new one." },
  ],

  async status() {
    const cfg = loadConfig();
    const client = cxClient();
    const t = client.tokenInfo();

    if (!t.present) {
      return { configured: false, connected: false, detail: 'No token yet' };
    }
    if (t.expired) {
      // With a refresh token this is self-healing, so it is not a failure —
      // saying "expired" here would send someone to fix what fixes itself.
      if (cfg.cxRefreshToken) {
        return {
          configured: true, connected: true,
          detail: 'Token renews automatically', expiresAt: t.expiresAt,
        };
      }
      return {
        configured: true, connected: false,
        detail: `Token expired ${Math.abs(t.minutesLeft)} min ago — paste a fresh one`,
        expiresAt: t.expiresAt,
      };
    }
    return {
      configured: true, connected: true,
      detail: cfg.cxRefreshToken
        ? `${t.username || 'signed in'} · renews automatically`
        : `${t.username || 'signed in'} · ${t.minutesLeft} min left`,
      expiresAt: t.expiresAt,
    };
  },

  async test(overrides = {}) {
    const cfg = loadConfig();
    const client = cxClient({
      host: overrides.CXPORTAL_HOST,
      token: overrides.CXPORTAL_TOKEN ?? undefined,
      refreshToken: overrides.CXPORTAL_REFRESH_TOKEN ?? undefined,
    });
    const checks = [];

    // Renew first if we can, so the test reports what a *scheduled* run would
    // experience rather than what this minute happens to look like.
    if (client.needsRefresh && client.refreshToken) {
      try {
        await client.refresh();
        checks.push({ step: 'refresh', ok: true, detail: 'renewed the access token' });
      } catch (err) {
        checks.push({ step: 'refresh', ok: false, detail: err.message });
        return { ok: false, checks };
      }
    }
    const t = client.tokenInfo();

    if (!t.present) {
      checks.push({ step: 'token', ok: false, detail: 'no token supplied' });
      return { ok: false, checks };
    }

    // Two things go wrong before a request is ever made, and both produce an
    // indistinguishable 401 if you let them: the wrong token of the pair, and
    // one that has simply aged out.
    if (t.tokenUse && t.tokenUse !== 'access') {
      checks.push({
        step: 'token', ok: false,
        detail: `this is the ${t.tokenUse} token — the API only accepts the accessToken`,
      });
      return { ok: false, checks };
    }
    if (t.expired) {
      checks.push({
        step: 'token', ok: false,
        detail: client.refreshToken
          ? `expired ${Math.abs(t.minutesLeft)} minutes ago and the refresh did not take`
          : `expired ${Math.abs(t.minutesLeft)} minutes ago — add a refresh token to renew automatically`,
      });
      return { ok: false, checks };
    }
    checks.push({
      step: 'token', ok: true,
      detail: `${t.username || 'valid'} · expires ${new Date(t.expiresAt).toLocaleTimeString()}`,
    });

    // The cheapest authenticated call there is.
    try {
      await client.unreadCount();
      checks.push({ step: 'auth', ok: true, detail: 'the API accepted the token' });
    } catch (err) {
      checks.push({ step: 'auth', ok: false, detail: err.message });
      return { ok: false, checks, tokenInfo: t };
    }

    try {
      const projects = await client.listProjects({ size: 1 });
      const n = Array.isArray(projects) ? projects.length
        : (projects?.items?.length ?? projects?.projects?.length ?? '?');
      checks.push({ step: 'projects', ok: true, detail: `list_projects answered (${n} in the first page)` });
    } catch (err) {
      checks.push({ step: 'projects', ok: false, detail: err.message });
      return { ok: false, checks, tokenInfo: t };
    }

    return { ok: true, checks, tokenInfo: t };
  },
};

/**
 * Warp's own capabilities, configured the same way an external source is.
 *
 * They are applications because that is where configuration lives now — one
 * place to look, one form to fill, one refresh button. The difference from
 * Gong or Jira is only that these connect to Warp itself, so they are always
 * connected and cannot be removed.
 */
const projectsApp = {
  id: 'projects',
  name: 'Projects',
  vendor: 'Warp',
  kind: 'Customer workspaces',
  auth: 'Built in',
  capabilities: ['projects'],
  builtin: true,
  tabs: ['Configuration', 'Data'],
  dataTab: { label: 'Data', kind: 'projects' },
  configSchema: [
    { key: 'sortedDir', label: 'Grouped transcripts folder', type: FIELD.TEXT, section: 'Basic Details',
      hint: 'Where organize.js writes the per-customer tree that projects are built from' },
    { key: 'autoSync', label: 'Create projects automatically', type: FIELD.SELECT, section: 'Config',
      options: ['on', 'off'],
      hint: 'On: a new customer folder becomes a project the next time the pipeline runs' },
  ],
  credentialSchema: [],
  async status() {
    const n = listProjects().length;
    return { configured: true, connected: true, detail: `${n} customer workspace(s)` };
  },
  async test() {
    return { ok: true, checks: [{ step: 'projects', ok: true, detail: `${listProjects().length} projects` }] };
  },
};

const libraryApp = {
  id: 'library',
  name: 'Library',
  vendor: 'Warp',
  kind: 'Files on disk',
  auth: 'Built in',
  capabilities: ['files'],
  builtin: true,
  tabs: ['Configuration', 'Data'],
  dataTab: { label: 'Data', kind: 'library' },
  configSchema: [
    { key: 'GONG_OUT_DIR', label: 'Transcripts', type: FIELD.TEXT, section: 'Basic Details' },
    { key: 'GONG_SORTED_DIR', label: 'Grouped by customer', type: FIELD.TEXT, section: 'Basic Details' },
    { key: 'outputDir', label: 'Generated documents', type: FIELD.TEXT, section: 'Basic Details' },
    { key: 'GONG_PREVIEW_DIRS', label: 'Extra folders', type: FIELD.TEXT, section: 'Config',
      hint: 'Colon-separated. Anything here is previewable and in scope for workflows' },
  ],
  credentialSchema: [],
  async status() {
    const files = library.listFiles();
    const roots = library.roots().length;
    return { configured: true, connected: true, detail: `${files.length} file(s) across ${roots} folder(s)` };
  },
  async test() {
    const roots = library.roots();
    return {
      ok: roots.length > 0,
      checks: roots.map((r) => ({ step: r.label, ok: true, detail: r.path })),
    };
  },
};

const graphApp = {
  id: 'graph',
  name: 'Graph',
  vendor: 'Warp',
  kind: 'Relationships and policy',
  auth: 'Built in',
  capabilities: ['graph'],
  builtin: true,
  tabs: ['Configuration', 'Data'],
  dataTab: { label: 'Data', kind: 'graph' },
  configSchema: [],   // policy is edited on the Graph page, not as flat fields
  credentialSchema: [],
  async status() {
    const n = listGraphs().length;
    return { configured: true, connected: true, detail: `${n} graph(s) defined` };
  },
  async test() {
    return { ok: true, checks: [{ step: 'graph', ok: true, detail: `${listGraphs().length} graphs` }] };
  },
};

const automationApp = {
  id: 'automation',
  name: 'Automation',
  vendor: 'Warp',
  kind: 'Schedules and runs',
  auth: 'Built in',
  capabilities: ['schedule'],
  builtin: true,
  tabs: ['Configuration', 'Data'],
  dataTab: { label: 'Data', kind: 'automation' },
  configSchema: [
    { key: 'defaultTime', label: 'Default time', type: FIELD.TEXT, section: 'Basic Details',
      hint: 'Pre-filled when a new schedule is created' },
    { key: 'defaultGrace', label: 'Default grace window', type: FIELD.NUMBER, section: 'Basic Details',
      hint: 'Minutes a slot may be late and still run. Past it, the day is recorded as missed' },
    { key: 'maxTurns', label: 'Maximum turns per run', type: FIELD.NUMBER, section: 'Config',
      hint: 'A circuit breaker on a run that loops' },
  ],
  credentialSchema: [],
  async status() {
    const all = listSchedules();
    const on = all.filter((s) => s.enabled).length;
    return { configured: true, connected: true, detail: `${on} of ${all.length} schedule(s) enabled` };
  },
  async test() {
    const all = listSchedules();
    return { ok: true, checks: [{ step: 'schedules', ok: true, detail: `${all.length} defined` }] };
  },
};

const contextApp = {
  id: 'context',
  name: 'Context',
  vendor: 'Warp',
  kind: 'Per-project context files',
  auth: 'Built in',
  capabilities: ['context'],
  builtin: true,
  tabs: ['Configuration', 'Data'],
  dataTab: { label: 'Data', kind: 'context' },
  configSchema: [],
  credentialSchema: [],
  async status() {
    const rows = contextStatus();
    const built = rows.filter((r) => r.exists).length;
    return { configured: true, connected: true, detail: `${built} of ${rows.length} project(s) have a context file` };
  },
  async test() {
    const rows = contextStatus();
    return { ok: true, checks: [{ step: 'context', ok: true, detail: `${rows.length} project(s) tracked` }] };
  },
};

/** Not built yet, but shown so the shape of the thing is visible. */
const planned = [
  { id: 'jira', name: 'Jira', vendor: 'Atlassian', kind: 'Project management',
    auth: 'OAuth 2.0', capabilities: ['issues'], planned: true, tabs: ['Configuration'] },
  { id: 'm365', name: 'Microsoft 365', vendor: 'Microsoft', kind: 'Mail and calendar',
    auth: 'OAuth 2.0', capabilities: ['email', 'calendar'], planned: true, tabs: ['Configuration'] },
  { id: 'slack', name: 'Slack', vendor: 'Salesforce', kind: 'Messaging',
    auth: 'OAuth 2.0', capabilities: ['messages'], planned: true, tabs: ['Configuration'] },
  { id: 'zoom', name: 'Zoom', vendor: 'Zoom', kind: 'Meetings',
    auth: 'OAuth 2.0', capabilities: ['transcripts'], planned: true, tabs: ['Configuration'] },
];

export const CONNECTORS = [
  gong, claude, cxportal,
  projectsApp, libraryApp, graphApp, automationApp, contextApp,
  ...planned,
];

export const getConnector = (id) => CONNECTORS.find((c) => c.id === id) || null;

/** The list view. Status is probed per connector and never allowed to throw. */
export async function listConnectors() {
  return Promise.all(CONNECTORS.map(async (c) => {
    let status = { configured: false, connected: false, detail: 'Not configured yet' };
    if (!c.planned && c.status) {
      try { status = await c.status(); } catch (err) { status = { configured: false, connected: false, detail: err.message }; }
    }
    return {
      id: c.id, name: c.name, vendor: c.vendor, kind: c.kind, auth: c.auth,
      capabilities: c.capabilities, planned: Boolean(c.planned),
      builtin: Boolean(c.builtin),
      hasData: Boolean(c.dataTab), tabs: c.tabs || ['Configuration'],
      ...status,
    };
  }));
}

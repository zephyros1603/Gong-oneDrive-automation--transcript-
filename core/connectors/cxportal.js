/**
 * core/connectors/cxportal.js — the Aquera CX Portal project tracker.
 *
 * Reverse-engineered from a live session, same as the Gong client. Two things
 * about it differ from every other connector here and shape the design:
 *
 *   1. **The token lives about an hour.** Gong's cookie lasts ~16 days, so
 *      "paste it and forget" works there. It does not work here: a schedule
 *      firing at 09:00 will almost always find an expired token. Until the
 *      Cognito refresh flow is implemented this connector is usable
 *      interactively and unreliable on a timer — `tokenInfo()` exists so the
 *      UI can say so rather than failing at run time.
 *
 *   2. **Almost the whole API is one path** dispatched by `?action=`. That
 *      makes a generic `action()` the primary method and the named helpers
 *      thin wrappers over it, rather than the other way round.
 *
 * Response schemas were never captured, so nothing here assumes a field name.
 * `shapeOf()` reports what actually came back, which is how the mapping gets
 * filled in without guessing.
 */

const DEFAULT_HOST = 'https://saapi.aquera.com';

/**
 * Refresh a little before expiry rather than on it — a request that starts
 * with 30 seconds left can still arrive expired.
 */
const REFRESH_MARGIN_MS = 5 * 60000;

/** Every action observed on the wire. Only two have known parameters. */
export const ACTIONS = [
  'list_projects', 'stats', 'dashboard_aggs_v2', 'tc_analysis_aggs',
  'planned_hours', 'list_project_customers', 'customer_enriched',
  'list_stations', 'get_stations_grid_summary', 'list_tasks', 'calendar_tasks',
  'list_audit_logs', 'get_user_filters', 'get_unread_notification_count',
  'bulk_gong_counts', 'bulk_outlook_next',
];

export const FILTER_OPERATORS = [
  'equals', 'notEquals', 'contains', 'isAnyOf', 'isNotAnyOf',
  'startsWith', 'endsWith', 'isEmpty',
];

/** Attribute keys confirmed byte-for-byte on the wire. */
export const ATTRIBUTES = {
  consultantName: 'IC',
  secondaryConsultantName: 'Secondary IC',
  implementationPhase: 'Project Status',
};

/**
 * The Projects tab silently hides closed and customer-blocked work. Include
 * this to match the on-screen counts; omit it to get everything.
 */
export const HIDE_CLOSED = {
  attribute: 'implementationPhase',
  operator: 'isNotAnyOf',
  value: [
    'phase_1780114483755', 'phase_1781519413237', 'phase_1780652904894',
    'phase_1780652917137', 'phase_1780652926287',
  ].join('|||'),
  value2: '',
};

/** One filter clause. Multi-select values join with a literal `|||`. */
export const clause = (attribute, operator, value, value2 = '') => ({
  attribute,
  operator,
  value: Array.isArray(value) ? value.join('|||') : String(value ?? ''),
  value2,
});

/** Decode a JWT payload without verifying it — we only want `exp`. */
function jwtPayload(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return null;
    return JSON.parse(
      Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    );
  } catch {
    return null;
  }
}

export class CxPortal {
  /**
   * @param refreshToken  Cognito refresh token. With it, an expired access
   *   token renews itself and the connector becomes usable on a schedule;
   *   without it this is an interactive-only integration, because the access
   *   token lasts about an hour.
   * @param onToken  called after a successful renewal with
   *   `{ accessToken, refreshToken, expiresAt, rotated }` so the caller can
   *   persist both — otherwise every process mints its own access token, and
   *   a rotated refresh token would be dropped on the floor.
   */
  constructor({ host = DEFAULT_HOST, token = '', refreshToken = '', clientId = '', region = '', onToken = null } = {}) {
    this.host = (host || DEFAULT_HOST).replace(/\/+$/, '');
    this.token = String(token || '').trim();
    this.refreshToken = String(refreshToken || '').trim();
    this.onToken = onToken;

    // Both are recoverable from the access token itself, so neither has to be
    // configured by hand: `client_id` is a claim, and the region prefixes the
    // Cognito pool id in `iss`.
    const p = jwtPayload(this.token) || {};
    this.clientId = clientId || p.client_id || '';
    this.region = region || String(p.iss || '').match(/cognito-idp\.([a-z0-9-]+)\.amazonaws/)?.[1] || 'us-west-2';
  }

  /** True when the access token is gone, expired, or about to be. */
  get needsRefresh() {
    if (!this.token) return true;
    const t = this.tokenInfo();
    return !t.expiresAt || Date.now() > t.expiresAt - REFRESH_MARGIN_MS;
  }

  /**
   * Exchange the refresh token for a new access token.
   *
   * This is Cognito's own endpoint, not the portal's — `InitiateAuth` with
   * `REFRESH_TOKEN_AUTH`, which needs no secret for a public SPA client.
   */
  async refresh() {
    if (!this.refreshToken) throw new Error('no refresh token stored — cannot renew automatically');
    if (!this.clientId) throw new Error('no Cognito client id — paste an access token once so it can be read');

    const res = await fetch(`https://cognito-idp.${this.region}.amazonaws.com/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': 'AWSCognitoIdentityProviderService.InitiateAuth',
      },
      body: JSON.stringify({
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        ClientId: this.clientId,
        AuthParameters: { REFRESH_TOKEN: this.refreshToken },
      }),
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const kind = body.__type || `HTTP ${res.status}`;
      throw new Error(
        kind.includes('NotAuthorized')
          ? 'the refresh token has been revoked or expired — sign in to the portal again'
          : `refresh failed: ${kind}`
      );
    }

    const auth = body?.AuthenticationResult || {};
    const next = auth.AccessToken;
    if (!next) throw new Error('refresh returned no access token');

    this.token = next;

    // Refresh-token rotation. A pool with rotation switched on returns a new
    // refresh token here and starts a short grace period on the old one; a
    // pool without it returns nothing and the original stays valid. Persisting
    // whatever comes back covers both, and not doing so is a failure that only
    // shows up days later, as an unattended schedule that silently stopped.
    const rotated = auth.RefreshToken && auth.RefreshToken !== this.refreshToken
      ? auth.RefreshToken
      : null;
    if (rotated) this.refreshToken = rotated;

    await this.onToken?.({
      accessToken: next,
      refreshToken: rotated,          // null unless the pool rotated it
      expiresAt: this.tokenInfo().expiresAt,
      rotated: Boolean(rotated),
    });
    return next;
  }

  /** Renew if needed and possible. Silent when there is nothing to renew. */
  async ensureFresh() {
    if (!this.needsRefresh) return { refreshed: false };
    if (!this.refreshToken) return { refreshed: false, reason: 'no refresh token' };
    await this.refresh();
    return { refreshed: true, expiresAt: this.tokenInfo().expiresAt };
  }

  /**
   * What the token says about itself. Cheap, offline, and the only way to
   * warn about expiry before a request fails with a bare 401.
   */
  tokenInfo() {
    if (!this.token) return { present: false };
    const p = jwtPayload(this.token);
    const expiresAt = p?.exp ? p.exp * 1000 : null;
    return {
      present: true,
      // `accessToken` and `idToken` are both in localStorage and are easy to
      // confuse; only the access token is accepted. Cognito marks it.
      looksLikeAccessToken: p?.token_use ? p.token_use === 'access' : null,
      tokenUse: p?.token_use || null,
      username: p?.username || p?.sub || null,
      clientId: p?.client_id || null,
      expiresAt,
      expired: expiresAt ? Date.now() > expiresAt : null,
      minutesLeft: expiresAt ? Math.round((expiresAt - Date.now()) / 60000) : null,
    };
  }

  get headers() {
    return { authorization: `Bearer ${this.token}`, accept: 'application/json' };
  }

  async request(path, params = {}) {
    // Renew before the call rather than retrying after a 401: a retry loop
    // around an expired token is indistinguishable from one around a revoked
    // one, and the second should fail immediately.
    if (this.needsRefresh && this.refreshToken) {
      await this.refresh().catch(() => {});
    }
    if (!this.token) throw new Error('no CX Portal token — paste one in Credentials');

    const url = new URL(path, this.host);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    }

    const res = await fetch(url, { headers: this.headers });

    if (res.status === 401 || res.status === 403) {
      const info = this.tokenInfo();
      throw new Error(
        info.expired
          ? `the token expired ${Math.abs(info.minutesLeft)} minutes ago — copy a fresh one`
          : 'the token was rejected — check it is the accessToken, not the idToken'
      );
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url.pathname}?action=${params.action || ''}`);

    const text = await res.text();
    try { return JSON.parse(text); } catch { return text; }
  }

  /** The generic dispatcher. Almost the whole API is this one path. */
  action(name, params = {}) {
    return this.request('/ops/project-tracker', { action: name, ...params });
  }

  /**
   * @param filters  array of clause() objects
   * @param logic    'AND' | 'OR' — global, there is no per-clause nesting
   */
  listProjects({
    filters = [], logic = 'AND', sortField = 'lastUpdatedAt', sortOrder = 'desc',
    size = 200, cursor = null, myProjectsOnly = false, hideClosed = true,
    stationListEnabled = false,
  } = {}) {
    const all = hideClosed ? [...filters, HIDE_CLOSED] : filters;
    return this.action('list_projects', {
      filters: all.length ? JSON.stringify(all) : undefined,
      filterLogic: logic,
      sortField,
      sortOrder,
      size: String(size),
      cursor: cursor ? JSON.stringify(cursor) : undefined,
      myProjectsOnly: myProjectsOnly ? '1' : undefined,
      stationListEnabled: stationListEnabled ? 'true' : undefined,
    });
  }

  /**
   * Every project where someone is IC *or* secondary IC.
   *
   * `filterLogic` is global, so this has to be OR — with the default AND it
   * returns nothing, since almost nobody holds both slots on one project.
   * The same globalness is why a customer clause cannot be added here: it
   * would widen the result, not narrow it. Filter by customer after.
   */
  projectsForConsultant(name, opts = {}) {
    return this.listProjects({
      ...opts,
      logic: 'OR',
      hideClosed: false,   // an OR set plus an exclusion clause matches everything
      filters: [
        clause('consultantName', 'equals', name),
        clause('secondaryConsultantName', 'equals', name),
      ],
    });
  }

  /** The customer directory — static slices, six pages fetched together. */
  async customers({ pages = 6 } = {}) {
    const slices = await Promise.all(
      Array.from({ length: pages }, (_, i) =>
        this.request('/ops/customersps', {
          page: String(i + 1),
          baseFilename: 'customersps',
          s3Prefix: 'CustomersDataPS',
        }).catch(() => null))
    );
    return slices.filter(Boolean);
  }

  stats() { return this.action('stats'); }
  tasks(params) { return this.action('list_tasks', params); }
  stations(params) { return this.action('list_stations', params); }
  savedFilters() { return this.action('get_user_filters'); }
  unreadCount() { return this.action('get_unread_notification_count'); }
}

/**
 * Everything the tracker knows about one customer, as markdown.
 *
 * Written to a file rather than injected into the prompt: the agent reads
 * files through `--add-dir`, so an unused context file costs nothing, while
 * an inlined one is paid for on every single turn.
 *
 * Only fields confirmed against a live response are read — see
 * docs/cxportal-schemas.md. Anything absent is omitted rather than guessed.
 */
export function customerContextMarkdown(customer, projects) {
  const rows = projects.map((p) => ({
    name: p.name || p.displayId || p.projectId,
    status: p.status || '',
    phase: p.implementationPhase || '',
    ic: p.consultantName || '',
    sa: p.solutionsArchitectName || '',
    lead: p.implementationLeadName || '',
    source: p.connectorSource || '',
    type: p.projectType || '',
    start: (p.startDate || '').slice(0, 10),
    target: (p.targetDate || '').slice(0, 10),
    slip: p.targetDateChangeReason || '',
    slipOwner: p.targetDateChangeOwner || '',
    budget: p.budgetedHours ?? '',
    meetings: p.meetingsHeld ?? '',
    updated: (p.updatedAt || '').slice(0, 10),
  }));

  const active = rows.filter((r) => r.status === 'active');
  const slipping = rows.filter((r) => r.slip);

  const lines = [
    `# ${customer} — project tracker`,
    '',
    `Pulled from the Aquera CX Portal on ${new Date().toISOString().slice(0, 10)}.`,
    `${rows.length} project(s), ${active.length} active.`,
    '',
    '## Projects',
    '',
    '| Project | Status | Integration | IC | Start | Target go-live | Budgeted hrs | Meetings |',
    '|---|---|---|---|---|---|---|---|',
    ...rows.map((r) =>
      `| ${r.name} | ${r.status} | ${r.type || r.source} | ${r.ic} | ${r.start} | ${r.target} | ${r.budget} | ${r.meetings} |`),
  ];

  if (slipping.length) {
    lines.push('', '## Go-live changes', '');
    for (const r of slipping) {
      lines.push(`- **${r.name}** — now ${r.target}. ${r.slip}${r.slipOwner ? ` (owner: ${r.slipOwner})` : ''}`);
    }
  }

  const people = [...new Set(rows.flatMap((r) => [r.ic, r.sa, r.lead]).filter(Boolean))];
  if (people.length) lines.push('', `## People`, '', people.map((x) => `- ${x}`).join('\n'));

  return lines.join('\n') + '\n';
}

/**
 * Describe an unknown response without printing it.
 *
 * Response schemas were never captured, so the mapping has to be discovered
 * from live data. This reports the shape — keys, types, array lengths — so it
 * can be read from the UI without dumping customer data into a log.
 */
export function shapeOf(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return depth > 2
      ? `array(${value.length})`
      : { array: value.length, of: value.length ? shapeOf(value[0], depth + 1) : 'empty' };
  }
  if (typeof value === 'object') {
    if (depth > 2) return 'object';
    return Object.fromEntries(
      Object.entries(value).slice(0, 40).map(([k, v]) => [k, shapeOf(v, depth + 1)])
    );
  }
  return typeof value;
}

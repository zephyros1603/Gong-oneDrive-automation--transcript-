# CX Portal — API reference

**What this is:** everything known about the Aquera CX Portal's API, in one
place — auth, endpoints, filtering, confirmed fields, and what is still open.
Reverse-engineered from a live session; nothing here is from official
documentation, because none exists.

**Source of truth:** `core/connectors/cxportal.js`. This document explains it;
the code is what runs. If the two disagree, the code is right and this file is
stale.

**Related:**
- [`cxportal-schemas.md`](cxportal-schemas.md) — how the response shapes below
  were captured, and the capture method for closing the remaining gaps
- [`cxportal-shapes.json`](cxportal-shapes.json) — the raw capture output
- `scripts/cxportal-probe.mjs` (`npm run cx:probe`) — re-run the capture
- [`engine-api.md`](engine-api.md) — the `warp.cxp.*` surface a custom script
  gets, with parameters and examples for each function

---

## Authentication

AWS Cognito, not cookies.

```
Authorization: Bearer <accessToken>
```

- The **access token**, not the `idToken` sitting beside it in the portal's
  localStorage. Both decode as valid JWTs, so sending the wrong one and
  sending an expired one produce the **same 401** — there is no way to tell
  them apart from the response alone.
- Lifetime is **about one hour**. A schedule firing at 09:00 will almost
  always find an expired token unless something renews it first.
- Cognito pool: `us-west-2_TitCKGc4I`, client `4uof8ju92ij2nfo92hkbhcfscn`,
  region `us-west-2`. Both `clientId` and `region` are recoverable from the
  access token's own claims (`client_id`, and `iss` for the region), so
  nothing has to be configured by hand once one token has been pasted.

### Diagnosing a 401 offline

```js
cx.tokenInfo()
// → { present, looksLikeAccessToken, tokenUse, username, clientId,
//     expiresAt, expired, minutesLeft }
```

Decodes the JWT payload without verifying it, purely to read `token_use` and
`exp`. This is what lets the UI say *which* of the two token mistakes happened
before making a request that would 401 either way.

### Renewing

Cognito's own endpoint, not the portal's:

```
POST https://cognito-idp.<region>.amazonaws.com/
content-type: application/x-amz-json-1.1
x-amz-target: AWSCognitoIdentityProviderService.InitiateAuth

{
  "AuthFlow": "REFRESH_TOKEN_AUTH",
  "ClientId": "<clientId>",
  "AuthParameters": { "REFRESH_TOKEN": "<refreshToken>" }
}
```

Response: `{ AuthenticationResult: { AccessToken, RefreshToken? } }`.

`RefreshToken` is present **only when the pool has rotation enabled** — a pool
without it returns nothing and the original stays valid. When rotation *is*
on and the new value is dropped, the old token keeps working through a grace
period and then stops, so the failure surfaces days later, far from the
change that caused it. `refresh()` therefore reports
`{ accessToken, refreshToken, expiresAt, rotated }` to its `onToken` callback,
and only writes the refresh token back to storage when `rotated` is true.

`ensureFresh()` renews automatically when under 5 minutes from expiry
(`REFRESH_MARGIN_MS`), and every `request()` call checks this before firing.

### Usage — auth (`tokenInfo` / `ensureFresh` / `refresh`)

| Function | Called from | For |
|---|---|---|
| `tokenInfo()` | `core/connectors/registry.js` (`test()`) | The green/red badge + expiry text on the Applications page's CX Portal card |
| | `components/CxPortalData.jsx` | The token-status line on the CX Portal Data tab |
| | `core/workflow/context.js` (`buildContext`) | Gate before building a customer digest — skips with a clear reason instead of a bare 401 if the token is dead and unrefreshable |
| | `scripts/cxportal-probe.mjs` | Printed at the top of every probe run, so a stale-token failure is obvious before 40 requests fail the same way |
| `ensureFresh()` | `core/connectors/cxportal-organize.js`, `core/connectors/cxportal-note.js`, `core/workflow/context.js`, `scripts/cxportal-probe.mjs` | Called once up front by every multi-request flow, so a mid-run expiry can't leave it half-finished |
| `refresh()` | `core/connectors/registry.js` (manual "renew" action), `app/api/refresh/route.js` | The Applications page's explicit "renew token" button; also called implicitly inside `request()`/`postAction()` whenever `needsRefresh` is true |

`request()` and `postAction()` both call `ensureFresh()`'s renewal logic inline
(`if (this.needsRefresh && this.refreshToken) await this.refresh()...`), so
nothing above has to remember to call it — the only place that matters is
where a *whole run's* freshness needs to be reported before work starts.

---

## The endpoint

Almost the entire API is one path, dispatched by an `action` query parameter:

```
GET https://saapi.aquera.com/ops/project-tracker?action=<name>&...params
```

One exception: `GET /ops/customersps` (see [below](#get-opscustomersps)).

Every successful response wraps in `{ success: true, ... }`. None return a
bare array. A 401/403 means the token was rejected or expired — decode it with
`tokenInfo()` to tell which. Any other non-2xx is reported as
`HTTP <status> from <path>?action=<name>`.

### Actions (16 observed, 15 confirmed working)

| Action | Response shape | Status |
|---|---|---|
| `list_projects` | `{ success, projects[], total, size, allTotal, nextCursor, statusCounts }` | ✅ |
| `stats` | `{ customers, projects, active, closed, blockedByEngineering, inProgress, phaseCounts, subprojects, onboardingForced, hours, meetings, tasks, hoursLeft, totalBudgeted }` | ✅ |
| `dashboard_aggs_v2` | 18+ keys: `recentTasks`, `upcomingTasks`, `weekSchedule`, `topCustomers`, `taskTypes`, `tcActivity`, `monthlyTrends`, `platformStats`, `projectTaskStats`, `projectStatus`, `connectorDist`, `integrationDist`, … | ✅ |
| `tc_analysis_aggs` | unknown | ⚠️ 504 on capture — likely expensive, not wrong |
| `planned_hours` | `{ weeks[] }` | ✅ |
| `list_project_customers` | `{ customers[] }` | ✅ |
| `customer_enriched` | `{ customers[], total, size }` | ✅ |
| `list_stations` | `{ stations[], total, _debug }` | ✅ |
| `get_stations_grid_summary` | `{ stations[], _generatedAt }` | ✅ |
| `list_tasks` | `{ tasks[], total, size, nextCursor }` — same pagination as `list_projects` | ✅ |
| `calendar_tasks` | unknown | ⚠️ 400 on capture — needs undiscovered params |
| `list_audit_logs` | `{ logs[], total, _debug }` | ✅ |
| `get_user_filters` | `{ filters[] }` | ✅ |
| `get_unread_notification_count` | `{ count }` | ✅ |
| `bulk_gong_counts` | `{ counts }` | ✅ |
| `bulk_outlook_next` | `{ next, last, stats }` | ✅ |
| `note_counts` | unknown | ⚠️ the only POST — body never captured |

### Usage — the 16 base actions

| Action / method | Called from | For |
|---|---|---|
| `list_projects` — `listProjects()`, `projectsForConsultant()` | `core/connectors/cxportal-organize.js`, `core/workflow/context.js`, `cxp.projects()`/`cxp.myProjects()` in the script engine, `app/api/cxportal/route.js` | the one action with real, wired-in callers — full breakdown in the "`list_projects` — the main one" section further down |
| `stats`, `list_tasks` (`.tasks()`), `list_stations` (`.stations()`) | `.action(name)` only, reachable from `app/api/cxportal/route.js` (the Data tab's `?action=` probe) and `cxp.action()` in the script engine | **not called from any built-in page or workflow today** — reachable generically, unused otherwise |
| `get_user_filters` (`savedFilters()`) | same — `.action()` only | unused; captured for completeness, never consumed |
| `get_unread_notification_count` (`unreadCount()`) | `core/connectors/registry.js` (`test()`) | the live call the Applications page's "Test connection" makes — cheapest real round trip that proves the token actually works, not just that it decodes |
| `dashboard_aggs_v2`, `planned_hours`, `list_project_customers`, `customer_enriched`, `get_stations_grid_summary`, `bulk_gong_counts`, `bulk_outlook_next` | `.action(name)` only | unused outside the raw probe — no dedicated method exists for these either, only the generic dispatcher |
| `tc_analysis_aggs`, `calendar_tasks` | — | unusable — still erroring on capture (see status column above) |
| `note_counts` (`noteCounts()`) | nothing — no caller anywhere | confirmed as a POST, not one of these GETs — see [§ The two write actions](#the-two-write-actions-observed-23-sep-2026) instead, never `.action()` |

Everything in this table beyond `list_projects` is reachable but not
integrated: nothing in Warp's UI or scheduled workflows currently reads
`stats`, `tasks`, `stations`, or `savedFilters` — they exist as confirmed,
working actions a future page could call, either through a new method on
`CxPortal` or directly via `.action(name)`/`cxp.action(name, params)` from a
custom script.

### Project-detail actions (11 more, added 23 Sep 2026)

Found walking one project's detail page end to end. Take the **internal**
`proj_…` id, not the `PS-####` display id — except `list_jira_issues`, the one
call keyed by display id + project name.

| Action | Method | Response |
|---|---|---|
| `task_aggs` | `taskAggs(projectId)` | `{ total, hours, meetings, customers, projects, consultants }` |
| `list_audit_logs` | `auditLogs(projectId, {from, size, entityType})` | `{ logs[], total, _debug }` — the Timeline tab |
| `list_audit_logs` + `entityType=station` | `stationAuditLogs(projectId, {size})` | Same shape, genuinely filtered — live-confirmed 101 rows → 23 when scoped to station-type entries (see below) |
| `list_tasks` + `projectId` | `tasksForProject(projectId, {...})` | `{ tasks[] }` — wider record than the unscoped call |
| `list_project_docs` | `projectDocs(projectId)` | `{ documents[], total, returned, truncated }` |
| `list_doc_folders` | `docFolders(projectId)` | `{ root, folders[], current }` |
| `list_notes` | `notes(projectId, {size, stationId})` | `{ notes[], total, from, size }` |
| `list_notes` + `stationId` | `stationNotes(projectId, stationId, {size})` | Same shape, scoped to one station's comments instead of the project's general notes |
| `list_jira_issues` | `jiraIssues(displayId, name, {size})` | `{ tasks[], total, size, nextCursor }` |
| `list_assignees` | `assignees({size})` | `{ assignees[], total, size, nextCursor }` |
| `list_mention_people` | `mentionPeople()` | `{ people[], total }` |
| `list_profile_avatars` | `profileAvatars()` | `{ byEmail, byId }` |

**Live-confirmed, 23 Sep 2026:** `stationAuditLogs()` genuinely narrows the
result rather than silently ignoring `entityType` — 101 total logs on a real
project dropped to 23 when scoped to `entityType: 'station'`, and every
returned row's own `entityType` field read back `'station'`. The unscoped
`list_audit_logs` response also carries `stationId`/`stationName` on rows
that have them, alongside `noteText`, `noteScope`, `changes`, `mentions` —
richer than the four keys (`{logs[], total, _debug}`) the shape alone
suggests; see `cxportal-schemas.md` for the full field list.

`projectDetail(projectId, {displayId, name, stationId})` fetches all of the
above — task hours, both audit logs, tasks, docs, folders, both notes sets,
connector images (below), and Jira — **in one call**, each caught
individually so one slow or broken panel never blanks the rest. `stationId`
is optional; when omitted, `stationNotes` comes back `null` rather than being
fetched — there's no project-wide "all stations' comments" equivalent the way
there is for audit logs.

`_debug` appears on some responses. Don't depend on it; it reads as internal.

### `GET /ops/connectors/image` — outside the `?action=` dispatcher

Connector logos (Gong, Jira, Salesforce, …), same as `/ops/customersps`: its
own path, not `?action=`. **Live-tested 23 Sep 2026 with no query params and
returned `HTTP 502`** — the endpoint exists but needs at least one parameter
nothing here has discovered yet (likely a connector name or id). `connectorImages(params)`
passes whatever `params` a caller gives it straight through, unvalidated.
Same status as `tc_analysis_aggs`/`calendar_tasks`: real, reachable, not yet
working. Included in `projectDetail()`'s parallel batch anyway — caught
individually like everything else there, so its current failure costs
nothing.

### Usage — the 11 project-detail methods

Every one of the eleven is reachable individually (each is a real method on
`CxPortal`, called internally by `projectDetail()` the same way a route
handler would call it directly), but in practice every actual caller in the
app goes through the `projectDetail()` aggregator rather than calling
`taskAggs()`, `auditLogs()`, `tasksForProject()`, `jiraIssues()`,
`docFolders()`, `projectDocs()`, `notes()`, `stationAuditLogs()`,
`stationNotes()`, `connectorImages()`, `assignees()`, or `profileAvatars()`
one at a time:

| Caller | How |
|---|---|
| `core/engine/api.js` (`cxp.projectDetail(projectId, opts)`) | The script engine's exposed surface — a custom script gets one project's full detail page, including station-scoped data, in one call |
| `app/engine/page.jsx` | Documents `cxp.projectDetail(id, opts)` in the Engine page's built-in API reference panel and full `warp.*` doc |

`mentionPeople()` and `assignees()` aren't reached even through
`projectDetail()` — they're global, portal-wide lists (not scoped to one
project), so pulling them per-project detail call would refetch the same
data on every project. Kept standalone for when a note-composer needs an
`@mention` list. Nothing has hit `taskAggs`, `tasksForProject`,
`docFolders`, `projectDocs`, `jiraIssues`, `profileAvatars`, `assignees`, or
`mentionPeople` live outside the original one-project capture walk — the
newer additions (`stationAuditLogs`, `notes`/`stationNotes`, `connectorImages`)
were live-verified individually above, read-only, in the course of adding
them.

---

### The two write actions (observed 23 Sep 2026)

**Both are POSTs against a live environment.** Nothing in Warp calls either
automatically; `add_note` is only ever triggered by a person clicking "Post
note" in Approvals, and `note_counts` has no caller at all — it exists as a
method because it was observed, not because anything needs it yet.

| Action | Method | Effect |
|---|---|---|
| `add_note` | `postAction('add_note', body)` / `addNote({projectId, text, shareToSlack})` | Appends a note to the project's Activity Timeline; optionally shares to Slack |
| `note_counts` | `postAction('note_counts', body)` / `noteCounts(body)` | Note-count badges (e.g. "3 notes" next to a project/station in a list) — this was the one action flagged "unknown, body never captured" in the original 16-action capture; the CX Portal API list confirms it's a POST but its request body is still a guess |

**Every write on this connector is treated the same way, without grading by
how low-stakes it looks.** `note_counts` reads like a harmless count lookup
that only uses POST because it needs a body — plausible, but unconfirmed, and
the instruction covering this connector's write path was unconditional: no
POST gets executed against the live API, full stop. `noteCounts()` exists,
compiles, and has never been called for real, same as `addNote()`.

Payload shape is **inferred from the observed API doc, not confirmed against
the live API** — Warp has deliberately never executed this call for real (see
`core/connectors/cxportal-note.js`). Believed shape:

```js
{ projectId: 'proj_…', text: '…', shareToSlack: false }
```

UX behavior observed in the CX Portal UI itself (the composer Warp's button
mirrors): Enter posts the note, Shift+Enter inserts a newline, and a "#"
button toggles share-to-Slack, which prompts a confirmation dialog before
sending since it is customer-visible. Warp's composer (in `app/approvals/page.jsx`)
uses an explicit checkbox instead of a "#" toggle, defaulting off, with no
Enter-to-post shortcut — a plain button click only, to keep the one live write
this app can make a deliberate, unambiguous action.

Before posting, Warp resolves the free-text customer name on the document to a
CX Portal project via `resolveProject()`, which reuses the same
confidence-graded matching as the transcript correlator (`core/correlate.js`)
and **refuses to post** unless the match is `strong` or `exact` — a `weak`
match raises instead of guessing which project to write to.

### Usage — `add_note` / `note_counts` / `postAction()`

| Function | Called from | For |
|---|---|---|
| `postAction(name, body)` | `addNote()`, `noteCounts()` — no other caller | The generic POST dispatcher, kept fully separate from `request()`/`action()` so nothing about the read path changes by this existing |
| `addNote({projectId, text, shareToSlack})` | `core/connectors/cxportal-note.js` (`postNoteForCustomer()`) | Turns a resolved project + note text into the actual write call |
| `resolveProject(customerName)` | `postNoteForCustomer()` | Customer-name → CX Portal project, `strong`/`exact` match only |
| `postNoteForCustomer(customerName, {text, shareToSlack})` | `app/api/cxportal/note/route.js` (`POST`) | The only route that can reach `addNote()` |
| `POST /api/cxportal/note` | `app/approvals/page.jsx` (`postNote()`, the "Post note" button's composer) | The one place a human can trigger this write — never from a schedule, a script, or automatically on approve |
| `noteCounts(body)` | nothing — no caller anywhere in the app | Exists because the action was observed; nothing needs count badges yet |

Every link in the `add_note` chain has been exercised **except the live
network call itself**: `resolveProject()` is verified against the real, live
token (read-only `listProjects` calls); `postNoteForCustomer()` is verified
only against a fully mocked `CxPortal` client with `addNote` stubbed out — the
real `postAction()` → `fetch()` has never executed for either write. The
script engine's `cxp` surface (`core/engine/api.js`) deliberately exposes
neither — there is no `cxp.addNote()` or `cxp.noteCounts()` — so `add_note`
is reachable from exactly one place in the whole app (the Approvals button),
and `note_counts` from nowhere at all yet.

---

## `list_projects` — the main one

```js
cx.listProjects({
  filters, logic = 'AND', sortField = 'lastUpdatedAt', sortOrder = 'desc',
  size = 200, cursor = null, myProjectsOnly = false, hideClosed = true,
})
```

```
{ success, projects[], total, size, allTotal, nextCursor, statusCounts }
```

- `total` is the count **after** filters; `allTotal` is before them — the
  difference is how a client can tell whether a filter actually narrowed
  anything (used to detect whether `myProjectsOnly` was honoured — see below).
- `statusCounts` is `{ active, completed, on_hold, cancelled }`. These are
  *status* values, distinct from the `phase_*` ids `implementationPhase` uses.
- `nextCursor` comes back as a **string**, even though the request takes the
  cursor as a JSON tuple. Echo it back verbatim; re-encoding it breaks paging.
- `myProjectsOnly: true` **is honoured by the server** — live-verified: 19 of
  1119 projects came back correctly scoped to one consultant. (Not
  everything on this API behaves this well — see [Gotchas](#gotchas).)

### The project record (40 fields observed)

| UI label | Field | Notes |
|---|---|---|
| Project Name | `name` | |
| Customer | `customerName` | the only cross-system join key — see below |
| Project ID | `projectId` | also `displayId` |
| IC | `consultantName` | confirmed filterable |
| IC Lead | `implementationLeadName` | |
| Solutions Architect | `solutionsArchitectName` | also `solutionsArchitectId` |
| Project Status | `implementationPhase` | confirmed filterable — `phase_*` ids |
| Connector Source | `connectorSource` | |
| Integration Type | `projectType` | |
| Budgeted Hours | `budgetedHours` | number |
| Meetings Held | `meetingsHeld` | number |
| Start / End Date | `startDate` / `endDate` | |
| Est. Go-Live | `targetDate` | |
| Go-Live Change Date / Reason | `targetDateChangeDate` / `targetDateChangeReason` | |
| Slip Owner | `targetDateChangeOwner` | |
| Tags | `tags[]` | |
| Parent Project | `parentProjectId` | also `parentName` |
| Station List Enabled | `stationListEnabled` | boolean |
| Created / Updated | `createdAt` / `updatedAt` / `updatedBy` | also `updatedByEmail` |

Also returned, not mapped to a UI label: `assignedTCs`, `businessAnalystId`,
`createdByEmail`, `epmId`, `phaseChangedAt`, `phaseHistory` (an array of phase
transitions — likely what "Days in Current Status" is computed from),
`seqNum`, `stationListActive/Skipped/Status/Total`, `status`, `subStatus`.

**`secondaryConsultantName` is filterable but never returned.** The
IC-or-secondary-IC query works, but a result never tells you which of the two
slots actually matched.

### Usage — `list_projects` / `listProjects()` / `projectsForConsultant()`

The most-called action in the API — every real caller reaches it through
`listProjects()` or `projectsForConsultant()`, never `.action('list_projects')`
directly:

| Caller | How | For |
|---|---|---|
| `core/connectors/cxportal-organize.js` | `listProjects({size:1})` as a control call, then `listProjects({myProjectsOnly:true})` (with `projectsForConsultant()` as a fallback if the flag isn't honoured), then paged `listProjects({cursor})` to walk every remaining project | The sync pipeline: fetch every CX Portal project scoped to the signed-in consultant, correlate each against Gong customer names, and write a per-customer context file |
| `core/workflow/context.js` | `listProjects({filters:[clause('customerName', ...)], ...})` | Scopes one customer's projects when building that customer's digest/context (`core/workflow/digest.js`) |
| `core/connectors/cxportal-note.js` (`resolveProject()`) | `listProjects({filters:[clause('customerName','contains',probe)], hideClosed:false, size:50})` | Resolves a free-text customer name to a real CX Portal project before the note-posting button in Approvals can post — **read-only**, never the write path |
| `core/engine/api.js` (`cxp.projects(opts)` / `cxp.myProjects(opts)`) | Thin pass-through to `listProjects()` / `listProjects({myProjectsOnly:true})` | The script engine's exposed surface for custom scripts |
| `app/api/cxportal/route.js` | `listProjects()` or `projectsForConsultant()` depending on `?mine=1` | The CX Portal Data tab's live reader/`?shape=1` probe |
| `scripts/cxportal-probe.mjs` | `listProjects({size:1})` per candidate filter attribute | The contradiction test that confirms or rules out each of the ~35 unconfirmed filter keys |

---

## Filtering

```js
clause(attribute, operator, value, value2 = '')
// → { attribute, operator, value, value2 }
```

```js
FILTER_OPERATORS = [
  'equals', 'notEquals', 'contains', 'isAnyOf', 'isNotAnyOf',
  'startsWith', 'endsWith', 'isEmpty',
]
```

Multi-select values join with a **literal `|||`** — `clause()` does this
automatically when given an array.

### Confirmed wire attribute names (4 of ~39 UI labels)

| Attribute | UI label |
|---|---|
| `consultantName` | IC |
| `secondaryConsultantName` | Secondary IC |
| `implementationPhase` | Project Status |
| `customerName` | Customer |

The other ~35 UI-labelled filters are **unconfirmed**, and this matters more
than it sounds: the API does not reject an unknown `attribute`, it silently
**ignores the clause and returns every row** — indistinguishable from a filter
that matched everything unless you specifically check for it. See
[Closing the gaps](#closing-the-remaining-gaps).

### `filterLogic` is global, not per-clause

There is no nesting. `customer = X AND (IC = Y OR secondary = Y)` cannot be
expressed in one request — you get one `AND`/`OR` for the whole clause list,
applied to every clause in it.

This is why the IC-or-secondary-IC query must be `OR`:

```js
cx.projectsForConsultant(name)
// → listProjects({
//     logic: 'OR',
//     hideClosed: false,   // an OR set + an exclusion clause matches everything
//     filters: [
//       clause('consultantName', 'equals', name),
//       clause('secondaryConsultantName', 'equals', name),
//     ],
//   })
```

With the default `AND` this returns **zero rows**, since almost nobody holds
both slots on one project at once.

### `HIDE_CLOSED`

The clause the Projects tab applies by default, to match on-screen counts:

```js
{
  attribute: 'implementationPhase', operator: 'isNotAnyOf',
  value: 'phase_1780114483755|||phase_1781519413237|||phase_1780652904894'
       + '|||phase_1780652917137|||phase_1780652926287',
  value2: '',
}
```

### No date-comparison operator

The operator list has no `before`/`after`/`between`. A workflow's date window
therefore cannot be sent to the server at all — Warp fetches unfiltered and
applies the window client-side against `updatedAt` (see
`core/workflow/window.js`, `withinWindow()`).

---

## `GET /ops/customersps`

The one endpoint outside the `action=` dispatcher. Customer directory,
genuinely paginated:

```
{ success, page, limit, timestamp, items[], totalPages, totalRecords, hasMore }
```

Read `totalPages` / `hasMore` — don't assume a fixed page count. ("Pages 1–6"
in an earlier draft of this reference was what the SPA happened to request on
one session, not a server-side bound.)

### Usage — `customers()` (the `/ops/customersps` wrapper)

`customers()` on `CxPortal` wraps this endpoint (six pages fetched in
parallel by default). Superseded by `listProjects()` for correlation work
early on, since a project record already carries `customerName` and going
through projects avoids a second round trip — so it still has **no caller in
Warp's own UI or workflows**. It is now reachable from a script, though:
`cxp.customers(opts)` on the script engine's `warp.cxp` surface
(`core/engine/api.js`) is a thin pass-through, added 23 Sep 2026 alongside
the project-detail additions above so every endpoint the CX Portal API list
named would be reachable from *somewhere* in the app, not left as truly dead
code. Still kept in mind for a future customer-directory view (contact info,
account-level fields) that a project list alone can't provide.

---

## Gotchas

- **Unknown filter attributes are ignored, not rejected.** A typo in an
  `attribute` name returns every row rather than an error. Confirming a new
  filter key requires the contradiction test in
  [`cxportal-probe.mjs`](#closing-the-remaining-gaps), not just "it didn't
  error."
- **`myProjectsOnly` is not guaranteed to be honoured** — it happened to work
  when last checked (19 of 1119, correctly scoped), but the general pattern
  with this API is that unrecognised parameters are silently dropped rather
  than rejected. Verify with the `total < allTotal` check before trusting it,
  the way `core/connectors/cxportal-organize.js` does:

  ```js
  const control = await cx.listProjects({ size: 1, hideClosed });
  const mine = await cx.listProjects({ size: 200, hideClosed, myProjectsOnly: true });
  const honoured = mine.projects.length && mine.total < control.allTotal;
  ```

- **`idToken` vs `accessToken` both 401 identically.** Always check
  `tokenInfo().tokenUse === 'access'` before assuming a credential is bad.
- **Gong and the tracker never agree on a customer name.** Gong groups calls
  by whatever was typed in the invite; the tracker holds the legal entity
  (`"Tech Systems Inc"` vs `"Tech Systems, Inc."`). There is no shared id.
  `core/correlate.js` does the match, graded `exact` / `strong` / `weak`, and
  only `exact`/`strong` are applied automatically.
- **Server-side matching is required at scale.** With 1100+ projects, fetching
  one page (`size: 200`) and matching in memory silently missed most
  customers — they simply weren't in that page. Filter with `customerName
  contains <longest distinctive word>` server-side, then confirm the full name
  client-side.

---

## Closing the remaining gaps

Run `npm run cx:probe` with a fresh access token (needed — the API's own
token lasts ~1 hour, so this can't be done once and forgotten):

- **Filters**: tests each of the ~35 unconfirmed attribute names by
  contradiction — filter for a real value from a sampled record, then for a
  value that cannot exist. If the two calls return different totals (and the
  nonsense one returns 0), the key is genuinely filterable. If both return
  `allTotal`, the server ignored it.
- **Actions**: retries `calendar_tasks` and `tc_analysis_aggs` against
  candidate parameter sets until one stops erroring, and records what worked.
  `note_counts` is deliberately excluded — it's confirmed as a POST, and this
  probe is read-only throughout; closing that gap means capturing a real
  request some other way, not calling it.
- **Depth**: re-walks every successful action's response at depth 5 instead
  of 3, to fill in element shapes inside `tasks[]`, `stations[]`, `logs[]`,
  `customers[]` that were only captured one level deep.

It is read-only throughout, and prints structure/counts/key names — never
record contents — so its output is safe to paste into a ticket.

The Data tab of the CX Portal application in the app exposes the same probe
as a **Shape** mode, one action at a time, if a full script run isn't wanted.

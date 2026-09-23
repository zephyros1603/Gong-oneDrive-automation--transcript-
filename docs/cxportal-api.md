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

### Project-detail actions (9 more, added 23 Sep 2026)

Found walking one project's detail page end to end. Take the **internal**
`proj_…` id, not the `PS-####` display id — except `list_jira_issues`, the one
call keyed by display id + project name. All nine confirmed live.

| Action | Method | Response |
|---|---|---|
| `task_aggs` | `taskAggs(projectId)` | `{ total, hours, meetings, customers, projects, consultants }` |
| `list_audit_logs` | `auditLogs(projectId, {from, size})` | `{ logs[] }` — the Timeline tab |
| `list_tasks` + `projectId` | `tasksForProject(projectId, {...})` | `{ tasks[] }` — wider record than the unscoped call |
| `list_project_docs` | `projectDocs(projectId)` | `{ documents[], total, returned, truncated }` |
| `list_doc_folders` | `docFolders(projectId)` | `{ root, folders[], current }` |
| `list_notes` | `notes(projectId, {size})` | `{ notes[], total, from, size }` |
| `list_jira_issues` | `jiraIssues(displayId, name, {size})` | `{ tasks[], total, size, nextCursor }` |
| `list_assignees` | `assignees({size})` | `{ assignees[], total, size, nextCursor }` |
| `list_mention_people` | `mentionPeople()` | `{ people[], total }` |
| `list_profile_avatars` | `profileAvatars()` | `{ byEmail, byId }` |

`projectDetail(projectId, {displayId, name})` fetches the first six in
parallel with each call caught individually, so one slow panel never blanks
the others. Full field lists: `cxportal-schemas.md`.

`_debug` appears on two responses. Don't depend on it; it reads as internal.

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
- **Actions**: retries `calendar_tasks`, `tc_analysis_aggs`, and `note_counts`
  against candidate parameter sets until one stops erroring, and records
  what worked.
- **Depth**: re-walks every successful action's response at depth 5 instead
  of 3, to fill in element shapes inside `tasks[]`, `stations[]`, `logs[]`,
  `customers[]` that were only captured one level deep.

It is read-only throughout, and prints structure/counts/key names — never
record contents — so its output is safe to paste into a ticket.

The Data tab of the CX Portal application in the app exposes the same probe
as a **Shape** mode, one action at a time, if a full script run isn't wanted.

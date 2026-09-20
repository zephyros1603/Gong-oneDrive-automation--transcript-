# CX Portal — response schemas

Captured live on 17 September 2026 against `https://saapi.aquera.com` with a
valid Cognito access token, by calling every action in `ACTIONS` and recording
the structure of what came back. Raw output: `docs/cxportal-shapes.json`.

This closes gap 1 of the original API reference, which documented requests only.

## What answered

**15 of 17 actions returned data.** Two did not:

| Action | Result |
|---|---|
| `calendar_tasks` | `HTTP 400` — needs parameters that were not captured |
| `tc_analysis_aggs` | `HTTP 504` — gateway timeout, likely expensive rather than wrong |

Every successful response is an object with `success: true` at the top level.
None of them return a bare array.

## `list_projects`

```
{ success, projects[], total, size, allTotal, nextCursor, statusCounts }
```

- `nextCursor` is a **string** here, though the request takes the cursor as a
  JSON tuple. Echo it back verbatim rather than re-encoding it.
- `statusCounts` is `{ active, completed, on_hold, cancelled }` — note these
  are *status* values, distinct from the `phase_*` ids used by the
  `implementationPhase` filter.
- `total` is the count after filters; `allTotal` is before them.

### A project record — 40 fields

The original reference listed 39 UI filter labels with only 3 wire keys
confirmed. These are the fields the API actually returns, matched to their
labels where the mapping is unambiguous:

| UI label | Field | Type |
|---|---|---|
| Project Name | `name` | string |
| Customer | `customerName` | string |
| Project ID | `projectId` | string |
| IC | `consultantName` | confirmed on the wire |
| IC Lead | `implementationLeadName` | string |
| Solutions Architect | `solutionsArchitectName` | string (also solutionsArchitectId) |
| Project Status | `implementationPhase` | confirmed — phase_* ids |
| Connector Source | `connectorSource` | string |
| Integration Type | `projectType` | string |
| Budgeted Hours | `budgetedHours` | number |
| Meetings Held | `meetingsHeld` | number |
| Start Date | `startDate` | string |
| End Date | `endDate` | string |
| Estimated Go Live Date | `targetDate` | string |
| Go Live Change Date | `targetDateChangeDate` | string |
| Go Live Change Reason | `targetDateChangeReason` | string |
| Slip Owner | `targetDateChangeOwner` | string |
| Tags | `tags` | array |
| Parent Project | `parentProjectId` | string (also parentName) |
| Station List Enabled | `stationListEnabled` | boolean |
| Created Date | `createdAt` | string |
| Updated Date | `updatedAt` | string |
| Updated By | `updatedBy` | string (also updatedByEmail) |

Also returned, not obviously mapped to a filter label: `assignedTCs`, `businessAnalystId`, `createdByEmail`, `displayId`, `epmId`, `parentName`, `phaseChangedAt`, `phaseHistory`, `seqNum`, `solutionsArchitectId`, `stationListActive`, `stationListSkipped`, `stationListStatus`, `stationListTotal`, `status`, `subStatus`, `updatedByEmail`.

**`secondaryConsultantName` is filterable but never returned.** The
IC-or-secondary-IC query in the original reference works, but you cannot tell
from a result which of the two matched.

`phaseHistory` is an array — the phase transitions per project, which is what
"Days in Current Status" is presumably computed from.

## Other actions

| Action | Response |
|---|---|
| `stats` | `{ customers, projects, active, closed, blockedByEngineering, inProgress, phaseCounts, subprojects, onboardingForced, hours, meetings, tasks, hoursLeft, totalBudgeted }` |
| `list_tasks` | `{ tasks[], total, size, nextCursor }` — same pagination shape as projects |
| `list_project_customers` | `{ customers[] }` |
| `customer_enriched` | `{ customers[], total, size }` |
| `list_stations` | `{ stations[], total, _debug }` |
| `get_stations_grid_summary` | `{ stations[], _generatedAt }` |
| `list_audit_logs` | `{ logs[], total, _debug }` |
| `planned_hours` | `{ weeks[] }` |
| `get_user_filters` | `{ filters[] }` |
| `get_unread_notification_count` | `{ count }` |
| `bulk_gong_counts` | `{ counts }` |
| `bulk_outlook_next` | `{ next, last, stats }` |
| `dashboard_aggs_v2` | 18+ keys — `recentTasks`, `upcomingTasks`, `weekSchedule`, `topCustomers`, `taskTypes`, `tcActivity`, `monthlyTrends`, `platformStats`, `projectTaskStats`, `projectStatus`, `connectorDist`, `integrationDist`, … |

`_debug` appears on two responses. Worth not depending on it.

## `GET /ops/customersps`

```
{ success, page, limit, timestamp, items[], totalPages, totalRecords, hasMore }
```

Genuinely paginated, with `hasMore` and `totalPages` — so the "pages 1 to 6"
in the original reference is what the SPA happens to request, not a fixed
bound. Read `totalPages` instead of assuming six.

## Still open

- `calendar_tasks` parameters — returns 400 without them.
- `tc_analysis_aggs` — timed out; retry when the portal is quiet.
- `note_counts` — the only POST, body never captured.
- Element shapes inside `tasks[]`, `stations[]`, `logs[]`, `customers[]` were
  recorded one level deep only; re-run the probe with a deeper `shapeOf` if
  those matter.
- No write endpoints were touched.

## Refresh-token rotation

`refresh()` now persists a rotated refresh token as well as the access token.

Cognito's `REFRESH_TOKEN_AUTH` returns a `RefreshToken` in
`AuthenticationResult` **only when the pool has rotation enabled**; without it
the field is absent and the original stays valid. When rotation is on and the
new value is dropped, the old token keeps working through a grace period and
then stops — so the failure surfaces days later, as a schedule that quietly
stopped running, far from the change that caused it.

`onToken` therefore receives `{ accessToken, refreshToken, expiresAt, rotated }`
and `core/connectors/cx-client.js` writes `CXPORTAL_REFRESH_TOKEN` back to
gong.env only when `rotated` is true. Verified against a stubbed Cognito for
all three cases: no rotation, rotation, and the same token echoed back (which
is not a rotation and must not be recorded as one).

## Closing the remaining gaps

`npm run cx:probe` settles what is still open here. It needs a fresh access
token and takes a few minutes.

**Filter keys.** The reference lists 39 UI labels and confirms 3 wire keys; the
rest were inferred from response fields. Inference is not enough, because the
API does not reject an unknown `attribute` — it ignores the clause and returns
every row, which is indistinguishable from a filter that matched everything.

The probe tests each candidate by contradiction: filter for a value taken from
a real record, then for a value nothing can hold.

| Outcome | Meaning |
|---|---|
| `equals` → n, nonsense → 0 | the server understood the clause — **filterable** |
| both → `allTotal` | the clause was ignored — **not a filter key** |
| anything else | reported as unclear rather than guessed at |

**Action parameters.** `calendar_tasks`, `tc_analysis_aggs` and `note_counts`
are retried against candidate parameter sets until one stops returning 400, and
the set that worked is recorded. Successful actions are re-walked at depth 5,
which fills in the element shapes inside `tasks[]`, `stations[]`, `logs[]` and
`customers[]` that were previously captured one level deep.

The probe reads only. It prints structure, counts and key names — never
records — so its output is safe to paste into a ticket.

## Reproducing this

The Data tab of the CX Portal application has a **Shape** mode that does
exactly this for one action at a time, reporting structure without printing
records. `core/connectors/cxportal.js` exports `shapeOf()` if you want it in a
script.

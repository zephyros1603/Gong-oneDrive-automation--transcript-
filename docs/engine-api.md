# The script engine — `warp.*` API reference

**What this is:** everything a custom script written in the Engine page
(`/engine`) can call, one namespace at a time — parameters, what it actually
hits underneath, its return shape, and a runnable example for each function.

**Source of truth:** `core/engine/api.js` (the object itself) and
`core/engine/sandbox.js` (how it's run). This document explains them; if the
two disagree, the code is right and this file is stale.

**Related:**
- [`cxportal-api.md`](cxportal-api.md) — full detail on everything `warp.cxp`
  reaches
- `app/engine/page.jsx` — the editor UI; its built-in reference panel is the
  short version of this document

---

## How a script runs

A script is the body of an async function — `return` and `await` both work
without any wrapping boilerplate:

```js
const projects = warp.projects.list();
return projects.length;
```

`runScript(code)` (`core/engine/sandbox.js`) wraps that body as
`(async () => { <code> })()` and runs it inside a Node `vm` context built
fresh for the run. That context contains **only**:

- `warp` — the object this document describes
- `console.log/warn/error` — routed into the script's own run log, not the
  server's stdout
- `setTimeout` / `clearTimeout` — for rate-limiting a loop over customers
- `Promise`, `JSON`, `Math`, `Date`, `Array`, `Object`, `String`, `Number`,
  `Boolean`, `Map`, `Set` — ordinary JS, nothing that touches the filesystem
  or network directly

There is no `require`, `fetch`, `process`, or real `globalThis`. A script
cannot read an env var, open a file outside `warp.gong.read()`'s library
check, or make an HTTP request except through `warp.cxp`/`warp.claude`. This
is **not a hard security boundary** — `vm` doesn't claim to be one — it exists
so an *accidental* mistake (`require('fs')`, reading a credential out of
`process.env`) fails loudly instead of silently working. `warp` itself is the
real boundary: a script can only do what a function on this object lets it
do, and every one of those functions is something a route handler already
does safely on its own.

**Timeouts:** 60 seconds by default (`DEFAULT_TIMEOUT_MS`), enforced twice —
once by `vm`'s own synchronous `timeout` option (stops a hung `while(true){}`
loop, which nothing else can interrupt since Node is single-threaded) and
once by a `Promise.race` around the whole run (catches an `await` that never
resolves, which the synchronous timeout can't see once control has returned
to the event loop).

**Every call is logged.** `onEvent({type:'call', path, args})` fires for
every `warp.*` call, with each argument truncated to 120 characters — long
enough to recognise, short enough that a CX Portal or Gong response full of
customer data never lands in a log file. A script's run log is a trace of
exactly what it called, in order, not a black box.

---

## `warp.gong` — the transcript library

```js
warp.gong.transcripts()
warp.gong.read(path)
await warp.gong.pull(opts)
```

| Function | Parameters | Hits | Returns |
|---|---|---|---|
| `transcripts()` | none | `library.listFiles()` — reads the on-disk library index, no network call | `[{ path, name, mtime, group }]`, newest first, filtered to `kind === 'input'` |
| `read(path)` | `path` — must be a path `library.isReadable()` recognises as inside the library | Local file read (`readFileSync`) | The transcript's raw text |
| `pull(opts)` | `opts.mode` — `'me'` (default) \| `'account'` \| `'call'`; `opts.days` or `opts.from`/`opts.to`; `opts.format`; `opts.accountName`/`opts.callIds` for the other two modes; `opts.dryRun` | `core/gong/pull.js`'s `pullTranscripts()` — the same primitive `POST /api/run` and the scheduler use, a real Gong pull, not a read | `{ ok, skipped, failed, outDir, calls[] }` |

`read()` throws `'not a readable path'` for anything outside the library —
this is how a script is kept from reading an arbitrary file even though
`readFileSync` is available to `core/engine/api.js` itself. `pull()`'s
progress streams into the script's own run log as `log` lines
(`[gong] <stage>`), not the `call`-shaped trace every other function here
uses — there's no single return value to summarise mid-pull.

**Example — pull the last 2 days, then read what came in:**

```js
await warp.gong.pull({ mode: 'me', days: 2 });
const recent = warp.gong.transcripts().slice(0, 5);
return recent.map((f) => f.name);
```

**Example — read every transcript newer than 7 days:**

```js
const cutoff = Date.now() - 7 * 86400e3;
const recent = warp.gong.transcripts().filter((f) => f.mtime > cutoff);
const texts = recent.map((f) => ({ name: f.name, text: warp.gong.read(f.path) }));
return { count: texts.length, names: texts.map((t) => t.name) };
```

---

## `warp.cxp` — the CX Portal, raw

```js
await warp.cxp.projects(opts)
await warp.cxp.myProjects(opts)
await warp.cxp.projectDetail(projectId, opts)
await warp.cxp.customers(opts)
await warp.cxp.action(name, params)
await warp.cxp.proposeNote({ customerName, text, shareToSlack })
```

All six are thin wrappers over the same `CxPortal` client every other part
of Warp uses (`cxClient()`), authenticated with whatever token is currently
stored in Credentials — a script does not supply its own.

| Function | Parameters | Hits | Returns |
|---|---|---|---|
| `projects(opts)` | `opts` — same shape as `listProjects()`'s options: `{ filters, logic, sortField, sortOrder, size, cursor, myProjectsOnly, hideClosed }`, all optional | `GET /ops/project-tracker?action=list_projects` | `{ projects[], total, size, allTotal, nextCursor, statusCounts }` — full field list in [`cxportal-api.md`](cxportal-api.md#the-project-record-40-fields-observed) |
| `myProjects(opts)` | same as `projects()`, `myProjectsOnly` forced to `true` | same endpoint | same shape, scoped to the signed-in consultant |
| `projectDetail(projectId, opts)` | `projectId` — the internal `proj_…` id, not `PS-####`; `opts.displayId`/`opts.name` — optional, needed only to also fetch linked Jira issues; `opts.stationId` — optional, needed only to also fetch that one station's comments | **One call, ten actions in parallel**: `task_aggs`, `list_audit_logs` (project-wide), `list_audit_logs` scoped `entityType=station`, `list_tasks`, `list_project_docs`, `list_doc_folders`, `list_notes` (project-wide), `list_notes` scoped to `stationId` if given, `GET /ops/connectors/image`, plus `list_jira_issues` if `displayId` is given | `{ taskAggs, audit, stationAudit, tasks, docs, folders, notes, stationNotes, images, jira }` — each key individually `.catch()`-guarded, so one slow/broken panel doesn't blank the rest; `stationNotes` is `null` when no `stationId` was given |
| `customers(opts)` | `opts.pages` — how many directory pages to fetch in parallel, default `6` | `GET /ops/customersps` — outside the `?action=` dispatcher, its own path | An array of page responses, each `{ success, page, limit, items[], totalPages, totalRecords, hasMore }` |
| `action(name, params)` | `name` — any value from `ACTIONS` in `cxportal.js` (`stats`, `dashboard_aggs_v2`, `list_tasks`, `list_stations`, …); `params` — raw query params for that action | `GET /ops/project-tracker?action=<name>` | Whatever that action returns — unmapped, exactly as the API sent it |
| `proposeNote({customerName, text, shareToSlack})` | `customerName` — resolved to a CX Portal project the same way `resolveProject()` always has, `strong`/`exact` match only; `text`; `shareToSlack` — optional, default `false` | Resolves the customer (read-only `list_projects`) then `approvals.propose({kind:'cxp_note', ...})` — **never `add_note`** | The created `pending` approval row |

`projectDetail()` is the one to reach for over calling several of the above
by hand — it exists specifically so a script (or a route) doesn't have to
make nine or ten separate round trips to build one project's picture; add a
`stationId` and the eleventh (that station's comments) joins the same batch.

`images` is live-confirmed to currently come back `{error: 'HTTP 502 …'}` —
`GET /ops/connectors/image` needs a parameter nothing has discovered yet (see
[`cxportal-api.md`](cxportal-api.md#get-opsconnectorsimage--outside-the-action-dispatcher)).
Caught the same as every other key here, so it costs nothing while broken —
worth knowing before debugging why a script's `detail.images` is always an
error object.

**There is still no `warp.cxp.addNote()`, `warp.cxp.noteCounts()`, or any
function that actually writes.** `proposeNote()` is the one write-*adjacent*
capability a script has, and it never writes itself — it only ever creates a
`pending` approval. The real POST (`add_note`, via `postNoteForCustomer()`)
happens in exactly one place in the whole app: `core/approvals/store.js`'s
`decide()`, on a human's approve click in the Approvals page's always-visible
CX Portal notes section (see
[`cxportal-api.md` § The two write actions](cxportal-api.md#the-two-write-actions-observed-23-sep-2026)).
`note_counts` has no caller anywhere at all. A script that wants to reach a
write action through `action(name, params)` can't either way — that path
calls `cx.action()`, which is GET-only (`request()`), never
`cx.postAction()`.

**Example — propose a note (never posts):**

```js
const approval = await warp.cxp.proposeNote({
  customerName: 'Acme Onboarding',
  text: 'Go-live moved to next Friday pending the RADIUS fix — see call notes.',
  shareToSlack: false,
});
return approval.id;   // shows up in Approvals; nothing sent until a human approves it
```

**Example — every open project for one consultant:**

```js
const { projects } = await warp.cxp.myProjects({ size: 200 });
return projects.map((p) => ({ name: p.name, customer: p.customerName, phase: p.implementationPhase }));
```

**Example — pull one project's full detail page, including one station's comments:**

```js
const detail = await warp.cxp.projectDetail('proj_abc123', {
  displayId: 'PS-4821', name: 'Acme Onboarding', stationId: 'stn_9f2c',
});
return {
  hours: detail.taskAggs,
  openTasks: detail.tasks?.tasks?.length ?? 0,
  stationHistory: detail.stationAudit?.logs?.length ?? 0,
  stationComments: detail.stationNotes?.notes?.length ?? 0,
};
```

**Example — the customer directory, outside the project-tracker dispatcher:**

```js
const pages = await warp.cxp.customers({ pages: 2 });
return pages.flatMap((p) => p.items).map((c) => c.name);
```

**Example — an action with no dedicated wrapper:**

```js
return warp.cxp.action('stats');
// → { customers, projects, active, closed, blockedByEngineering, ... }
```

---

## `warp.correlate` — matching Gong customers to CX Portal customers

```js
warp.correlate.customers(gongNames, cxNames, opts)
warp.correlate.compare(a, b)
warp.correlate.normalise(name)
```

| Function | Parameters | Hits | Returns |
|---|---|---|---|
| `customers(gongNames, cxNames, opts)` | `gongNames`/`cxNames` — plain string arrays; `opts.minimum` — lowest confidence to count as matched, `'exact'` \| `'strong'` \| `'weak'`, default `'strong'` | Pure in-memory matching, no network call — `core/correlate.js`'s `correlate()` | `{ matched[], review[], gongOnly[], cxOnly[], summary }` — `matched` is `{gong, cxportal, confidence, score}[]`; `review` holds matches below the confidence floor instead of discarding them |
| `compare(a, b)` | two plain name strings | word-sequence containment + shared-word overlap, no network call | `{ confidence: 'exact'\|'strong'\|'weak', score }` or `null` if nothing matches |
| `normalise(name)` | one string | lowercasing/punctuation-stripping only | the normalised string |

This is the exact function the transcript↔tracker sync
(`core/connectors/cxportal-organize.js`) and the note-posting resolver
(`core/connectors/cxportal-note.js`) both use — a script gets the same
matching logic, not a simplified version of it.

**Example — find customers with calls but no tracker project:**

```js
const gongNames = warp.projects.list().map((p) => p.customer);
const { projects } = await warp.cxp.myProjects({ size: 200 });
const cxNames = projects.map((p) => p.customerName);
const result = warp.correlate.customers(gongNames, cxNames);
return result.gongOnly;   // customers with calls, no tracker project — unbilled work
```

---

## `warp.context` — the one context file a project has

```js
warp.context.read(projectId)
warp.context.write(projectId, text)
await warp.context.update(projectId, opts)
warp.context.status()
```

Superseded a separate "digest" concept that did an overlapping job (a
compact stand-in for raw material) — one project now has exactly one curated
`context.md`, in a fixed format (`gong data :` / `existing CXP Data :` /
`last updated Date :`), not two competing files.

| Function | Parameters | Hits | Returns |
|---|---|---|---|
| `read(projectId)` | `projectId` — a **Warp** project id | A local file read of that project's `context.md` | The current text, or `null` before the first update run |
| `write(projectId, text)` | `projectId`; `text` — replaces the file outright | Writes directly to the project's fixed context path — a script's own call, bypassing the Claude-curated rewrite | `{ path }` |
| `update(projectId, opts)` | `projectId`; `opts.force` — rebuild even if nothing changed, default `false`; `opts.window` — how far back to look for Gong transcripts, default the last 7 days | Fetches fresh `cxp.projectDetail()` data, reads whatever Gong transcripts are already pulled+organized for that customer in the window, and — content-hash-gated, so nothing-changed skips this — runs one `silent` Claude call to rewrite `context.md` | `{ path, cached, rebuiltFrom }` |
| `status()` | none | Local file stats only, no Claude call, no CX Portal call | one row per project: `{ id, name, linked, exists, bytes, tokensEstimate, path, updatedAt }` |

`update()` does **not** pull Gong itself — it reads what the normal
scheduled sync (or a script's own `warp.gong.pull()` call beforehand)
already put on disk. Real numbers from the first live run: 2 Gong
transcripts + one `projectDetail()` snapshot → a dense, fact-only rewrite
(staffing gaps, a full target-date slip history, named blockers and owners)
in one Claude call; a second `update()` immediately after came back
`{cached: true}` since nothing had changed.

`update()` is `silent: true` under the hood — it does not appear in the
project's chat history, does not touch its active session, and does not
create an approval. `write()` has no such run at all; it's a plain file
write, confined to the one fixed path a project's context always lives at —
a script chooses the text, never the destination.

**Example — update every linked project, then report what actually changed:**

```js
const results = [];
for (const p of warp.projects.list()) {
  if (!p.cxpProjectId) continue;
  const r = await warp.context.update(p.id);
  if (!r.cached) results.push({ project: p.name, path: r.path });
}
return results;
```

---

## `warp.excel` — build a real `.xlsx`, added 23 Sep 2026

```js
const wb = new warp.excel.Workbook()
const saved = await warp.excel.save(wb, name, opts)
```

`exceljs` — the actual npm package, added specifically for this — exposed
two ways: the raw `Workbook` constructor for building, and one sanctioned
method for persisting.

| Function | Parameters | Hits | Returns |
|---|---|---|---|
| `Workbook` | none — it's the class itself, `new warp.excel.Workbook()` | Nothing on its own; builds an in-memory workbook via exceljs's normal API (`addWorksheet()`, `addRow()`, cell styling, etc. — see [exceljs's own docs](https://github.com/exceljs/exceljs)) | A `Workbook` instance |
| `save(workbook, name, opts)` | `workbook` — the instance you built; `name` — becomes the filename (slugged, `.xlsx` appended); `opts.folder` — optional subfolder, also slugged | `workbook.xlsx.writeBuffer()` (exceljs's own in-memory serialiser, no disk access) then this module's own `writeFileSync` into `cfg.docsDir` | `{ path, name, folder }` — `path` is what `warp.approvals.propose({path})` expects |

**This one is not fully sandboxed, and the doc says so on purpose.** Every
other `warp.*` function is a thin, traced wrapper around one specific host
call. `Workbook` can't be wrapped that way without reimplementing exceljs's
entire API surface, so it's handed to the script directly — which means
`workbook.xlsx.writeFile(path)`, exceljs's own real method with its own real
`fs` access, still works if a script calls it, and writes wherever `path`
says. That's the same class of hole `require('fs')` would be, just reached
through a library instead of directly — this sandbox was never a hard
security boundary (see [How a script runs](#how-a-script-runs)), and this is
the sharpest edge of that fact currently in `warp`. **Use `excel.save()`,
not `workbook.xlsx.writeFile()`** — `save()` never lets a script choose the
destination path, only a name, the same constraint `library.js`'s
`saveDocument()` already applies to generated markdown.

**Example — the whole flow, build → save → propose:**

```js
const wb = new warp.excel.Workbook();
const ws = wb.addWorksheet('Status');
ws.addRow(['Customer', 'Phase', 'Go-live']);

for (const p of warp.projects.list()) {
  ws.addRow([p.name, p.customer, '']);
}

const saved = await warp.excel.save(wb, `weekly-status-${Date.now()}`);
return warp.approvals.propose({ title: 'Weekly status (all customers)', path: saved.path });
```

---

## `warp.projects` — Warp's own project list

```js
warp.projects.list()
warp.projects.get(id)
await warp.projects.syncFromCxp(opts)
```

Warp's local `projects` table — the same list the Projects page shows. One
row per **CX Portal project** assigned to me, 1:1 — not per customer; a
customer with two CX Portal projects has two Warp projects. This is the only
thing that creates a row here now; a Gong call for a customer with no
matching CX Portal project doesn't.

| Function | Parameters | Hits | Returns |
|---|---|---|---|
| `list()` | none | `projects.js`'s local SQLite table | `[{ id, name, customer, cxpProjectId, cxpDisplayId, transcriptCount, hasContext }]` |
| `get(id)` | Warp project id | same table, one row, plus the full `context` object | the full project record, or `undefined` |
| `syncFromCxp(opts)` | `opts` — forwarded to `fetchMine()` (`onEvent`, `dryRun`) | **The creation run.** Fetches every CX Portal project assigned to me and creates a Warp project (with a cheap stub `context.md`, no Claude call) for any that doesn't have one yet | `{ fetched, created:[{id,name,cxpProjectId}], existing:[...] }` |

`syncFromCxp()` is idempotent — a project already linked by `cxpProjectId`
is reported under `existing`, never duplicated. It only creates; making the
context file real is `warp.context.update(id)`'s job, per project, on
whatever schedule that project needs.

**Example — bring in new CX Portal projects, then update each one's context:**

```js
const synced = await warp.projects.syncFromCxp();
for (const p of synced.created) {
  await warp.context.update(p.id);
}
return synced;
```

---

## `warp.claude` — one Claude call, scoped to specific files

```js
await warp.claude.run({ instruction, files, skill, label })
```

| Parameter | Required | Notes |
|---|---|---|
| `instruction` | yes | The prompt text |
| `files` | no, default `[]` | Paths handed to Claude via `--add-dir`, same mechanism every other run uses |
| `skill` | no | An installed skill name — omit for a plain prompt |
| `label` | no, default `'Script run'` | Shown in the run history, if the run is ever inspected there |

Hits `startChatRun()` (`core/chat.js`) with `silent: true, resetSession: true`
forced — a script's call is never a chat turn for any project and never
disturbs whatever conversation is actually in progress in that project's
chat. It then subscribes to the run (`runsStore.subscribe`) and resolves with
the plain reply text once the run finishes, or rejects if it ends any other
way than `done`.

**Returns:** a `Promise<string>` — the model's reply text, nothing else. No
run id, no cost, no document list; a script that needs those has to read them
back some other way (they're not exposed here on purpose — this call is meant
for "get an answer," not "run a workflow").

**Example:**

```js
await warp.context.update(project.id);
const reply = await warp.claude.run({
  instruction: 'In two sentences, is this account at risk? Say why.',
  files: [warp.projects.get(project.id).context.path],
  label: 'Risk check',
});
return reply;
```

---

## `warp.approvals` — proposing something for a person to review

```js
warp.approvals.propose({ title, path, body, kind, projectId })
warp.approvals.pending()
```

| Function | Parameters | Hits | Returns |
|---|---|---|---|
| `propose({...})` | `title` (shown in the queue); exactly one of `path` (a file already on disk) or `body` (inline text/markdown, e.g. an email draft); `kind` — defaults to `'document'` if `path` is set, else `'email'`; `projectId` — optional Warp project id to associate it with | Inserts one row into the `approvals` table (`core/approvals/store.js`) | The created approval row, `status: 'pending'` |
| `pending()` | none | reads the same table, `status = 'pending'` | `[{ id, title, kind, path, body, status, project, ... }]`, newest first |

**A script never delivers directly — this is the only way a script's output
reaches the outside world**, and it always lands in the review queue first,
same as every scheduled workflow. There is no `approve()`/`decide()` on this
object; only a person, from the Approvals page, can move a row out of
`pending`.

**Example — propose a file a script just wrote:**

```js
// (writing the file itself is out of scope for a script — this assumes
// something upstream, like warp.claude.run, already produced it)
return warp.approvals.propose({
  title: `Weekly status — ${project.name}`,
  path: outputPath,
  projectId: project.id,
});
```

---

## `warp.notify` — put something in the bell right now

```js
warp.notify.say(title, body)
```

| Parameter | Notes |
|---|---|
| `title` | required |
| `body` | optional, default `''` |

Hits `notify()` (`core/notify.js`) with `kind: 'schedule_started'`, which
persists the notification and fans it out over the live `EventSource` the
bell icon subscribes to (`core/notify.js` → `AppShell.jsx`) — the same path a
scheduled run's "started"/"done" pair uses, just triggered by hand instead of
by `notifyScheduledRun()`.

**Example:**

```js
warp.notify.say('Context update finished', `Rebuilt ${count} project context files.`);
```

---

## `warp.window` — turning a date-range setting into real dates

```js
warp.window.resolve(windowSpec)
```

A direct, unwrapped reference to `resolveWindow()` (`core/workflow/window.js`)
— the same function every scheduled workflow uses to turn "this week" into
concrete `from`/`to` timestamps, so a script's idea of "last 7 days" matches
what a workflow would have used.

| Parameter | Shape | Notes |
|---|---|---|
| `windowSpec` | a legacy string (`'last7d'`, `'all'`, …), `'week'`/`'day'`/`'month'`, or `{ preset, anchor, days, from, to }` | An explicit `{from, to}` pair wins over everything else; `anchor: 'previous'` means the last *complete* period, not the one still in progress |

**Returns:** `{ preset, anchor, from, to, days, label, fromDay, toDay, custom }`
— `from`/`to` are epoch ms, `to` exclusive.

**Example:**

```js
const w = warp.window.resolve({ preset: 'week', anchor: 'previous' });
const transcripts = warp.gong.transcripts().filter((f) => f.mtime >= w.from && f.mtime < w.to);
return { label: w.label, count: transcripts.length };
```

---

## Everything not listed here

If a capability isn't on `warp`, a script can't reach it — there is no escape
hatch. The rule for adding one (`core/engine/api.js`'s own header comment):
**could a route handler already do this safely on its own?** If yes, it's a
few lines to add. If no — especially anything that writes to a live external
system, like CX Portal's `add_note` — it stays out, on purpose, and gets a
dedicated, human-only button instead.

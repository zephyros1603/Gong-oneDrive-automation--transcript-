# Warp — architecture

**Status:** as built, 21 September 2026
**Audience:** engineers working on this codebase

Warp turns customer conversations and delivery-system state into client-facing
documents, and keeps the systems of record current. Today it reads Gong call
transcripts and the Aquera CX Portal project tracker, correlates them by
customer, and drives the Claude Code CLI to produce MOMs, weekly and monthly
status reports — each one landing in a review queue rather than going straight
out.

Related documents, not duplicated here:

| Document | What it covers |
|---|---|
| [`README.md`](../README.md) | Setup, commands, the Gong API as reverse-engineered |
| [`CLAUDE.md`](../CLAUDE.md) | Working rules for agents editing this repo |
| [`docs/product-notes.md`](product-notes.md) | Why this exists, what it is worth, where it goes |
| [`docs/cxportal-schemas.md`](cxportal-schemas.md) | CX Portal response shapes, auth, the probe |

---

## 1. Context and goals

A consultant runs implementation projects for many customers at once. Every
week the same work happens by hand: sit through calls, write minutes, write a
status report, then re-type the same facts into a project tracker that is
always slightly out of date.

Warp's bet is that the transcript already contains the report, and the tracker
already contains the delivery state — what is missing is the join between them
and the discipline to keep both current.

**Design goals, in priority order:**

1. **Never assert something no source supports.** A status report that invents
   a go-live date is worse than no report, because it is believed.
2. **A person approves before anything leaves.** The goal is not less human
   involvement — it is *cheaper* human involvement: approving a diff rather
   than authoring a document.
3. **Work survives the page.** A run that takes six minutes must not die
   because someone switched tabs.
4. **Cost is a product constraint.** Runs are billed per token. Scope is
   narrowed before a run, not after.

**Explicit non-goals:** multi-tenancy, horizontal scale, serverless deploy.
This is a long-lived single-process server that spawns child processes and
holds a wall-clock scheduler. See §9.

---

## 2. High-level shape

```
┌─────────────────────────────────────────────────────────────────────┐
│  Next.js 15 App Router  ·  React 19  ·  single Node process         │
│                                                                     │
│  app/          pages + route handlers      (4.6k lines, 62 files)   │
│  components/   AppShell, shadcn/ui, widgets (3.4k lines)            │
│  lib/          client hooks and formatting  (750 lines)             │
│                                                                     │
│  ─────────────────────────── server ─────────────────────────────   │
│                                                                     │
│  core/         connectors, workflow engine, db  (4.1k lines)        │
│  *.js (root)   gong, organize, library, projects, runs, settings    │
│                                                (3.3k lines)         │
│  legacy/       the pre-Next vanilla server, kept for reference       │
└─────────────────────────────────────────────────────────────────────┘
          │                    │                      │
          ▼                    ▼                      ▼
   ┌────────────┐     ┌────────────────┐     ┌─────────────────┐
   │  data.db   │     │ Gong internal  │     │  CX Portal      │
   │  SQLite    │     │ API (cookie)   │     │  (Cognito JWT)  │
   │  WAL       │     └────────────────┘     └─────────────────┘
   └────────────┘              │                      │
                               ▼                      ▼
                       transcripts on disk    warp-context/*.md
                               │                      │
                               └──────────┬───────────┘
                                          ▼
                                ┌──────────────────┐
                                │ Claude Code CLI  │
                                │  (child process) │
                                └──────────────────┘
                                          │
                                          ▼
                              documents/ + approvals queue
```

### The three layers

**Connectors** know how to talk to one outside system and nothing about Warp.
Each declares its config schema, credential schema, capabilities and tabs, and
the Applications UI is rendered from that declaration — adding a connector is a
file plus a route, with no UI work.

**The workflow engine** is the only place a run executes. Workbench authors a
workflow, Automation schedules it, and both call `runWorkflow()`, so what was
tested is literally what runs on a timer.

**Runs** are server-owned. A run is created, streams events, and is persisted;
the page attaches and detaches freely. Detach is not cancel.

---

## 3. The domain model

```
Project (customer)
  ├── transcripts[]   Gong calls, on disk, grouped by customer folder
  ├── context[]       rendered connector state (CX Portal today)
  ├── messages[]      the persistent chat for this customer
  └── sessionId       the Claude conversation this project continues

Workflow  (what to do)          Schedule  (when to do it)
  source → destination            workflowId
  skill + instruction             time, days[], graceMinutes
  sourceInstructions{}            lastSlot, lastRunAt
  scope { projectId, sources[], window, cxMode }
  pull  { enabled, organizeBy }

Run (one execution)             Approval (one proposed output)
  kind, status, text              kind: document | email
  meta.workflowId                 path or body
  events[] (replayable)           status: pending | approved | rejected
```

**Workflows and schedules are separate tables on purpose.** One definition —
"weekly status report" — runs daily for one customer and weekly for another
without the prompt being copy-pasted and then drifting.

---

## 4. Data flow: a scheduled report, end to end

```
 1. instrumentation.node.js           setInterval, every 30s
 2. tickSchedules()                   is any schedule due, inside its grace?
 3. runWorkflow(workflow)             the one execution path
      │
      ├─ resolveWindow(scope.window)  "Week/this" → 14 Sep 00:00 → now
      │
      ├─ runPipeline({ daysBack })    Gong pull, then organise by customer
      │    gong.js  → out/YYYY-MM-DD/*.md
      │    organize.js → sorted/<Customer>/*.md
      │
      ├─ resolveScope(scope)          transcripts for this customer, in window
      │
      ├─ contextFilesFor({...})       CX Portal → warp-context/<Customer>/cxportal.md
      │    cxClient().ensureFresh()   renew the Cognito token if near expiry
      │    listProjects(customerName contains …)
      │    withinWindow(rows, w, cxMode)
      │
      ├─ composeInstruction(...)      base prompt + the steer for what arrived
      │
      └─ startChatRun({ files, instruction, skillName })
           │
           ├─ recordRunFiles()        what this run consumed, by path
           ├─ engine.run()            spawn `claude`, stream events
           │    runs.push(id, event)  persisted + fanned out to subscribers
           ├─ recordUsage()           cost and token counts
           └─ proposeFromRun()        documents + covering email → approvals
```

Three things about this flow are load-bearing:

- **The window resolves once** and every source is filtered against the same
  pair of dates. Before this, the Gong pull counted days, the scope counted
  days from a different base, and the CX Portal did not filter at all.
- **`composeInstruction` reads what actually arrived**, not what was ticked. A
  workflow set to both sources that finds no tracker rows this week is a
  calls-only run and is steered as one.
- **Nothing is delivered.** The run ends at the approvals queue.

---

## 5. Low-level: module by module

### 5.1 `core/workflow/` — the engine

| Module | Responsibility |
|---|---|
| `run.js` | `runWorkflow()`, `resolveScope()`, `composeInstruction()`, `modeFor()` |
| `window.js` | `resolveWindow()`, `within()`, `pullDays()`, the Day/Week/Month presets |
| `store.js` | workflows, schedules, `SYNC_TYPES` |
| `scheduler.js` | `scheduleState()`, `tickSchedules()` |
| `context.js` | non-file sources rendered to files, per customer |

`runWorkflow()` branches three ways:

```js
if (source === 'cxportal' && destination === 'projects')  → organizeCxPortal()
if (outputs.kind === 'pipeline')                          → runPipeline()
otherwise                                                 → a generation run
```

**`window.js` is calendar-aligned, not rolling.** A weekly status report covers
Monday to Friday; a rolling 168-hour window run on Wednesday covers half of
last week and quietly restates it. The cost is that "this week" run at 09:00 on
Monday covers nine hours — which is what the `This / Previous` anchor is for,
and why the resolved dates are always on screen rather than implied.

```js
resolveWindow({ preset: 'week', anchor: 'previous' })
// → { from, to, days: 7, label: 'Last week',
//     fromDay: '2026-09-07', toDay: '2026-09-13' }
```

Legacy string windows (`last7d`, `last30d`, `all`) still resolve, so workflows
saved before the presets existed keep running unchanged.

### 5.2 `core/connectors/` — outside systems

| Module | Responsibility |
|---|---|
| `registry.js` | one declaration per application; the Applications UI renders from it |
| `cxportal.js` | the CX Portal client: `action()`, `listProjects()`, `refresh()` |
| `cx-client.js` | one configured client, with token write-back |
| `cxportal-organize.js` | fetch what is mine → write per customer → link to projects |

Eleven connectors are declared; seven are live:

```
gong        transcripts                          Configuration, Credentials, Data, Schema
claude      generate                             Configuration, Skills
cxportal    projects, tasks, customers, stations Configuration, Credentials, Data, Schema
projects    projects                             Configuration, Data
library     files                                Configuration, Data
graph       graph                                Configuration, Data
automation  schedule                             Configuration, Data
jira / m365 / slack / zoom                       declared, not implemented
```

**Gong** authenticates with a session cookie (~16 days) posted from a Chrome
extension or pasted by hand. The internal API takes a JSON body with
`X-CSRF-TOKEN`, `referer` and `origin`; call ids are 19-digit and must be parsed
as BigInt.

**CX Portal** is the awkward one. Almost the whole API is `GET
/ops/project-tracker?action=…` dispatched by one of 16 observed actions, plus
`note_counts`, the single POST, whose body has never been captured. Auth is a
Cognito **access** token (not the id token beside it in localStorage) that lives
about an hour, so `ensureFresh()` runs before every call and a scheduled run
renews as a matter of course. `refresh()` persists a rotated refresh token when
the pool returns one — dropping it means auth breaks days later, far from the
change that caused it.

Filter operators are `equals / contains / isAnyOf / …` with **no date
comparison**, so date windows are applied client-side. `filterLogic` is global
per request, which is why the IC-or-secondary-IC query must use `OR`.

### 5.3 `core/correlate.js` — the join

Gong and the tracker never agreed on a name. Gong labels a call from whatever
was typed in the invite; the tracker holds the legal entity. Neither carries the
other's id, so the customer name is the only join available.

```js
normalise('RW Supply + Design')     // 'rw supply design'
normalise('RW Supply and Design LLC')// 'rw supply design'  → exact
```

Confidence is graded, and the grade decides what happens:

| Grade | Meaning | Action |
|---|---|---|
| `exact` | identical once normalised | applied |
| `strong` | one name's words contain the other's, contiguously | applied |
| `weak` | one long word shared, nothing contradicting | **surfaced for review, never applied** |
| `null` | no relationship worth reporting | reported as an absence |

Containment compares **word sequences, not substrings** — substring containment
matched `Apple` to `Pineapple Corp`, which is how one customer's go-live date
ends up in another customer's report.

Both absences are returned deliberately: a customer with calls and no tracker
project is unbilled work; a tracker project with no calls is a delivery nobody
is talking to.

Against live data this matches 9 of 9 customers with 0 needing review.

### 5.4 `runs.js` — server-owned execution

```js
createRun() → push(id, event)* → finish(id, patch)
              subscribe(id, cb) // any number of times, at any time
```

Every event is persisted to `run_events`, so a page that attaches late replays
from the beginning. `runs` is a **six-hour replay buffer** — `prune()` empties
it, which is why `run_files` carries its own timestamp and is deliberately left
behind (see §6).

`setCancel()` holds the kill closure in memory only; after a restart there is
nothing to kill, and `reapOrphans()` marks those runs accordingly at boot.

Streaming is SSE over a `ReadableStream` at `/api/runs/[id]/stream`, with
`x-accel-buffering: no`.

### 5.5 `core/claude/engine.js` — the model boundary

```js
class CliEngine { available(); run({ skill, instruction, files, … }) }
class ApiEngine { /* deliberate stub */ }
getEngine(name = process.env.GONG_ENGINE || 'cli')
```

`CliEngine` spawns `claude` with `--add-dir` for each library root, so files go
in **as paths, not contents** — an unread transcript costs nothing, while an
inlined one is paid for on every turn.

`ApiEngine` is a stub. Reimplementing the tool loop, sandboxing and skill
resolution is a project of its own; the interface exists so the choice stays
open.

### 5.6 `core/approvals/store.js` — the queue

```js
propose(item) · decide(id, status) · decideMany(ids, status) · counts()
proposeFromRun({ runId, documents, email, … })
```

Documents are proposed by path; the covering email is proposed as text, because
it never becomes a file — it is meant to be pasted into a mail client, which is
exactly the moment a person should have read it.

`decide` and `decideMany` share one validator. They did not, and a bulk call
with an unknown status wrote it — the row then vanished from every tab, which is
worse than a rejection.

---

## 6. Storage

SQLite via `better-sqlite3` + Drizzle, WAL mode, one file at `data.db`. WAL
matters because the scheduler writes history while a page reads the project
list; without it the reader blocks and the UI stutters mid-pipeline.

| Table | Purpose | Lifetime |
|---|---|---|
| `projects` | one workspace per customer | permanent |
| `project_transcripts` | what a customer's runs may see | see below |
| `messages` | the persistent per-customer chat | permanent |
| `workflows` | what to do | permanent |
| `schedules` | when to do it | permanent |
| `runs` | in-flight and recent executions | **pruned at 6h** |
| `run_events` | replay log | pruned with its run |
| `run_files` | which transcripts a run consumed | **permanent** |
| `usage` | cost and tokens per run | permanent |
| `approvals` | the review queue | permanent |
| `graphs` | saved graph policies | permanent |
| `automation_history` | pipeline outcomes | permanent |
| `settings` | UI state, one JSON row | permanent |

**Two schema decisions worth knowing:**

`project_transcripts.kind` distinguishes `'transcript'` (a Gong call) from
`'context'` (rendered connector state). They share a table because both answer
"what may a run about this customer see", but they are pruned separately —
`syncFromLibrary()` rebuilds transcripts from the sorted tree, and an unscoped
delete wiped every CX Portal link on its next pass.

`run_files.at` exists because `runs` is a six-hour buffer. Joining `run_files`
to `runs` for a date would make "transcripts processed" read zero on a system
that had processed hundreds.

Money is stored as **integer micro-dollars** (`toMicros`/`fromMicros`). Schema
changes are additive via `ADDED_COLUMNS` + `migrateColumns()`; indexes over
added columns are created *after* the ALTERs, or the whole DDL batch aborts on
an older database.

---

## 7. Front end

Next.js App Router, React 19, Tailwind v4 with a CSS-first `@theme` block (no
`tailwind.config.js`), shadcn/ui primitives, Phosphor icons.

```
/dashboard      14 draggable widgets, one /api/dashboard call
/applications   connector grid → /applications/[id] with per-connector tabs
/workbench      sync types as cards → /workbench/[id], the 4-step editor
/automation     schedules left, settings and logs right, resizable
/approvals      the review queue
/graph          per-customer/project policy → computed tree
/projects       per-customer chat
/preview        the file library
```

**Notable client modules:** `lib/useRunStream.js` (attach/replay/detach),
`lib/useResponsive.js` (`useBreakpoint`, `useResizablePanel`),
`lib/useWidgetLayout.js` (drag order + visibility, reconciled so a widget added
later still appears for someone with a saved layout),
`components/WindowPicker.jsx` (the Day/Week/Month control, shared by Workbench
and Automation).

Theme tokens are `--text-muted` and `--brand`, deliberately **not** `--muted` or
`--accent`, which collide with shadcn's own variables.

`@phosphor-icons/react` is listed in `experimental.optimizePackageImports`. Its
barrel re-exports 1512 icon modules, and dev compiled all of them for every
page; the same treatment Next applies by default to `lucide-react`. Measured:
12.7s → 9.1s of cold compile across the eight pages.

---

## 8. Performance

Production serves pages in **2–12ms** and API routes in **3–9ms**. `next dev`
serves the same pages in 31–65ms warm and **800–2,700ms cold**, because it
compiles each route on first visit — that is the difference people feel, not
server work. `npm run serve` builds and starts production on the same port.

Server-side helpers were profiled directly: `readSettings()` 0.82ms,
`listSkills()` 0.81ms, `loadConfig()` 0.25ms, `usageSummary()` 0.33ms. Steady-
state client polling is ~0.3 req/s.

`core/cache.js` (`memo`, `memoAsync`, `invalidate`) exists for one measured
problem: `scanClaudeProcesses()` was a blocking 41.8ms `execSync` on a polled
endpoint. It is memoised for 1s. `/api/dashboard` deliberately does not scan
processes at all.

Turbopack was evaluated and **panics** on this project (Next 15.5.25,
`Failed to write app endpoint /dashboard/page`).

---

## 9. Key decisions and trade-offs

| Decision | Why | What it costs |
|---|---|---|
| Long-lived `next start`, not serverless | spawns child processes that outlive a request, holds run buffers, runs a wall-clock scheduler | no Vercel; `output: 'standalone'` would be needed for containers |
| SQLite, not Postgres | one file, no server; swapping is a driver change plus `schema.js` | single writer, single host |
| Files as paths, not contents | an unread transcript costs nothing | the agent needs filesystem access |
| CLI engine, not the API | skills, tool loop and sandboxing already work | a child process per run |
| Workflows separate from schedules | one definition runs on different cadences per customer | two tables to keep in step |
| Calendar windows, not rolling | reports are calendar things | the first morning of a period is nearly empty |
| Correlation grades confidence | a wrong match puts one customer's data in another's report | weak matches need a human |
| Approvals before delivery | at 90% accuracy, ten wrong updates a day flow into the board people plan from | nothing is fully automatic |

**Known gaps:**

- `ApiEngine` is a stub.
- The scheduler cannot wake a sleeping Mac; a slot passes while it sleeps and
  is recorded as missed.
- Gong → CX Portal write-back needs endpoints that have not been captured.
- 36 of 39 CX Portal filter keys and the parameters for 3 actions are still
  unconfirmed. `npm run cx:probe` settles them empirically — it tests each
  candidate by contradiction, because the API ignores unknown attributes rather
  than rejecting them, which reads exactly like a filter that matched
  everything.

---

## 10. Running it

```bash
npm run dev      # development, recompiles per route on first visit
npm run serve    # build + start production on :7878 — use this to *use* Warp
npm run migrate  # projects.json / settings.json → SQLite
npm run pull     # Gong pull from the CLI, no UI
npm run cx:probe # settle the open CX Portal schema questions
```

`instrumentation.node.js` runs once per server process: reaps runs orphaned by a
restart, arms the 30-second scheduler tick, starts the 15-minute run pruner, and
installs shutdown hooks that stop child Claude processes.

`instrumentation.js` must stay a positive `NEXT_RUNTIME === 'nodejs'`
conditional wrapping the import, and nothing else. Webpack inlines the variable
per compilation, so the edge pass sees `'edge' === 'nodejs'` and eliminates the
branch — import included — before resolution. An early
`if (… !== 'nodejs') return;` reads identically and does not work: the import is
then a sibling statement, webpack still resolves it, and the edge build fails on
`Can't resolve 'fs'`.

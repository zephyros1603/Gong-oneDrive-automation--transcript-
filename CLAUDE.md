# CLAUDE.md

Working notes for Claude Code in this repo. `README.md` explains the product;
this file is the things that will bite you, most of which were learned the hard
way and are not visible from reading the code.

## What this is

**Warp** — a web app that pulls Gong call transcripts and turns them into client
documents (minutes, status reports, covering emails) by driving the Claude Code
CLI. Next.js 15 + React 19 + SQLite + shadcn/ui, one long-lived Node process,
loopback only.

Direction and open product questions are in `docs/product-notes.md`; the
in-flight plan is `~/.claude/plans/wise-waddling-hippo.md`.

```
npm install          # once
npm run build && npm start     # http://127.0.0.1:7878
npm run dev          # hot reload, same port
npm run migrate      # import legacy projects.json / settings.json (already run)
node gong.js me --days 7       # the CLI, works with no server running
```

## Three traps that have already cost time

**A bare directory name in `.gitignore` matches everywhere, not just at the
root.** `transcripts/`, `raw/`, `sorted/`, `documents/`, `logs/` were meant
to ignore the top-level data directories `gong.js`'s `loadConfig()` writes
to — but written unanchored, `transcripts/` also matched
`app/api/gong/transcripts/`, a real route, silently excluding it from every
commit. `.next-*/` had already been through this once with `.next-final`.
Fixed by anchoring all five to the root (`/transcripts/`, etc.) — the general
rule: a data-output directory name that could plausibly recur anywhere else
in the tree (a route segment, a component folder) needs the leading `/`.

**`fill-mode-backwards` makes elements invisible.** `animate-in fade-in
fill-mode-backwards` holds an element at the animation's opening frame —
opacity 0 — whenever the animation does not actually run, and the
reduced-motion block in `globals.css` is enough to cause that. The Applications
grid rendered completely blank because of it. Use the hand-written
`.app-tile-in` keyframe, which has an explicit reduced-motion fallback.

**`execSync` on the request thread is the real performance trap.**
`scanClaudeProcesses()` shells out to `/bin/ps` and costs 42ms of *blocking*
— every other request stalls behind it, and three pollers each triggered their
own. It is memoised in `core/cache.js` (1s TTL, shared in-flight calls) and
`/api/dashboard` no longer calls it at all. `/api/dashboard` went 68ms → 8ms;
40 concurrent requests now finish in 315ms. Measure before adding caching: the
fix was mostly *not calling the blocking thing*.

**The API is not slow; `next dev` is.** Measured: production pages 2–3ms, APIs
3–68ms. In dev the first hit on a route compiles it — `/api/connectors` took
5187ms once and 15ms warm. Before optimising anything, check which server is
running.

## Navigation and page structure

**Top navigation, not a sidebar.** A sidebar was built first and replaced — a
data-dense product would rather spend those 230px on the table. `AppShell.jsx`
is a white primary bar plus a coloured contextual band; the band always renders
even for sections with one sub-item, because an element that appears and
disappears makes the page jump 44px on every navigation.

Anything that *creates* something lives behind the `+` button, never in the
nav. The nav is a list of places; the moment it becomes a list of verbs it
stops being navigable.

**No secondary nav band.** There was one; it was removed. Settings belong in an
application's Configuration tab, not in a second row of chrome.

**Pull is not a page.** Fetching transcripts is something done *to* a
configured source, so it lives at `/applications/gong?tab=data`
(`components/GongPull.jsx`). There is no `/pull` route. The same rule applies to
anything a future connector exposes: configure it under Applications, use it
under that application's Data tab.

Each connector declares its own `tabs`. Claude has only Configuration —
it has no data of its own and nothing to map, and an empty tab is worse than no
tab. `core/connectors/registry.js` is the one place an application is described —
`configSchema` drives the form, `test()` drives the Credentials tab,
`capabilities` is what the rest of the app reads to decide what a workflow may
use as a source. Adding Jira is a file here, not UI work.

## CX Portal — the short-lived-token connector

`core/connectors/cxportal.js`, reverse-engineered from a live session like the
Gong client. Two things make it unlike every other connector:

**The token lasts about an hour.** Gong's cookie lasts ~16 days, so paste-and-
forget works there; it does not here. A schedule firing at 09:00 will almost
always find an expired token. Until the Cognito refresh flow is implemented
this connector is usable interactively and **unreliable on a timer** — say so
rather than letting a schedule fail silently. `refreshToken` is in the portal's
localStorage, so the flow is buildable; it just is not built.

**Two token mistakes both produce an indistinguishable 401**: using the
`idToken` instead of the `accessToken`, and using one that has aged out.
`tokenInfo()` decodes `token_use` and `exp` offline, so `test()` names which of
the two happened before making any request.

Almost the whole API is `GET /ops/project-tracker?action=…`, so `action()` is
the primary method and the named helpers wrap it. `filterLogic` is **global** —
there is no per-clause nesting, which is why `customer = X AND (IC = Y OR
secondary = Y)` cannot be expressed in one call and has to be sifted client
side.

Response schemas **are** now captured — `docs/cxportal-schemas.md`, with raw
output in `docs/cxportal-shapes.json`. 15 of 17 actions answered;
`calendar_tasks` needs parameters (400) and `tc_analysis_aggs` timed out (504).
`shapeOf()` and the Data tab's **Shape** mode report structure without printing
records, which is how that was done without customer data landing in a log.

Three findings that contradict the original reference:

- `nextCursor` comes back as a **string**, though the request takes the cursor
  as a JSON tuple. Echo it verbatim; do not re-encode.
- `secondaryConsultantName` is filterable but **never returned**, so a result
  cannot tell you which of the two IC slots matched.
- `/ops/customersps` is genuinely paginated (`totalPages`, `hasMore`). "Pages
  1 to 6" is what the SPA requests, not a fixed bound.

## Feeding more than transcripts into a run

A workflow's scope is a list of **file paths**, because that is what the agent
reads cheaply through `--add-dir`. Anything that is not already a file — the CX
Portal tracker today, Jira or mail later — is rendered to markdown per customer
by `core/workflow/context.js` and added to the same list. Files, not prompt
text: an unread context file costs nothing, an inlined one is paid for on every
turn.

The folder is **`warp-context/`**, not `context/`. A plain `context/` already
existed at the project root holding hand-written research notes, and adopting
it as a library root fed those notes into every workflow.

**Match customers server-side.** The two systems only share a customer name —
Gong groups by `callCustomers`, the tracker by `customerName` — and punctuate
differently ("Tech Systems Inc" vs "Tech Systems, Inc."), so the probe is the
longest distinctive word with a `contains` filter, confirmed against the full
name afterwards. Fetching a page and matching in memory looked fine and was
silently wrong: there are 1100+ projects, a page returns 200, and most
customers were never in the window. That took 8 of 9 matches from 2.

`customerName` is a confirmed filter attribute — a fourth, beyond the three in
the original reference.

**Phosphor only ships qualified icon names.** `Brackets` does not exist;
`BracketsCurly` does. Importing a name the package does not export yields
`undefined`, which React reports as a render crash several frames from the
import — it crashed the CX Portal Data tab. Check the export before using an
icon name that seems obvious.

## Default applications

Projects, Library, Graph and Automation are registered in
`core/connectors/registry.js` alongside Gong and Claude. They are applications
because that is where configuration lives now — one place to look, one form,
one refresh button. They differ only in connecting to Warp itself, so they are
always connected and cannot be removed.

Their values live where they belong, not in one store: a Gong host stays in
`gong.env` because the CLI reads it with no server running, while a turn cap is
UI state. `readValues()` in `app/api/connectors/[id]/route.js` hides that split
from the form.

`POST /api/refresh` re-reads the disk and drops the library cache. It exists
because the file walk is memoised for a second — right for polling, wrong for
"I just moved a folder in Finder" — so the button is explicit rather than the
TTL being shortened for everybody.

## Graphs

A graph is a **policy**, never a stored tree. `core/graph/build.js` computes it
on every read, which is why a transcript pulled or a document generated a
moment ago is already in it and nothing has to invalidate a cache.

Policy is `defaults` plus per-customer `rules` plus `exclude` — that is what
"policy at different levels" means: set the shape once, then narrow one client.
Counts follow the policy too; reporting documents a policy excludes makes the
totals disagree with the tree directly beneath them.

Documents attach to a customer through `run_files` when a run recorded them,
falling back to filename matching only for documents generated before that
table existed.

**`builtin` belongs to the record, not the edit.** Taking it from the caller
meant any save that omitted it silently demoted the default graph, which then
let it be deleted and made `ensureDefaultGraph()` create a duplicate. Both
`saveGraph` and `saveWorkflow` now set it on insert only. This bug shipped and
had to be repaired in data.

## Syncs — what Workbench is

**Workbench is not a chat.** Chat lives in Projects, where it has a customer
and a history to belong to. Workbench lists *sync types* as cards
(`SYNC_TYPES` in `core/workflow/store.js` — today only `gong → claude` is
available) and each card holds the automations configured under it, one per
customer, each with its own id shown on the page for tracking.

`/workbench/[id]` is the whole definition in four steps: pull → scope → prompt
and skill → schedule. That is the same record Automation schedules, so **Run
now** here and the 09:00 firing are the same `runWorkflow()`.

There is no file tree in Workbench. Picking individual files is a chat
affordance and belongs in Projects.

## Runs must be findable again

A run is server-owned, so leaving a page aborts the *stream* and not the work.
Coming back therefore has to re-attach, and that only works if the run records
what started it:

- `startChatRun` merges `body.meta` into the run's meta.
- `runWorkflow` passes `{ workflowId, trigger }`.
- A page finds its run on mount with
  `runs.find(r => r.status === 'running' && r.meta?.workflowId === id)`.

Without that tag, navigating away mid-run left the job running invisibly with
its output arriving nowhere — which is exactly what the old Workbench did.

The other half is that `useRunStream` resets when `runId` goes null, so a
finished run's output has to be captured in `onFinish` before clearing, or the
result vanishes the instant it succeeds.

## Workflows and schedules

`workflows` is *what to do* (skill + instruction + scope + outputs);
`schedules` is *when*, referencing a workflow. Two tables, deliberately: one
"weekly status report" definition runs Fridays for one customer and Mondays for
another without the prompt being copy-pasted and then drifting.

`core/workflow/run.js` `runWorkflow()` is the only execution path — Workbench
test-runs it, `core/workflow/scheduler.js` fires it on a timer. `scope`
resolves through the Projects model, which is what stops a workflow for one
customer seeing another customer's calls.

The legacy single pipeline still ticks alongside the new scheduler so an
existing automation config does not silently stop; it is also seeded as the
builtin "Daily transcript sync" workflow.

## The design system

Light is the base, dark is a `.dark` class on `<html>` — shadcn's convention,
and the only shape that allows a real toggle. Do **not** reintroduce a
`prefers-color-scheme` query as the mechanism; the old build had it that way and
a button could never override it. `components/ThemeToggle.jsx` exports
`themeScript`, which must stay inlined in `<head>` or the light theme flashes
before dark on every reload.

`app/globals.css` holds two vocabularies on purpose:

- **shadcn semantics** (`--background`, `--card`, `--primary`, `--border`,
  `--muted-foreground`) are the source of truth. New code uses these, via
  Tailwind utilities like `bg-card` and `text-muted-foreground`.
- **Legacy aliases** (`--bg`, `--surface`, `--line`, `--text`) map onto them so
  pages written before the migration still work. Delete an alias when its last
  reader is gone.

Two original tokens had to be renamed, because shadcn uses the same names for
different things. Do not undo these:

| Was | Now | Why |
|---|---|---|
| `--muted` (grey *text*) | `--text-muted` | shadcn's `--muted` is a *surface* |
| `--accent` (brand purple) | `--brand` | shadcn's `--accent` is a hover fill |

Icons are **Phosphor** (`@phosphor-icons/react`), not Lucide — Lucide has no
rounded variant, and the rounded weight is most of what reads as premium here.
The shadcn CLI ignores `iconLibrary` and emits Lucide imports; swap them after
generating a component. `weight="duotone"` for idle, `"fill"` for active.

The Composer must not sit inside `overflow-hidden` — its skill picker opens
upward and gets sliced. The rounded corners come from the child rows instead.

Every dashboard widget is draggable and hideable (`lib/useWidgetLayout.js`, native
HTML5 drag — a dnd library would be ~40KB for reorder-within-one-list). Layout
is per-viewer in localStorage and reconciled against the widget catalogue on
read, or a widget added later never appears for anyone who saved a layout.

Every route has a `loading.jsx` whose skeleton matches the layout that replaces
it, so pages settle rather than jump.

`components/ui/` is shadcn's generated primitives — regenerable, avoid editing.
`components/common.jsx` is the hand-written shared pieces. `components/ui.jsx`
was renamed to avoid confusion with the directory, not because they collide.

## Rules that are load-bearing

### 1. This can never run serverless

It spawns `claude` children that outlive the request that started them, holds
live cancel closures in memory, and runs a wall-clock scheduler. Vercel and
every other serverless host break all three. Target is `next start` on a
persistent machine. Every route touching a run declares:

```js
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
```

### 2. `instrumentation.js` must stay four lines

Next compiles it for **every** runtime including edge, and edge has no `fs`.
The moment anything there reaches `better-sqlite3` or `child_process` the build
dies with `Module not found: Can't resolve 'fs'`.

```js
// correct — webpack inlines NEXT_RUNTIME and eliminates the whole branch
if (process.env.NEXT_RUNTIME === 'nodejs') await import('./instrumentation.node.js');

// WRONG, and it reads identically — the import is a sibling statement, not
// inside an eliminable branch, so the edge pass still resolves it
if (process.env.NEXT_RUNTIME !== 'nodejs') return;
await import('./instrumentation.node.js');
```

All real startup work lives in `instrumentation.node.js`. This bug shipped once.

### 3. `core/` and the root modules are plain JavaScript, not TypeScript

`gong.js` runs as a CLI under bare `node`, which cannot load `.ts`. Anything it
imports — `core/db/*`, `library.js`, `settings.js`, `projects.js`, `runs.js` —
must stay `.js`. `app/`, `components/` and `lib/` are where TS would go.

TypeScript is pinned to 5.x: **Next 15 rejects TypeScript 7 outright.**

### 4. Process-bound state is pinned to `globalThis`

Next re-evaluates modules on every edit in dev. A registry in a module binding
gets wiped mid-run, orphaning a `claude` process that bills on in the
background. See `runs.js` (`globalThis.__gong_runs`) and `core/db/client.js`
(`globalThis.__gong_db`).

### 5. `-H 127.0.0.1` is the entire authorization model

There is no authentication of any kind. `next start` binds `0.0.0.0` by
default. The npm scripts and `Start Gong UI.command` both pin the host; anything
else that starts the server must too, or an unauthenticated app that reads the
filesystem and holds a Gong session is on the local network.

### 6. Port 7878 is not arbitrary

The Chrome extension posts to `127.0.0.1:7878/api/cookie`. Changing the port
means reinstalling the extension on every machine.

### 7. Detaching a run must never cancel it

`POST /api/runs` starts a run and returns an id; `GET /api/runs/:id/stream`
follows it. Separate requests on purpose — that is what survives a tab switch.
The server records every event to `run_events` and replays it to whoever
attaches, including after a restart.

The trade-off is deliberate and was signed off: a run you walk away from keeps
going and keeps costing. The global Stop in the top bar is what makes that
acceptable. **Do not "fix" this by cancelling on disconnect.**

### 8. Nothing spawned may outlive the server

A headless `claude` run bills for as long as it lives and does not die with its
parent. Three kill paths exist and all matter: per-run cancel, `cancelAll()`,
and `killAllNow()` from the shutdown hooks. `scanClaudeProcesses()` classifies
every `claude` on the machine and **excludes `/Applications/Claude.app/`** so
the desktop app can never be killed; `killClaudePids()` only kills PIDs its own
scanner recognised.

## The Gong API, as reverse-engineered

Undocumented internal endpoints. Every one of these was found by probing:

- `POST /conversations/ajax/results` needs a **JSON body** — form-encoded is
  rejected — plus `X-CSRF-TOKEN`, `referer` **and** `origin`. A missing header
  returns a bare `{"error":true}`, which looks like a bad filter and is not.
- `Participants` takes **`userIds`**, not `ids`. With `ids` it 400s; with
  `userIds` but no `host`/`attendee`/`invitee` flags it returns **0 results
  with no error** — a silent wrong answer.
- Call ids are 19 digits and exceed `Number.MAX_SAFE_INTEGER`. `JSON.parse`
  rounds them *silently*. Every response goes through `parseBig()`, which
  quotes 16+ digit integers before parsing. Never hand `gongTranscript.js` a
  pre-parsed object.
- An empty `filters` array is invalid; for "no filter" send `"search": null`.
- `last-login` is the only cookie that matters — on its own it authenticates
  *and* searches. `cf_clearance` is frequently absent entirely, so requiring it
  rejects good sessions. An earlier version did exactly that.
- The cookie lasts ~16 days, not hours.

## Storage

SQLite (`data.db`) via Drizzle. `gong.env` stays a file — the CLI reads it with
no server running, the extension writes to it, and it is the one thing that
must be `chmod 600`. **Credentials never move into the database.**

- `runs` + `run_events` — replay survives a restart
- `projects`, `project_transcripts`, `messages` — transcripts are rows, not a
  JSON array on the project, so the organizer adding one file does not rewrite
  the project. That whole-document rewrite is what made the old JSON store lose
  concurrent updates silently.
- Money is **integer micro-dollars**. A run costs `$0.096229`; the usage table
  is only ever summed, which is where float error shows.

## Don't reintroduce what was just deleted

The vanilla build had four copies of the SSE reader, two ~120-line composers,
three splitters and three copies of `esc`. They had already drifted.

| Need | Use |
|---|---|
| App chrome, nav | `components/AppShell.jsx` |
| Follow a run | `lib/useRunStream.js` |
| Chat input | `components/Composer.jsx` |
| Sidebar + content page | `components/SidebarLayout.jsx` |
| Breakpoints, resizable panel | `lib/useResponsive.js` |
| Formatters | `lib/format.js` |
| Markdown / email markers | `lib/md.js` |

## Layout

The shell is `overflow: hidden` — panes scroll, the page does not. The sharp
edge: anything wider than the window is **clipped and unreachable**, not
scrolled to. A `flex-none` six-tab nav did exactly that and ate the Provisioning
tab below ~700px. Browser zoom reproduces it on a large monitor, because zoom is
just a narrower viewport in CSS pixels.

Below `lg` the sidebar becomes an overlay and the nav becomes a menu. New
full-width UI must be checked at 360px.

## Covering emails are not files

A MOM's email comes back **in the reply** between `=== EMAIL ===` and
`=== END EMAIL ===`, rendered as a copyable box. Never write it to disk — an
email in a `.docx` is a file nobody opens. The markers are in
`claude-runner.js`'s `buildPrompt()` and parsed by `lib/md.js`.

## Cost — this is a real product constraint

Measured, not estimated:

| Action | Cost | Turns |
|---|---|---|
| MOM + email | $0.60–0.80 | 11–13 |
| WSR | $0.84–2.44 | 5–28 |
| Ad-hoc question | $0.10–1.20 | 1–15 |

`maxTurns` (default 40) is the circuit breaker on a run that loops. Treat every
change that adds turns as a cost change.

## Testing this thing

- **Run `npm run dev` as well as `next build`.** A bug shipped once that
  production-only testing could never have caught.
- Isolated server without disturbing a running one:
  `NEXT_DIST_DIR=.next-t npx next start -p 7881`. `dev` and `build` write
  incompatible artifacts to the same `.next`.
- Headless Chrome **will not open a window narrower than 500px** on macOS.
  `--window-size=390` gives a 500px render cropped to 390, which looks exactly
  like a layout bug and is not one. For true phone widths, load the page in a
  fixed-width iframe from a separate static page.
- `--dump-dom` with `--virtual-time-budget` **hangs** here: the top bar polls
  every 3s, so virtual time never settles. Screenshots work; dump-dom does not.
- `page.goto(url, { waitUntil: 'networkidle0' })` **hangs too, for a different
  reason**: `AppShell.jsx` opens `EventSource('/api/notifications/stream')` on
  mount, and that connection is deliberately never-closing — the whole point
  of it is to stay open. `networkidle0` waits for zero in-flight connections,
  which never happens. Use `domcontentloaded` (or `networkidle2`, which
  tolerates up to two) plus a short explicit wait instead.
- A build that touches `@univerjs/*` takes noticeably longer than the rest of
  this app — budget minutes, not seconds, and do not assume a stalled-looking
  build has hung.
- Always clean up headless Chrome afterwards — it survives the shell exiting.
  Kill by the `--user-data-dir` path, never by matching "chrome": `lsof -ti` once
  matched Google Chrome Helper and would have killed the real browser.
  Use `lsof -sTCP:LISTEN` when looking for a port's owner.

## The script engine (`core/engine/`)

`core/engine/sandbox.js` runs user-authored JS in a Node `vm` context — no
`require`, `fs`, or `process`, only a curated `warp` object
(`core/engine/api.js`). This is **not a security boundary against a malicious
author** — `vm` is well known to be escapable with effort. It exists to catch
*accidents* loudly (an accidental `require('fs')` throws instead of silently
working) for a single-operator server where the scripts are the operator's
own. Two timeouts matter for different reasons: `vm`'s own `timeout` option
uses V8 interrupts and is the only thing that stops a synchronous
`while (true) {}` — without it that loop blocks the whole Node process, not
just the sandbox, since everything here is single-threaded. A second,
`Promise.race`-based timeout catches the other failure mode: an `await` that
never resolves, which the synchronous `vm` timeout cannot see.

Scripts run through `runs.js` like everything else, which is what surfaced a
real bug in `/api/runs/[id]/stream`: `runs.subscribe()` replays persisted
events **synchronously**, so a run that finishes before anyone subscribes
fires its callback before the `const off = subscribe(...)` assignment that
defines it has completed — a temporal dead zone, `Cannot access 'off' before
initialization`. Every chat and workflow run had taken long enough to still
be `'running'` when a client attached, so this path went untested until a
script fast enough to finish in milliseconds existed. Fixed with `let off;`
declared before the call. Watch for this pattern anywhere else code does
`const x = subscribe(id, cb)` and `cb` closes over `x`.

## Projects, redesigned: one CX Portal project, one context file

A Warp project used to be a grab-bag — raw transcript files, a raw CX Portal
render, and a separate digest file, attached individually, existing because
either a Gong folder appeared or `createMissing` fired. As of this redesign:
**a CX Portal project assigned to me is the only thing that creates a Warp
project**, 1:1 — not per customer, per *project* (a customer with two CX
Portal projects gets two Warp projects). `syncFromLibrary()`'s Gong-only
creation is retired (`createMissing` now defaults `false`); it still updates
`transcript`-kind rows for bookkeeping on projects that already exist, it
just never creates a new one from a Gong folder alone.

`projects.cxpProjectId`/`cxpDisplayId` are the durable link a fuzzy name
match used to stand in for — `core/correlate.js`'s whole confidence-grading
apparatus existed because the two systems only share a customer name and
punctuate it differently. Once a Warp project is known to be *this* CX
Portal project, every later lookup is by id.

**`core/workflow/projectContext.js`** replaces both `context.js`'s per-run CX
Portal render and `digest.js`'s separate token-saving file — they did
overlapping jobs (a compact stand-in for raw material), and one project now
gets exactly one curated file, not two. Two runs, deliberately different
costs:

- **`syncProjectsFromCxp()`** (the creation run) — walks every CX Portal
  project assigned to me (reuses `cxportal-organize.js`'s `fetchMine()`
  unchanged), creates a Warp project for any that doesn't have one, writes a
  cheap stub `context.md`. No Claude call.
- **`updateProjectContext(projectId)`** (the update run) — fetches fresh
  `projectDetail()` data plus whatever Gong transcripts are already
  pulled+organized for that customer within the window, and has Claude
  *rewrite* `context.md` in a fixed format (`gong data :` / `existing CXP
  Data :` / `last updated Date :`). Hash-gated exactly like the old digest
  was (`inputsHash()`-equivalent over the gong files + a stringified cxp
  snapshot) — a schedule that fires with nothing new skips the Claude call.
  Real numbers from the first live run: 2 Gong transcripts + a `projectDetail`
  snapshot → a dense, fact-only file (staffing gaps, target-date slip
  history, open blockers, named owners) in one Claude call.

Both are exposed to scripts: `warp.projects.syncFromCxp()`,
`warp.context.update(id)`, plus `warp.context.read(id)`/`.write(id, text)`
for direct access. **`silent: true` on `startChatRun` exists because of this
feature** (inherited from the old digest system unchanged) — the update run
is a real run, streamed and cancellable, but must not become a visible chat
turn, must not steal `project.sessionId`, and its output must never enter
Approvals. `wantsDocument: false` (see `buildPrompt()` in `claude-runner.js`)
is the other half: without it a silent run's reply narrates about saving a
file instead of answering inline.

`core/chat.js` auto-attaches a project's one `context.md` to a fresh
conversation now — it used to attach raw `project.transcripts`, which meant
a project chat never saw CX Portal data or anything curated at all. This is
the concrete fix for "the context is where chat is" — before this, it
wasn't.

`project_transcripts.kind = 'digest'` is retired; `'context'` is now always
exactly one row per project (upserted on a fixed path, never appended) and
does that job alone. A workflow scoped to `sources: ['digest']` still works
— the wire value stays `'digest'` since an already-saved workflow's scope is
a JSON blob with no migration path — but it now reads each scoped project's
`context.md` read-only rather than triggering `refreshDigest()`.

## Notifications (`core/notify.js`)

A scheduled sync runs unattended by design, so "did anything happen" has to
be answerable without anyone having watched it run. Two-layer delivery, same
shape as `runs.js`: persisted (`notifications` table, so a page opened an
hour later still sees it) and fanned out live over `/api/notifications/stream`
(`EventSource`, never-closing on purpose) to whoever has a tab open.

**This is why `page.goto(..., { waitUntil: 'networkidle0' })` hangs now** —
see Testing this thing, below.

`notifyScheduledRun()` is the one function both schedulers call: it posts a
"started" notification immediately, then subscribes to the run and posts
"done"/"failed" when it closes. Wiring this in found a real, previously
latent bug: `instrumentation.node.js` called `tick({ onRun: (run) => ... })`,
but `tick(startRun)` (in `automation.js`) expects a **callback function** it
invokes to start the run, not an options object. At the scheduled minute,
`startRun({trigger:'schedule'})` threw `TypeError: startRun is not a
function`, silently swallowed by the surrounding try/catch — and by then
`writeAutomation({ lastSlot })` had already run, so the day's slot was marked
handled **without the pipeline ever starting**. This had been true since the
scheduler was written; nothing had exercised the "let's actually watch this
run" path closely enough to notice. Fixed by passing a real callback.

## Approvals: previews, editing, and where an approved file goes

`app/approvals/page.jsx` dispatches by file extension: `.pdf` →
`components/PdfViewer.jsx` (`@pdf-viewer/react` — **the package itself is
marked deprecated by its maintainer**, pointing at a commercial successor at
react-pdf-kit.dev; it still works, it is not receiving updates). `.docx` and
`.xlsx` both go through **one shared component**, `components/UniverViewer.jsx`
— real, in-browser editing for both, on top of Univer. Everything else keeps
the original markdown/text path.

`react-doc-viewer` and the first version of the spreadsheet-only viewer were
both retired in favour of this — Univer models a Doc and a Sheet unit through
the same API, so one component with a `kind` prop replaced two.

### The bridges: real files in, real files out

Neither direction is a fidelity-preserving round trip, the same way neither
was ever claimed to be for the reasons below — both are honest about it in
their own header comments.

- **`core/engine/xlsx-bridge.js`** — `xlsx` (SheetJS) converts real `.xlsx`
  bytes to and from Univer's workbook snapshot. Keeps values and simple
  formulas; does not attempt cell formatting.
- **`core/engine/docx-bridge.js`** — `mammoth` converts `.docx` to structured
  HTML, which is walked into Univer's document sentinel stream by hand (there
  is no builder API for this — see below); `docx` (the npm package) converts
  an edited snapshot back to a real `.docx`. Keeps paragraphs, bold/italic,
  and **tables** — structure and cell text, verified against real Aquera WSR
  documents including their Action Item and Go-Live Status tables. Does not
  keep headers/footers, images, real numbered-list structure, or table
  borders/shading.

**Univer's document model has no "add a paragraph" builder.** A document body
is one flat string (`dataStream`) plus arrays of metadata pointing at
positions inside it: `\r` ends a paragraph, `\n` ends a section, and a table
is bracketed by a matched pair of unprintable sentinels
(`DataStreamTreeTokenType`, exported from `@univerjs/core` — `TABLE_START`
`\u001a`, `TABLE_ROW_START` `\u001b`, `TABLE_CELL_START` `\u001c`, and their
`_END` counterparts). **`@univerjs/core` exports its own structural validator,
`validateDocBodyStructure()`, and an empty-document template,
`getDocsEmptySnapshot()`** — both plain functions, callable from Node with no
browser involved. Building the sentinel stream by hand and checking it against
that validator *before ever touching a browser* is what made this bridge
possible to get right on the first real try rather than through screenshot
trial-and-error; it caught a real bug immediately (`"Table cell must contain a
paragraph and section break child"` — a cell needs both `\r` **and** `\n`
inside it, not just the paragraph mark).

### Getting Univer to actually render — the two real bugs, in order

Two genuinely separate problems, found one after the other. Both mattered;
fixing only the first still produced a mounted editor with an invisible,
zero-height canvas.

**1. `new Univer({ locale: LocaleType.EN_US })` alone throws
`[LocaleService]: Locale not initialized`.** Every registered plugin ships its
own `locale/en-US` module of UI strings and they must be merged and passed as
`locales: { enUS: merged }` — there is no default. Solved by switching to
`@univerjs/presets`' `createUniver({ presets: [...] })`, which is Univer's own
documented bootstrap and handles this internally; manually calling
`univer.registerPlugin(...)` for each package, which an earlier version of
this file did, is what surfaces this the hard way.

**2. Even mounted correctly via presets, the canvas stayed at zero height,
with every element carrying a class like `univer-flex` computing as
`display: block` instead of `flex`.** The class names were real, in the DOM,
correctly applied by Univer's own JS — but **no CSS rule for them existed
anywhere in the page**. Each `@univerjs/*` package ships this as a genuine,
separate static file, `lib/index.css` — a real stylesheet on disk, not
something injected as a side effect of importing the JS, which is what every
earlier attempt in this file assumed. `components/UniverViewer.jsx` now has
two static, top-level `import '@univerjs/preset-docs-core/lib/index.css'` /
`'@univerjs/preset-sheets-core/lib/index.css'` lines — **static, not inside a
dynamic `import()`**, because webpack only extracts CSS from imports it can
see at build time. This is the fix that actually made `.univer-flex` compute
as `flex`; nothing about container sizing or mount timing was ever the
problem for this half.

**3. Even with CSS loading and the ribbon correctly rendering, the grid
still didn't paint on any page with more than a couple of nesting levels
around it** — it worked on a bare, few-levels-deep test page, and stayed at
zero height on `Approvals` (`Card > CardContent > …`). Confirmed by direct
measurement that this was not a timing race: the mount container's own
computed height was a stable, correct, non-zero pixel value (477px) from the
very first frame, yet Univer's own nested `height: 100%` div one level in
still resolved to a fraction of it (117px), and the actual canvas three levels
deeper got zero. A `window.dispatchEvent(new Event('resize'))` — present in
an earlier version of this file — did nothing, because Univer sizes itself via
`ResizeObserver`, which reacts to an *observed element's own size changing*,
never to a window resize event; that call was inert from the moment it was
written. The fix: give Univer's mount point an **explicit pixel height set via
React state and a `ResizeObserver`** on the wrapper (`UniverViewer.jsx`),
instead of a Tailwind `flex-1` (`flex-basis: 0%`, sized by the flex
algorithm). A flex-basis-derived height, even though it measures correctly at
its own level, does not reliably propagate through Univer's own several levels
of nested `height: 100%` divs once enough non-flex ancestors (`Card`,
`CardContent`) sit above it; an explicit, JS-measured pixel number removes
that ambiguity regardless of what wraps it. Verified end to end against real
generated files: a real Aquera WSR `.docx` (paragraphs, bold, and its Action
Item table, with real row data) and a real `.xlsx` both render and edit
correctly inside `/approvals`.

If `.univer-flex` (or any `univer-*` class) ever again computes as
`display: block` in devtools, the CSS import is the first thing to check —
not the container, not the plugin registration order, not `createUnit`.

**"Where approved files go" is `settings.approvalDestDir`.** Approving a
document (`core/approvals/store.js`, `deliverToDestination()`) copies it
there if set, appending `(1)`, `(2)`, … on a filename collision rather than
overwriting — verified with two same-named files from different customers.
Rejecting never copies. The original stays exactly where the run wrote it;
this is always a copy, never a move. `/api/browse` lists real directories
anywhere on disk (`homedir()` down), a deliberate widening beyond the
`library.roots()` model every other file read in this app uses — it is
read-only (names and directory-ness only, never file contents) and the only
place in the app that works this way.

### `kind: 'cxp_note'` — the one write, gated

CX Portal's `add_note` action is a real, customer-visible POST. Nothing in
this app is allowed to call it except one place: `core/approvals/store.js`'s
`decide()`, and only inside its `status === 'approved'` branch, and only for
an approval with `kind: 'cxp_note'`. `approvals.kind` has no DB-level
constraint — `'document' | 'email'` was only ever a comment — so adding a
third kind needed no schema change, only a new branch in `decide()`.

The chain, end to end: a script calls `warp.cxp.proposeNote({customerName,
text, shareToSlack})` → `core/connectors/cxportal-note.js`'s `proposeNote()`
resolves the customer (read-only, `strong`/`exact` match only, same as
`resolveProject()` always required) and calls `approvals.propose()` — this
step **never posts**, it only creates a `pending` row with the note stashed
as JSON in `body`. The Approvals page shows every pending `cxp_note` row in
an always-visible sidebar section — not gated behind a document being
selected, not behind any status tab, because a script can propose a note
whether or not anything else is pending. A human clicking Approve there is
the **only** thing that calls `postNoteForCustomer()`; clicking Reject never
does. A failed post doesn't undo the approval — same reasoning as
`deliverToDestination()` — it's recorded in the row's `note` field instead
(`ERROR: …`) so it's visible rather than silently lost.

There used to be a per-document "Post a note" button that posted directly on
click, no approval step at all. It's gone — every CX Portal write goes
through the queue now, with no exception for a person typing the note by
hand in the UI. Composing one is a script's job (`warp.cxp.proposeNote()`);
this page's job is only ever to show what's pending and let a human decide.

Verifying this without ever exercising the real write: propose a note for a
customer name guaranteed not to resolve (e.g.
`__no_such_customer_zzz__`), then approve it — `resolveProject()` throws
before `cx.addNote()`/`postAction()` can ever be reached, which proves the
full `decide()` → `postCxpNoteIfApproved()` → `postNoteForCustomer()` wiring
end to end with zero risk of the POST succeeding. This is the same
verification shape `resolveProject()` itself was already proven with.

## Known open items

- `/api/running` and `/api/automation` are polled every 3s by the top bar on
  every page. `/api/automation` does a full `runs` scan plus a `COUNT(*)` on
  `run_events` **per run** — it will get slower as history accumulates. SSE or a
  shared store would be the right fix.
- `ApiEngine` in `core/claude/engine.js` is a deliberate stub. The interface is
  real; the Anthropic adapter needs a tool loop, sandboxing and skill loading
  that the CLI provides for free.
- The `Provisioning` tab is an intentionally empty placeholder. **Do not design
  anything into it** — the spec is still to come.
- Gong access uses a browser session cookie against internal endpoints. Fine
  locally, not shippable to another company; B2B needs the official Gong API.

## Conventions

- Comments explain *why*, especially where something looks wrong but isn't.
  Several comments in this repo are the only record of a bug that cost hours.
- `core/` functions take a plain options object and an `onEvent` callback, never
  `req`/`res`. Route handlers parse, call, serialise — nothing more.
- `legacy/` is reference only. Nothing imports it and nothing there runs.

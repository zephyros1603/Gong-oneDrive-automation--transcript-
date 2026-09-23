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

## Two traps that have already cost time

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

## Digests (`core/workflow/digest.js`) — the token-saving layer

A digest is a compact, Claude-written summary of one customer, standing in
for their raw transcripts and CX Portal rows on every run after the first.
Measured on a real customer: ~5,064 raw tokens → ~933 digest tokens, an 82%
reduction, cached by a content hash of the inputs (`inputsHash()`) so a
digest is rebuilt only when something it was built from actually changed.

**`silent: true` on `startChatRun` exists because of this feature.** A
digest build is a real run — it should stream and be cancellable — but it
must not become a visible turn in the customer's chat, must not steal the
project's stored `sessionId` out from under whatever real conversation is in
progress, and its output must never enter the Approvals queue (an internal
summary is not a document for a person to sign off on). `silent` turns off
exactly those three side effects.

Building the first digest also surfaced a second, more general bug:
**`buildPrompt()` in `claude-runner.js` always pushed the model toward
writing a file**, even with no skill selected and no document wanted — a
plain "summarise this" prompt got a reply about saving to `outputDir` instead
of an actual answer inline. `wantsDocument` (default `true`, so every
existing caller is unaffected) turns that framing off; `silent` runs pass
`wantsDocument: false`. If a run's reply reads like narration about a file it
claims to have written rather than the thing you asked for, check this first.

`project_transcripts.kind` gained a third value, `'digest'`, alongside
`'transcript'` and `'context'` — same table, same reason as before: it has to
survive `syncFromLibrary()`'s prune, which only touches `kind = 'transcript'`.

A workflow scoped to `sources: ['digest']` skips raw transcripts and the CX
Portal render entirely for that run — digest mode is a replacement, not an
addition, which is the whole point.

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

## Approvals: previews, and where an approved file goes

`app/approvals/page.jsx` dispatches by file extension: `.pdf` →
`components/PdfViewer.jsx` (`@pdf-viewer/react` — **the package itself is
marked deprecated by its maintainer**, pointing at a commercial successor at
react-pdf-kit.dev; it still works, it is not receiving updates), `.docx` →
`components/DocxViewer.jsx` (`react-doc-viewer`, view-only — the package does
not write back), `.xlsx` → `components/SpreadsheetViewer.jsx` (Univer,
editable). Everything else keeps the original markdown/text path.

**Two package-specific traps already found and fixed:**

- `@pdf-viewer/react` renders its pages inside a pdf.js Web Worker. Without
  `workerUrl` pointed at a real worker script, the worker fails to load
  *silently* — no page error, a fully-functional toolbar (it already knows
  the page count), and a blank page underneath. The worker file is copied to
  `public/pdf.worker.min.mjs` from `pdfjs-dist` at install time; if pdfjs-dist
  is ever upgraded, re-copy it.
- `react-doc-viewer`'s default export does **not** come with its own
  renderers attached — leaving `pluginRenderers` unset answers every file
  with `No Renderer for file type X`, even though the matching renderer
  ships in the same package. `DocViewerRenderers` must be imported and passed
  explicitly; `DocxViewer.jsx` does this inside one `next/dynamic()` call
  rather than two, because `DocViewerRenderers` is a plain array, not a
  component — wrapping an array in `dynamic()` hands the caller a component
  where a value was expected.

**Univer needs the locale strings assembled by hand.** `new Univer({ locale:
LocaleType.EN_US })` alone throws `[LocaleService]: Locale not initialized`
at runtime — every registered plugin (`@univerjs/sheets-ui`,
`@univerjs/ui`, `@univerjs/sheets-formula-ui`, …) ships its own
`locale/en-US` module of UI strings, and they all have to be `Object.assign`'d
together and passed as `locales: { enUS: merged }`. There is no default.

**Known incomplete: the sheet grid itself does not render.** With locale
fixed, `UniverUIPlugin` mounts and its ribbon/toolbar renders — but the
canvas grid area stays at `height: 0`, and tracing the DOM shows Univer's own
internal render-target div for the sheet body has **zero children**: nothing
ever painted into it. This is not the container-sizing issue it initially
looked like (an inline `height: 520` on the mount container, plus a
`resize` event dispatched on the next frame to nudge Univer's internal
`ResizeObserver`, made no difference) — something in `@univerjs/*@1.0.0-rc.0`
plugin registration or lifecycle is still missing, most likely a required
call or ordering not evident from the type declarations alone. The
`xlsxToSnapshot`/`snapshotToXlsx` bridge (`core/engine/xlsx-bridge.js`) and
the `/api/spreadsheet` GET/POST routes are fully verified independently of
this — round-tripped real cell data correctly. What is unverified is the
in-browser editor's rendering; treat it as not working until someone gets the
grid to paint.

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

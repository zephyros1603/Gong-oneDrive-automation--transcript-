# Gong transcript pull

Downloads transcripts of your Gong calls into per-day folders, using your
browser session cookie against Gong's **internal** app API.

```
transcripts/Sep-3/Options-for-Learning-Paylocity-to-Entra-transcript.md
transcripts/Sep-3/Aquera-Pennrose-implementation-calls-transcript.md
transcripts/Sep-2/Aquera-Bluprintx-Implemetnation-call-transcript.md
```

The Gong layer is still one dependency-free Node module, `gong.js`, usable on
its own from the command line. Around it is a Next.js app — five working tabs
plus a placeholder — backed by SQLite.

## Setup

Everything lives in `gong.env` (gitignored, `chmod 600`). Refresh the cookie
from DevTools → Network → any `app.gong.io` request → **Copy as cURL**, and
lift the `Cookie:` header out of it.

| Key | Meaning |
|---|---|
| `GONG_HOST` | `us-81357.app.gong.io` |
| `GONG_COOKIE` | Session cookie, roughly 16 days — see *Caveats* |
| `GONG_WORKSPACE_ID` | Blank auto-detects. Not global — you have two (below) |
| `GONG_USER_ID` | Blank reads it from the CSRF token |
| `GONG_ACCOUNT_ID` | Gong **account** id, for `gong-calls.sh` |
| `GONG_DAY_FROM` / `GONG_DAY_TO` | Default date range |
| `GONG_FORMAT` | `text` \| `md` \| `srt` \| `vtt` |
| `GONG_OUT_DIR` | Output root for the day folders, default `transcripts` |
| `GONG_SORTED_DIR` | Where `organize.js` writes. Blank = `sorted` **next to** `GONG_OUT_DIR` |
| `GONG_PREVIEW_DIRS` | Extra folders for the preview sidebar, colon-separated |
| `NODE_BIN` | Absolute node path — required, see *Why NODE_BIN* |

Anything already in the environment beats the file, so one-off overrides work:

```bash
GONG_FORMAT=srt ./gong-my-calls.sh --days 3
```

## Commands

```bash
node gong.js me                        # your calls, gong.env date range
node gong.js me 2026-09-01 2026-09-04
node gong.js me --days 7               # trailing week
node gong.js me --dry-run              # show paths, download nothing

node gong.js account                   # activity table for GONG_ACCOUNT_ID
node gong.js account --name "Creative Networking Consulting Limited"
node gong.js account --ids-only        # bare call ids
node gong.js call 2800017128684783250  # specific call(s)
node gong.js workspaces                # list your workspaces
node gong.js help
```

| Option | Effect |
|---|---|
| `--days N` | Trailing N days instead of a from/to range |
| `--dry-run`, `-n` | Print planned paths, download nothing |
| `--out DIR` | Output root, overrides `GONG_OUT_DIR` |
| `--raw DIR` | Raw JSON dir, overrides `GONG_RAW_DIR` |
| `--format F` | `text` \| `md` \| `srt` \| `vtt` |
| `--workspace ID` | Overrides `GONG_WORKSPACE_ID` |
| `--name NAME` | Resolve an account by name (`account`) |
| `--ids-only` | Print bare call ids (`account`) |

Re-running overwrites in place — safe to schedule.

### Where output goes

`GONG_OUT_DIR` is the root for the day folders; `GONG_RAW_DIR` holds the raw
API JSON. Both accept an **absolute path**, a **`~` path**, or a path
**relative to this folder**, and both can be overridden per run:

```bash
node gong.js me --days 7 --out ~/Documents/gong-transcripts
node gong.js me --days 7 --out /Volumes/Archive/gong --raw /tmp/gong-raw
```

```
<GONG_OUT_DIR>/Sep-3/Options-for-Learning-Paylocity-to-Entra-transcript.md
<GONG_RAW_DIR>/5674908648089632113.json
```

`gong.js call <id>` has no search metadata to name a file from, so it reads
the title and date out of the transcript payload itself.

## Web UI

```bash
npm install        # once
npm run build      # once, and after any change
npm start          # http://127.0.0.1:7878
npm run dev        # or, with hot reload
```

Or double-click **Start Gong UI.command**, which does all three.

**`-H 127.0.0.1` is not optional.** `next start` binds `0.0.0.0` by default,
and the loopback bind *is* this app's entire authorization model — there is no
authentication of any kind. It reads your filesystem and holds your Gong
session. The npm scripts and the launcher both pin the host; anything that
starts the server another way must too.

Six tabs across the top:

| Tab | Does |
|---|---|
| **Pull** | The form below: fetch transcripts out of Gong |
| **Workbench** | Turn transcripts into documents with Claude Code |
| **Projects** | A persistent chat per customer |
| **Preview** | The rendered-markdown sidebar |
| **Automation** | Pull → organize → projects, on a schedule |
| **Provisioning** | Empty placeholder — monitored provisioning, still to be specified |

The top bar is shared by all five, so the global **Stop**, the usage total and
the automation status are always visible — a run you started on one tab is
never hidden because you walked away from it.

**Test connection** probes the session in the order things actually fail —
cookie shape, then auth, then workspace listing, then a real filtered search —
and reports which step broke. A cookie can authenticate and still be unable to
search, so the last check is the one that proves the app will work. It also
decodes the cookie's own JWTs to show the account email, the sign-in provider,
and when the session actually expires, and fills in the workspace list on
success so you don't need **Detect** as well.

Every field is prefilled from `gong.env`. Fill the form, hit **Pull
transcripts**, and the options fade out into a live progress view — each call
appears under its day folder with a spinner, then a check, a red cross with
the HTTP error, or an amber skip. Optionally tick **Save back to gong.env** to
persist what you entered (comments preserved, `.bak` written).

It covers everything the CLI does: all three modes, both range styles, the
four namespace IDs, format, output and raw directories, concurrency, and dry
run. A live CLI-equivalent line at the bottom of the form shows the command
your settings correspond to.

The progress scene runs from `gong.png` to `laptop-cut.png`, with the wire
between them doubling as the progress bar and the running count drawn onto the
laptop screen. `laptop-cut.png` exists because the original artwork had its
checkerboard *painted in* at full opacity — dropped straight onto the dark
scene it rendered as a grey checkered block. It was made transparent by
flood-filling inward from the edges, so only edge-connected background is
cleared and the laptop's own white bezel and keys survive.

**Why a server and not a plain HTML file.** The page has to read `gong.env`,
write transcripts to disk, and call Gong's internal API with your session
cookie. A browser can do none of those from a `file://` page or a hosted
origin — CORS blocks the API and there is no filesystem access. So the browser
only renders; `serve.js` does the work, binds to `127.0.0.1` only, and serves
files exclusively out of `ui/`. The cookie never leaves your machine.

## Architecture

Next.js App Router, React 19, SQLite via Drizzle. Three rules hold it together.

**One long-lived Node process, never serverless.** This app spawns `claude`
children that outlive the request that started them, keeps live cancel
closures in memory, and runs a wall-clock scheduler. Vercel and every other
serverless host would break all three. `next start` on a persistent machine is
the only supported way to run it.

**Nothing decides anything in a route handler.** `app/api/**/route.js` parses,
calls a `core/` function, and serialises. The work — the Gong pull, the
connection probe, a chat turn, the pipeline — lives in modules that take a
plain options object and an `onEvent` callback, so the same code runs from a
route, the scheduler, or a CLI. Before the migration ~500 lines of this was
trapped inside `serve.js` and reachable no other way.

**Process-bound state is pinned to `globalThis`.** Next re-evaluates modules on
every edit in dev. A run registry or a child-process map held in a module
binding would be wiped mid-run, orphaning a `claude` process that bills on in
the background. `instrumentation.js` is the one place the scheduler and the
shutdown hooks are installed, guarded by the same flag.

### Fitting the window

The shell is `overflow: hidden` — the panes scroll, the page does not. That is
the right model for an app, and it has one sharp edge: anything wider than the
window is *clipped and unreachable* rather than scrolled to. A six-tab nav and
a fixed-width sidebar did exactly that; below about 700px the Provisioning tab
was simply gone, and browser zoom produces the same effect on a large monitor,
because zoom is only a narrower viewport measured in CSS pixels.

`lib/useResponsive.js` is where those decisions are made rather than guessed:

| Export | Does |
|---|---|
| `useMediaQuery` | One query, via `useSyncExternalStore` so nothing is missed between render and effect |
| `useBreakpoint` | `isPhone` / `isCompact` / `isDesktop`, plus a live width |
| `useResizablePanel` | A drag handle whose width is re-clamped when the *window* resizes, not only while dragging |
| `useDismissable` | Escape closes the thing |

Below `lg` the sidebar stops being a column and becomes an overlay, and the nav
becomes a menu. `components/SidebarLayout.jsx` owns that switch for all three
sidebar pages, so they cannot drift apart again.

Two rules `useResizablePanel` enforces that the hand-rolled splitters did not:
the width is re-clamped on window resize, so a 480px sidebar chosen on a large
monitor cannot survive into a 600px window; and the clamp reserves room for the
main pane, so widening the sidebar can never squeeze the content to nothing.

Verified by rendering the real pages inside fixed-width iframes at 360, 390 and
420px — headless Chrome refuses to open a window narrower than 500px, so a
`--window-size=390` screenshot is a 500px render cropped to 390, which looks
exactly like a layout bug and is not one.


### What persists

`data.db`, a single SQLite file. `gong.env` stays a file: the CLI reads it with
no server running, the Chrome extension writes to it, and it is the one thing
that must be `chmod 600` — credentials do not move into the database.

| Table | Holds |
|---|---|
| `projects`, `project_transcripts`, `messages` | Customers, their files, their chats |
| `runs`, `run_events` | Every event of every run, so replay survives a restart |
| `settings` | The Workbench document — one row, nothing queries inside it |
| `usage` | One row per run; the total is a `SUM`, not a recomputed array |
| `automation_history` | Outcomes, including the days that were skipped |

Transcripts are rows rather than a JSON array on the project, so the organizer
adding one file does not rewrite the project. That whole-document rewrite is
what made the previous JSON store lose concurrent updates silently.

Money is stored as integer micro-dollars. A run costs `$0.096229` — six
significant decimals — and the usage table is only ever summed, which is
exactly where accumulated float error starts to show.

`npm run migrate` imports `projects.json` and `settings.json` into SQLite and
renames the originals `.migrated`. It is idempotent, and it never deletes.

### Following a run

`POST /api/runs` starts one and returns an id; `GET /api/runs/:id/stream`
follows it. They are separate requests on purpose — that is what lets a page
attach, leave, and re-attach.

Detaching does **not** cancel. Closing the tab used to kill the run, which is
why work vanished on a tab switch; now the server records every event and
replays it to whoever attaches, including after a restart. The trade-off is
real and deliberate: a run you walk away from keeps going and keeps costing.
Every run stays visible and stoppable from the top bar, which is what makes
that acceptable.

`lib/useRunStream.js` is the only client that knows how to read the stream. The
vanilla build had four hand-rolled copies of that loop, each handling a
slightly different subset of the events and none handling `finished`.


## Starting it (no terminal needed)

Double-click, in Finder:

| File | Does |
|---|---|
| **Start Gong UI.command** | Starts the server and opens the browser |
| **Stop Gong UI.command** | Stops it and frees the port |

`.command`, not `.sh`: double-clicking a `.sh` opens it in a text editor,
while Finder runs a `.command` in Terminal. Both are plain bash. Finder also
launches them with a bare `PATH`, so the start script finds `node` from
`NODE_BIN` in `gong.env` and falls back to Homebrew and nvm locations.

Starting twice is safe — it reuses the running server rather than fighting
over the port. Logs go to `logs/server.log`, the pid to `.server.pid`. Set
`GONG_UI_PORT` to use a port other than 7878.

## The Chrome extension (getting the cookie without DevTools)

`extension/` is a small Chrome extension so a non-technical user never has to
open DevTools: **sign in to Gong in Chrome as normal, then click the
extension button.** It reads the session and sends it to the running puller,
which verifies it and writes `gong.env` itself.

Install once, per machine:

1. Start the puller (**Start Gong UI.command**).
2. In Chrome open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the `extension/` folder.
5. Pin *Gong Cookie Bridge* to the toolbar.

Then, whenever the session is stale: open Gong, be signed in, click the
extension, click **Send session to puller**. It reports the account, tenant,
how many calls you can see, and the expiry date. If the UI is already open in
a tab, it notices within a few seconds, refills itself and re-tests — no
copy-paste anywhere.

The extension is the only approach that can do this. `g-session` is
`HttpOnly`, so page JavaScript and bookmarklets structurally cannot read it;
`chrome.cookies` is the sole API with access.

### Which cookie actually matters

Determined by dropping cookies one at a time against the live API:

| Cookie | Required? |
|---|---|
| `last-login` | **Yes.** On its own it authenticates *and* searches |
| `g-session` | No — requests succeed without it |
| `cf_clearance` | No — and Chrome often does not have one at all |
| `cell`, `__cf_bm`, `AWSALB` | No |

`last-login` is the session credential: a JWT holding your account email and
the real expiry, which is why **Test connection** can report both without
asking Gong. `cf_clearance` is a Cloudflare challenge cookie that only exists
after a challenge, so requiring it rejects perfectly good sessions — an
earlier version of the extension did exactly that.

The extension still sends every gong.io cookie it finds, because that is what
a browser would do, and only refuses outright when `last-login` is absent
(which means nobody is signed in). Everything past that is the server's
verification to judge, not the extension's.

Safety properties worth knowing:

- The server **verifies before it writes** — a dead session is rejected and
  `gong.env` keeps the cookie that still works.
- `/api/cookie` accepts CORS only from `chrome-extension://` origins, so a web
  page cannot push cookies at the server even though it listens on loopback.
- Nothing leaves the machine: the extension talks to `127.0.0.1` only.

## Preview sidebar

A right-hand panel renders any transcript the way GitHub renders a README.
Open it with **Preview** (top right), or click any output path printed on the
page — in the run progress list, the summary, or the organize results.

It has two modes: a filterable file list grouped by folder, and the rendered
file with a **Copy** button pinned to the top right that copies the original
markdown. Escape closes the panel; the back arrow returns to the list. Below
1020px wide the panel covers the page instead of squeezing it.

The markdown is rendered by a small parser in the page rather than a CDN
library, so the UI keeps working with no network. It escapes the source before
applying any inline rule, so transcript text cannot inject markup, and only
`http(s)`/`mailto` links become anchors. `.srt`, `.vtt` and `.txt` are shown
verbatim — running subtitles through a markdown parser would mangle them.

Both the organizer and the sidebar work off `GONG_OUT_DIR`, so they follow
transcripts stored outside the project folder. If a configured folder is
missing or empty the sidebar names every path it searched, in red, rather than
showing a blank list — a wrong `GONG_OUT_DIR` is then obvious instead of
looking like a broken feature.

`GONG_SORTED_DIR` defaults to `sorted` beside `GONG_OUT_DIR`, not inside the
project, so an external output folder keeps its sorted tree with it. If you
organize somewhere else entirely, set `GONG_SORTED_DIR` (or tick **Save back
to gong.env** in the UI, which now persists it) or the sidebar will not index
it. `GONG_PREVIEW_DIRS` covers any further locations.

Two endpoints back it: `/api/files` lists what is previewable, and
`/api/file?path=` reads one. Both resolve the path and check it against the
output and sorted directories, so a crafted path cannot read anything else —
`/etc/passwd`, `gong.env` and `serve.js` all return 403.

## Organizing transcripts

Downloads are filed by day, which answers "what happened this week" and not
"everything we ever discussed with Pennrose". `organize.js` builds a second
tree from the same files:

```bash
node organize.js                  # by customer, into sorted/
node organize.js --by call        # by call title
node organize.js --dry-run        # print the plan, change nothing
node organize.js --link           # hardlink: no extra disk, edits affect both
node organize.js --move           # relocate, then remove empty day folders
node organize.js --src DIR --out DIR
```

```
transcripts/Sep-3/Aquera-Pennrose-implementation-calls-transcript.md
  → sorted/Pennrose-LLC/Sep-3-Aquera-Pennrose-implementation-calls-transcript.md
```

The same control is in the web UI in **both** places — on the form before a
run, and on the summary after one — with **Preview** (dry run) and
**Organize**. The two stay in sync: change the grouping on one and the other
agrees. Note it regroups the entire output folder, not only the run you just
did.

Every tree `organize.js` writes gets a `.gong-sorted` marker file, and marked
directories are never walked as *source*. Without that, a sorted tree left
inside the source (say `transcripts/sorted/`) is picked up on the next run and
sorted again, multiplying copies — which is exactly what happened here: a run
into `transcripts/sorted/` made the next plan see 66 files instead of 33.

Grouping keys come from the raw API payload (`callCustomers`, `callTitle`),
falling back to the transcript's own header when the raw JSON is missing —
which is what lets `.srt`/`.vtt` files, that carry no header, still be sorted.
Anything unattributable lands in `Unsorted/`. Destination folders that sit
inside the source are skipped, so a second run does not sort its own output.

Copy is the default because it cannot lose anything. `--link` is the efficient
choice once you trust it: one set of bytes, two paths.

## Generating documents (Workbench)

The **Workbench** tab turns transcripts into documents by driving the Claude
Code CLI locally — no API key. `claude -p` runs headless against your existing
subscription, so the only cost is what the subscription already covers.

Pick transcripts on the **Input** side, choose an action, and the **Output**
side fills in as the run streams. Input and Output are one segmented switch
rather than two panes, because on a laptop two half-width panes gave neither
enough room.

| Action | Produces | Skill |
|---|---|---|
| **MOM** | Minutes of meeting + covering email | `aquera-status-reporting` |
| **WSR** | Weekly project status report | `aquera-status-reporting` |
| **MSR** | Monthly project status report | `aquera-status-reporting` |
| **RunBook** | Project runbook | `aquera-project-runbook` — not installed, shows as a blueprint |

Below the actions is a chat box: ask anything, with or without a skill. The
`+` button attaches a skill as a removable pill; attaching files starts a fresh
session deliberately, since replaying a long transcript into an existing
context burns tokens for nothing.

The CLI is invoked as:

```
claude -p <prompt> --output-format stream-json --verbose \
  --append-system-prompt … --add-dir <each source dir> \
  --allowed-tools Read,Glob,Grep,Write,Edit,Bash \
  --permission-mode acceptEdits [--max-turns N] \
  --session-id <new> | --resume <existing>
```

`--add-dir` is what lets Claude read transcripts that live outside this
folder. `acceptEdits` is safe here because the allowed tools and the added
directories are both fixed by the server, not by the model.

**Maximum turns** caps one run. A MOM typically takes 11–13 turns and costs
roughly $0.60–0.80; the floor for a trivial question is $0.02–0.08. Leave it at
0 for no cap, or set it as a circuit-breaker on a run that might loop.

### Covering emails are not files

A MOM used to write its email out as a second `.md`, which meant opening a
file to copy two fields. The system prompt now ends with an instruction to
return the email in the final reply between `=== EMAIL ===` and
`=== END EMAIL ===` markers, and the UI renders whatever sits between them as
a subject/body box with its own Copy button. Nothing touches disk.

### The engine is a choice

Everything goes through the `Engine` interface in `core/claude/engine.js`:

```js
run(opts) -> { jobId, session, cancel() }
```

`CliEngine` is the only implementation, and it is complete: `claude -p` on this
machine, under your subscription, with skills and file writing working because
the CLI already does them. `ApiEngine` is **a deliberate stub**. Reproducing
what the CLI gives free — a tool-use loop with Read/Write/Edit/Glob/Grep/Bash,
a sandbox for them, skill resolution from `~/.claude/skills`, a turn cap and
session resumption — is a project in its own right, and it bills per token
instead of riding a subscription. `GONG_ENGINE=api` selects it and fails loudly
rather than quietly producing nothing.

The point of the interface is that no feature code knows which engine it is
talking to, so that work can happen later without touching anything else.

### Not leaving Claude running

Headless runs bill for as long as they live, so there are three ways to stop
one, in increasing severity:

- **Cancel** on the running job — stops that run.
- **Stop** in the top bar — cancels everything this server started.
- The button beside *Claude CLI ready* — scans the machine for `claude`
  processes, classifies them `app` / `terminal` / `ide`, and kills them. It
  only kills PIDs its own scanner recognised, and it excludes
  `/Applications/Claude.app/` so it can never close the desktop app.

The usage chip in the top bar shows the running total, recorded per run from
the CLI's own cost reporting.

## Projects

The **Projects** tab is one persistent chat per customer, so "what did we
agree with Pennrose" is a conversation you return to rather than a run you
repeat. Projects are created from the customer folders the organizer produces
and matched on the same slug, so organizing is what populates the list.

Each project keeps its transcripts, its message history and its Claude session
id. **New chat** resets just the session id, keeping the history visible while
starting Claude's context fresh.

### Why runs live on the server

Switching tabs used to kill a run, because the work belonged to the page. Runs
are now server-owned (`runs.js`): the server creates a run, buffers every
event, and a subscriber replays the buffer before following live. Leaving the
tab detaches; coming back re-attaches and you see the whole run, including the
parts that happened while you were gone — in-flight analysis, animation state
and output all intact.

The deliberate trade-off is that closing the tab no longer cancels the run.
That is what makes the feature work at all, and it is mitigated by every run
staying visible and stoppable from the top bar.

Chats persist to `projects.json` (gitignored), capped at 400 messages per
project; run buffers are capped at 4000 events and pruned every 15 minutes.

## Automation

The **Automation** tab runs the whole chain on a schedule: **pull from Gong →
organize by customer → feed the transcripts into the projects.**

```
Pulling your calls from the last 3 day(s)
  4 call(s) in 2026-09-11 .. 2026-09-14        4 saved · 0 skipped · 0 failed
Grouping by customer
  21 file(s) into 8 folder(s) · copy
Assigning transcripts to projects
  Bluprintx — 1 new transcript(s)
```

| Setting | Default | Meaning |
|---|---|---|
| Run automatically | off | Master switch |
| Time | 09:00 | Local time slot |
| Days | Mon–Fri | Which days have a slot |
| Pull the last | 2 | Days of calls to fetch |
| Grace window | 20 min | How late the slot may still fire |
| Organize | on, by customer, copy | Group before feeding projects |

**Run now** does the same thing on demand, and both paths share one code
path, so the manual button genuinely tests the scheduled one.

### It will not wake your Mac

The timer is a `setInterval` inside this server, not a launchd job and not
`pmset`. That is the whole point: while the Mac is asleep the server is not
running, the slot simply passes, and nothing is queued to fire on wake.

This is the opposite of the launchd approach described under *Scheduling on a
Mac that sleeps*, which deliberately catches up on wake. Both are here because
they answer different questions — "don't disturb me" versus "never miss a
day". If you want the second, install the plist; if you want the first, use
this tab and leave the plist uninstalled.

A slot that passes is recorded as missed rather than silently forgotten, and
the history list shows skipped days alongside completed runs, so an empty
folder is never a mystery. `graceMinutes` is what decides the boundary: wake
within the window and the run still happens; wake three hours late and the day
is marked missed and the scheduler waits for the next one.

## The three ID namespaces

Easy to conflate, and they are not interchangeable:

| ID | Example | What it scopes |
|---|---|---|
| Company (tenant) | `3295967034453654596` | The whole Gong instance |
| **Workspace** | `2175491490980408935` | A slice of calls. **You have two** |
| **Account** | `8432685238695217670` | One CRM account, all reps, all activity types |
| Call | `2800017128684783250` | One call |
| User (you) | `4837246324148864338` | Read from the CSRF token |

Your workspaces:

| ID | Name |
|---|---|
| `2175491490980408935` | Customer Engagement |
| `3811476788007240356` | Revenue Operations — restricted, search returns an error |

`gong-calls.sh` is **account**-scoped (`/ajax/account/day-activities`) and
returns everyone's activity for that account. `gong-my-calls.sh` is
**user**-scoped and returns calls you were on. Different questions, different
endpoints.

## The API, as reverse-engineered

Discovered by mining `/r/js/dist/search.js` (17 MB) and probing the live API.

**Your calls in a date range** — note this is a POST with a *JSON* body:

```
POST /conversations/ajax/results?workspace-id={ws}
{"callsSearchJson":"<serialized filter tree>","pageSize":100,"callsOffset":0}
```

Required headers. Gong 400s with a bare `{"error":true}` if any is missing,
which is a misleading way to say "your headers are wrong, not your filter":

- `cookie`
- `X-CSRF-TOKEN` — from `GET /ajax/common/rtkn`
- `referer: https://{host}/conversations?workspace-id={ws}`
- `origin: https://{host}`
- `content-type: application/json` — **form-encoded is rejected**

Filter tree:

```json
{"search": {"type": "And", "filters": [...]}, "sort": null}
```

Confirmed filter shapes:

| Filter | Shape |
|---|---|
| Date range | `{"type":"AbsoluteCallDateRange","from":"YYYY-MM-DD","to":"YYYY-MM-DD"}` |
| Trailing N days | `{"type":"RelativeCallTime","unit":"DAYS","last":7}` |
| You, any role | `{"type":"Participants","userIds":["<id>"],"host":true,"attendee":true,"invitee":true}` |
| Account | `{"type":"AccountCrmId","phrase":"<salesforce id>"}` |
| Contact | `{"type":"ContactEmail","phrase":"<email>"}` |

Two gotchas found the hard way:

- `Participants` takes **`userIds`**, not `ids`. With `ids` it 400s; with
  `userIds` but no `host`/`attendee`/`invitee` flags it returns 0 rather than
  erroring — a silent wrong answer.
- An empty `filters` array is invalid. For "no filter" send `"search":null`.

Useful response fields per call: `id`, `title`, `callStatus`,
`effectiveStartDateTime` (`YYYY/MM/DD HH:MM:SS`, the day-folder source),
`duration`, `ownerName`, `userCanAccess`.

Paginate with `callsOffset` until you have `numOfTotalItemsThatPassedFilter`.

**Transcript for one call:**

```
GET /call/detailed-transcript?call-id={callId}
```

## Scheduling on a Mac that sleeps

This is the *catch up on wake* option. If you would rather the Mac were never
disturbed and missed days simply passed, use the **Automation** tab instead
and leave the plist uninstalled — the two approaches are compared there.

Two separate mechanisms — most setups only get the first right.

**What fires the job.** `launchd`, not `cron`. With
`StartCalendarInterval`, a run missed while asleep fires on the next wake;
`cron` skips it entirely and waits a full day.

The plist runs `node gong.js me --days 2` daily at 09:00.

```bash
cp legacy/automation/com.sanjan.gong-transcript.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.sanjan.gong-transcript.plist
launchctl start com.sanjan.gong-transcript      # test it now
tail -f logs/gong.err.log
```

**What wakes the Mac** — only needed if you want it at 09:00 sharp rather
than on next wake. Separate mechanism, needs `sudo`:

```bash
sudo pmset repeat wake MTWRFSU 08:58:00
pmset -g sched                                  # verify
```

`wake` works on battery; `wakeorpoweron` also covers a powered-off Mac but
requires AC. On Apple Silicon with the lid **closed** and no external power or
display, scheduled wakes are unreliable.

### Why the plist uses an absolute node path

`node` is at `~/.nvm/versions/node/v20.20.2/bin/node`. nvm is set up in
`.zshrc`, which non-login shells and launchd never read — so a bare `node`
resolves interactively and then fails under launchd. The plist invokes node by
full path for that reason.

## Caveats

**The cookie expires, but not as fast as first assumed.** Measured on a live
session: the `cell` and `last-login` JWTs carry an expiry about **16 days**
out, and a `cf_clearance` three days old still authenticated fine. The
short-lived CSRF token is re-fetched on every run, so it never matters. What
does end a session early is signing in again elsewhere, which rotates
`g-session`. Use **Test connection** to see the real expiry rather than
guessing — it decodes it from the cookie itself.

So a scheduled daily job is realistic for a couple of weeks per refresh, and
the Chrome extension makes refreshing a single click. For genuinely
hands-off operation, switch to the public API — `us-81357.api.gong.io`,
Basic auth from an access key, no expiry:

```
POST /v2/calls/extensive     # list calls, cursor-paginated
POST /v2/calls/transcript    # {"filter":{"callIds":["<id>"]}}
```

`gongTranscript.js` would keep working; only the fetch layer changes.

**Internal endpoints.** `/conversations/ajax/results` and
`/ajax/account/day-activities` are undocumented and tied to UI releases. They
can change without notice.

**19-digit IDs.** Gong call IDs exceed `Number.MAX_SAFE_INTEGER`, and
`JSON.parse` rounds them *silently*. `gongTranscript.js` quotes them before
parsing — pass it raw JSON text, never a pre-parsed object. `jq` preserves
unmodified integer literals verbatim, so the shell pipeline is safe.

**Bash 3.2.** macOS `/bin/bash` is 3.2 — no associative arrays, no `${x,,}`.

## Files

| File | Role |
|---|---|
| `gong.js` | Everything: auth, search, pagination, download, foldering |
| `organize.js` | Regroups transcripts by customer or call |
| `library.js` | One view of what is on disk: roots, listing, reading, saving |
| `claude-runner.js` | Spawns `claude -p`, tracks jobs, kills strays |
| `runs.js` | Server-owned runs: record, replay, subscribe, cancel |
| `projects.js` | Per-customer projects and their chat history |
| `automation.js` | The scheduler and the pull → organize → projects pipeline |
| `settings.js` | Workbench state, actions and usage totals |
| `core/gong/` | `pull`, `diagnose`, `cookie` — the Gong work, free of HTTP |
| `core/chat.js` | One chat turn, as a server-owned run |
| `core/claude/engine.js` | The engine interface: CLI now, API adapter later |
| `core/db/` | Drizzle schema, the SQLite handle, and the JSON importer |
| `core/http.js` | `json`, `readBody`, SSE framing, the extension's CORS |
| `instrumentation.js` | Starts the scheduler and the shutdown hooks, once |
| `app/` | Next App Router: six pages and ~27 route handlers |
| `components/` | TopBar, Composer, PullScene, and the shared pieces |
| `lib/` | `useRunStream`, the markdown renderer, the formatters |
| `data.db` | Everything that persists. Gitignored |
| `public/assets/` | Scene artwork: `gong.png`, `laptop-cut.png` (trimmed) |
| `gongTranscript.js` | Renderer: text / md / srt / vtt. Imported by `gong.js` |
| `gong.env` | Config + cookie. Gitignored, `chmod 600` |
| `legacy/` | Three superseded generations: bash, vanilla, launchd. Nothing imports it |
| `Start Gong UI.command` | Double-click to start the server and open the UI |
| `Stop Gong UI.command` | Double-click to stop it |
| `extension/` | Chrome extension that sends the session to the puller |

## Notes on the port

`gong.js` replaces `gong-lib.sh`, `gong-my-calls.sh`, `gong-calls.sh`,
`fetch.sh` and `pagedata.py`, and was verified to produce **byte-identical**
output to the bash version on the same date range.

`serve.js` imports `gong.js` rather than shelling out to it, which is why
`gong.js` only runs its CLI when invoked directly.

Two things the bash version got for free and the port had to handle
explicitly:

- **`jq` preserved 19-digit IDs**; `JSON.parse` does not. Every response is
  parsed through `parseBig()`, which quotes 16+ digit integer values on the
  key/value boundary before parsing.
- **A composite Outlook meeting ID** (`3295…596.0400…`) can appear on a
  MEETING activity. It is a calendar entry with no Gong recording, so
  `--ids-only` filters to bare numeric IDs and reports the count it dropped.

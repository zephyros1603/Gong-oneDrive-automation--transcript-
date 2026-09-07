# Gong transcript pull

Downloads transcripts of your Gong calls into per-day folders, using your
browser session cookie against Gong's **internal** app API.

```
transcripts/Sep-3/Options-for-Learning-Paylocity-to-Entra-transcript.md
transcripts/Sep-3/Aquera-Pennrose-implementation-calls-transcript.md
transcripts/Sep-2/Aquera-Bluprintx-Implemetnation-call-transcript.md
```

Everything is one Node script, `gong.js` — no dependencies beyond Node 20+.

## Setup

Everything lives in `gong.env` (gitignored, `chmod 600`). Refresh the cookie
from DevTools → Network → any `app.gong.io` request → **Copy as cURL**, and
lift the `Cookie:` header out of it.

| Key | Meaning |
|---|---|
| `GONG_HOST` | `us-81357.app.gong.io` |
| `GONG_COOKIE` | Session cookie. Expires in hours — see *Caveats* |
| `GONG_WORKSPACE_ID` | Blank auto-detects. Not global — you have two (below) |
| `GONG_USER_ID` | Blank reads it from the CSRF token |
| `GONG_ACCOUNT_ID` | Gong **account** id, for `gong-calls.sh` |
| `GONG_DAY_FROM` / `GONG_DAY_TO` | Default date range |
| `GONG_FORMAT` | `text` \| `md` \| `srt` \| `vtt` |
| `GONG_OUT_DIR` | Output root, default `transcripts` |
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
node serve.js            # http://127.0.0.1:7878
node serve.js --port 9000
```

Every field is prefilled from `gong.env`. Fill the form, hit **Pull
transcripts**, and the options fade out into a live progress view — each call
appears under its day folder with a spinner, then a check, a red cross with
the HTTP error, or an amber skip. Optionally tick **Save back to gong.env** to
persist what you entered (comments preserved, `.bak` written).

It covers everything the CLI does: all three modes, both range styles, the
four namespace IDs, format, output and raw directories, concurrency, and dry
run. A live CLI-equivalent line at the bottom of the form shows the command
your settings correspond to.

**Why a server and not a plain HTML file.** The page has to read `gong.env`,
write transcripts to disk, and call Gong's internal API with your session
cookie. A browser can do none of those from a `file://` page or a hosted
origin — CORS blocks the API and there is no filesystem access. So the browser
only renders; `serve.js` does the work, binds to `127.0.0.1` only, and serves
files exclusively out of `ui/`. The cookie never leaves your machine.

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

Two separate mechanisms — most setups only get the first right.

**What fires the job.** `launchd`, not `cron`. With
`StartCalendarInterval`, a run missed while asleep fires on the next wake;
`cron` skips it entirely and waits a full day.

The plist runs `node gong.js me --days 2` daily at 09:00.

```bash
cp com.sanjan.gong-transcript.plist ~/Library/LaunchAgents/
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

**The cookie is the real constraint.** `cf_clearance` and `g-session` expire in
hours. A scheduled job works for a day or two, then logs `no CSRF token —
cookie in gong.env is expired` every morning until you re-copy it. For
genuinely unattended use, switch to the public API — `us-81357.api.gong.io`,
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
| `serve.js` | Local web server for the UI (loopback only) |
| `ui/index.html` | The web UI — form, progress animation, summary |
| `gongTranscript.js` | Renderer: text / md / srt / vtt. Imported by `gong.js` |
| `gong.env` | Config + cookie. Gitignored, `chmod 600` |
| `com.sanjan.gong-transcript.plist` | launchd schedule |
| `legacy-bash/` | The superseded bash/python version. Safe to delete |

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

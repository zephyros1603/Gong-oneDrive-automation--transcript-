# legacy/

Three superseded generations of this project, kept for reference. **None of it
runs, and nothing above this folder imports any of it** — it is here because
some of it records how things were worked out, not because it is a fallback.

| | Was | Replaced by |
|---|---|---|
| `bash/` | The original bash + python pipeline | `gong.js` |
| `vanilla/` | The zero-dependency `node:http` server and hand-written HTML | the Next.js app |
| `automation/` | A launchd agent that ran the pull on a schedule | the **Automation** tab |

## bash/

`gong-lib.sh`, `gong-my-calls.sh`, `gong-calls.sh`, `fetch.sh` and
`pagedata.py`. `gong.js` was verified to produce **byte-identical** output to
these on the same date range before they were retired.

Two things they got for free that the port had to handle explicitly: `jq`
preserves 19-digit call ids that `JSON.parse` silently rounds (hence
`parseBig()`), and a composite Outlook meeting id can appear on a MEETING
activity with no Gong recording behind it.

## vanilla/

`serve.js` — a single 1,229-line `node:http` if-chain — plus five hand-written
HTML pages with inline `<script type="module">` and no build step. See
`vanilla/NOTES.md`. It would not start now even if you wanted it to: the
storage layer it imports moved to SQLite and `startChatRun` moved to
`core/chat.js`.

## automation/

`com.sanjan.gong-transcript.plist`, a launchd agent running
`node gong.js me --days 2` at 09:00.

Worth keeping because it answers a **different question** from the Automation
tab, not an obsolete one:

- **launchd** (this): a slot missed while the Mac slept fires on the next wake.
  Never miss a day, at the cost of a run starting whenever you happen to open
  the lid. Needs installing into `~/Library/LaunchAgents`, and the plist must
  invoke node by absolute path — launchd never reads `.zshrc`, so nvm's `node`
  is not on its `PATH`.
- **The Automation tab**: a timer inside the server, which therefore cannot
  wake the Mac and lets a slot pass unrun while it sleeps. Don't disturb me, at
  the cost of a missed day.

Pick one. Running both would pull twice.

To install this one:

```bash
cp legacy/automation/com.sanjan.gong-transcript.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.sanjan.gong-transcript.plist
```

## Deleting this

Safe whenever you stop wanting the history. `bash/` and `vanilla/` are pure
reference. `automation/` is the only folder holding something you might still
choose to use.

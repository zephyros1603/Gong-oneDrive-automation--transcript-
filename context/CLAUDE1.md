# Session Context — Gong Transcript Extraction & Conversion

**Date:** 3 September 2026
**Environment:** Claude web chat, Claude in Chrome browser tooling, Linux container (Python 3, Node v22.22.2)
**Subject call:** "Aquera / Pennrose: implementation calls" — 2 Sep 2026, 55 min, Microsoft Teams
**Gong instance:** `us-81357.app.gong.io`

---

## 1. Objective

Two requests, in sequence:

1. Open a Gong call link in Chrome, identify the API endpoint that serves the call transcript, and produce a working `curl` command with the required parameters.
2. Given the downloaded JSON payload, produce a reusable converter that renders it as readable text — first in Python, then ported to JavaScript.

---

## 2. Endpoint discovery

### Method

1. Opened the Gong call page in a managed Chrome tab.
2. Started network capture and reloaded. Initial load produced ~368 requests, mostly video-snapshot images — no transcript call among them.
3. Clicked the **Transcript** tab. The transcript rendered on screen but **no new XHR fired**, ruling out lazy-loading on tab-click and indicating the data arrives during initial page load.
4. Fetched and searched the app bundle `/r/js/dist/call.js` for transcript-related string literals. This surfaced the route `/call/detailed-transcript`.
5. Probed the endpoint directly from the page context with three candidate shapes (GET with query param, POST JSON, POST form-encoded) to determine the correct method and parameter form.

### Result

```
GET https://us-81357.app.gong.io/call/detailed-transcript?call-id={CALL_ID}
```

| Property | Value |
|---|---|
| Method | `GET` |
| Parameters | `call-id` (single query param) |
| Auth | Gong web session cookie |
| CSRF token | Not required |
| `tkn` param | Not required |
| Custom headers | None required |
| Verified response | HTTP 200, ~492 KB JSON, 170 monologues |

The POST variants were unnecessary; the plain GET succeeded.

---

## 3. The curl command

```bash
curl 'https://us-81357.app.gong.io/call/detailed-transcript?call-id=2800017128684783250' \
  -H 'accept: application/json, text/plain, */*' \
  -H 'referer: https://us-81357.app.gong.io/call?id=2800017128684783250' \
  -H 'cookie: PASTE_YOUR_GONG_SESSION_COOKIE_HERE' \
  --compressed \
  -o transcript.json
```

**On the cookie placeholder.** Gong's session cookies are `HttpOnly`, so they are not readable from page JavaScript, and handling a live session credential in plaintext was avoided by design. To fill it in: DevTools → Network → reload the call page → right-click the `detailed-transcript` request → **Copy → Copy as cURL**. That yields the exact cookie header, after which only the `call-id` needs swapping for other calls.

Quick flattening with `jq`:

```bash
jq -r '.monologues[] | "[\(.timestampStr)] \(.speakerName): \(.text)"' transcript.json
```

### Caveats raised

- `/call/detailed-transcript` is Gong's **internal** app route, not a documented API. It can change without notice, and the cookie expires with the browser session.
- For anything automated, the supported path is the public API:
  `POST https://us-81357.api.gong.io/v2/calls/transcript`
  with Basic auth from an access key and body `{"filter":{"callIds":["<id>"]}}`.
  An **Aquera Gong** connector already points at that host, avoiding cookie handling entirely.

---

## 4. Payload structure

Top-level keys:

```
companyId, callCompanyName, callId, callTitle, callCustomers,
callOrganizerName, recorded, when, callMeetingProvider, monologues,
shortNamesLookup, companyParticipants, customerParticipants,
unknownParticipants, durationHours, durationMinutes, topics,
extraTopics, language, languageDisplayName, canBeTranslated,
targetLanguages, translationDetails, isInHouseTranscript
```

Each entry in `monologues`:

| Field | Notes |
|---|---|
| `speakerName` | Short name, e.g. `"Sanjan"` |
| `speakerId` | **String** in the payload, e.g. `"7024234891420842113"` |
| `timestamp` | Start, in seconds (float) |
| `timestampStr` | Pre-formatted, e.g. `"0:46"` |
| `text` | Raw ASR text |
| `monologueWords.terms[]` | Per-word `start` / `end` / `text` / `type` (`WORD` or `PUNCTUATION`) / `confidence` |
| `startingTopic` / `endingTopic` | Present but `null` throughout this file |

Supporting structures:

- `shortNamesLookup` — `{speakerId: shortName}`, e.g. `{"7024234891420842113": "Sanjan"}`
- `companyParticipants` — array of `{fullName, companyName, title}`
- `customerParticipants` — object keyed by company name, each value an array of the same shape
- `topics` — separate array of `{name, start, firstOfTopic}`; **not** cross-referenced by the monologues

### Observations that shaped the converter

1. **Monologues are over-split.** The file holds 170 monologue objects but only **105 real speaker turns** — Gong fragments one continuous stretch of speech across several entries. A naive loop produces choppy output. 65 entries are consecutive-same-speaker continuations.
2. **No end timestamp on monologues.** End time must be derived from the last `end` value in `monologueWords.terms`.
3. **Participant lists ≠ speakers.** Navin Kumar is listed as a participant but never speaks, so full-name resolution needs a fallback.
4. **ASR punctuation is unreliable.** Sentences split across speakers mid-phrase (e.g. `"...What's up, John? How?"` / `"Are you doing?"`). Deliberately not repaired — guessing at sentence boundaries would risk altering what was said. Only whitespace and space-before-punctuation are normalised.
5. **`topics` is not usable as section headers** without separate timestamp-matching logic, since `startingTopic`/`endingTopic` are null.

---

## 5. Deliverables

| File | Purpose |
|---|---|
| `gong_transcript.py` | Python converter — CLI + importable functions |
| `gongTranscript.js` | JavaScript port — Node CLI, ESM module, browser helper |
| `call_transcript.txt` | The subject call rendered as plain text (26,371 chars) |

Both converters were verified to produce **byte-identical** output on the source file.

### Shared feature set

- Output formats: `text`, `md`, `srt`, `vtt`
- Merges consecutive same-speaker monologues (defeatable)
- Optional full-name resolution: `"Sanjan"` → `"Sanjan Athyady (Aquera)"`
- Toggleable timestamps and metadata header
- `extractTurns()` exposes structured turns (`speaker`, `start`, `end`, `time`, `text`) for downstream use
- Accepts a file path, a JSON string, or a parsed object

### Python usage

```bash
python gong_transcript.py transcript.json -o call.txt
python gong_transcript.py transcript.json -f md --full-names
python gong_transcript.py transcript.json -f srt -o call.srt
python gong_transcript.py transcript.json --no-timestamps --no-header
```

```python
from gong_transcript import convert, extract_turns, load

text = convert("transcript.json")
md   = convert("transcript.json", fmt="md", full_names=True)

for t in extract_turns(load("transcript.json")):
    print(t["speaker"], t["time"], t["text"])
```

### JavaScript usage

```bash
node gongTranscript.js transcript.json -o call.txt
node gongTranscript.js transcript.json -f md --full-names
node gongTranscript.js transcript.json -f srt -o call.srt
node gongTranscript.js transcript.json --no-timestamps --no-header
```

```js
import { readFileSync } from 'node:fs';
import { convert, extractTurns, load } from './gongTranscript.js';

const raw = readFileSync('transcript.json', 'utf8');
const text = convert(raw);
const md   = convert(raw, { format: 'md', fullNames: true });

for (const t of extractTurns(load(raw))) {
  console.log(t.speaker, t.time, t.text);
}
```

Direct from a signed-in Gong tab, via DevTools console:

```js
const { fetchTranscript } = await import('/path/to/gongTranscript.js');
console.log(await fetchTranscript('2800017128684783250'));
```

---

## 6. Bug found during testing — big-integer precision

The first Node run printed the call ID as `2800017128684783000` instead of `2800017128684783250`.

**Cause.** Gong's IDs are 19-digit integers, exceeding `Number.MAX_SAFE_INTEGER` (9,007,199,254,740,991). `JSON.parse` rounds them **silently** — no error, no warning. Python has arbitrary-precision integers, so the same logic was correct there and the issue only appeared on the port.

**Fix.** `load()` accepts the raw JSON *text* and quotes long integer values on the ID keys before parsing:

```js
const BIG_ID_KEYS = /"(callId|companyId|speakerId|id)"\s*:\s*(\d{16,})/g;
JSON.parse(source.replace(BIG_ID_KEYS, '"$1":"$2"'));
```

`fetchTranscript` was changed from `res.json()` to `res.text()` for the same reason.

**Consequence for callers.** Pass raw text, not a pre-parsed object. Calling `JSON.parse` yourself destroys the digits before `load()` can protect them, and nothing downstream can recover them. This applies to any JavaScript written against this API, not just this converter.

**Not affected:** speaker-name resolution. `speakerId` on each monologue is already a string in Gong's payload, so the `shortNamesLookup` join was never at risk.

---

## 7. Open items / next steps

- Consider migrating to the public Gong API (`/v2/calls/transcript`) via the existing Aquera Gong connector for any recurring or automated extraction.
- If topic segmentation is wanted in output, it requires matching `topics[].start` strings against monologue timestamps — `startingTopic`/`endingTopic` cannot be relied on.
- The Chrome tab with the call page was left open during the session.

---

## Appendix — reference

**Call metadata**

| Field | Value |
|---|---|
| Title | Aquera / Pennrose: implementation calls |
| Call ID | 2800017128684783250 |
| Date | 2 Sep 2026 |
| Duration | 55 min |
| Account | Pennrose, LLC |
| Organizer | Claire Franz |
| Platform | Microsoft Teams |
| Language | eng |
| Monologues / turns | 170 / 105 |

**Participants**

- Sanjan Athyady — Integration Engineer, Aquera *(speaker)*
- Navin Kumar — Lead Technical Consultant, Aquera *(listed, does not speak)*
- Will Flynn — IT Systems Technician, Pennrose, LLC *(speaker)*

**Note on the original link.** The URL supplied at the start of the session was a Gong "call ready" email notification link carrying an `email-descriptor` token plus `xtid` and tracking parameters. Those are omitted here — they are session/tracking material and are not needed. The canonical form is:

```
https://us-81357.app.gong.io/call?id=2800017128684783250
```
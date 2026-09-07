#!/bin/bash
#
# Fetch Gong call transcripts and render them with gongTranscript.js.
#
#   ./fetch.sh 2800017128684783250            # one call
#   ./fetch.sh id1 id2 id3                    # several
#   ./fetch.sh                                # every id in calls.txt
#
# Config (host, cookie, output dir, format) lives in ./gong.env — not in
# .zshrc, so nothing leaks into interactive shells. Run under launchd for
# scheduling; see README.md.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

[[ -f gong.env ]] || { echo "fetch.sh: missing $HERE/gong.env" >&2; exit 78; }
# shellcheck disable=SC1091
source ./gong.env

: "${GONG_HOST:?set GONG_HOST in gong.env}"
: "${GONG_COOKIE:?set GONG_COOKIE in gong.env}"
OUT_DIR="${GONG_OUT_DIR:-transcripts}"
FORMAT="${GONG_FORMAT:-text}"

# launchd hands us a bare PATH, so locate node rather than assuming it.
NODE="${NODE_BIN:-$(command -v node || true)}"
[[ -x "$NODE" ]] || { echo "fetch.sh: node not found; set NODE_BIN in gong.env" >&2; exit 78; }

ext() { case "$1" in md) echo md;; srt) echo srt;; vtt) echo vtt;; *) echo txt;; esac; }

# Call ids: command line wins, otherwise calls.txt (blank lines and #… ignored).
ids=("$@")
if [[ ${#ids[@]} -eq 0 ]]; then
  [[ -f calls.txt ]] || { echo "fetch.sh: no call ids given and no calls.txt" >&2; exit 64; }
  while read -r line; do
    line="${line%%#*}"; line="${line//[[:space:]]/}"
    [[ -n "$line" ]] && ids+=("$line")
  done < calls.txt
fi
[[ ${#ids[@]} -gt 0 ]] || { echo "fetch.sh: nothing to do" >&2; exit 0; }

mkdir -p "$OUT_DIR" raw
failed=0

for id in "${ids[@]}"; do
  raw="raw/$id.json"
  out="$OUT_DIR/$id.$(ext "$FORMAT")"

  # -f alone hides the body on 4xx/5xx, so capture the status instead and
  # keep the response for diagnosis. An expired cookie shows up as 302/403.
  status=$(curl -sS --compressed --max-time 120 \
    -w '%{http_code}' -o "$raw" \
    "https://$GONG_HOST/call/detailed-transcript?call-id=$id" \
    -H 'accept: application/json, text/plain, */*' \
    -H "referer: https://$GONG_HOST/call?id=$id" \
    -H "cookie: $GONG_COOKIE" || echo 000)

  if [[ "$status" != 200 ]]; then
    echo "[$id] HTTP $status — cookie in gong.env is probably expired" >&2
    failed=$((failed + 1))
    continue
  fi

  # Gong answers a signed-out request with the login HTML at 200, so confirm
  # we actually got the transcript payload before rendering.
  if ! head -c 1 "$raw" | grep -q '{'; then
    echo "[$id] response is not JSON (signed out?) — see $raw" >&2
    failed=$((failed + 1))
    continue
  fi

  "$NODE" gongTranscript.js "$raw" -f "$FORMAT" --full-names -o "$out"
  echo "[$id] $out"
done

[[ $failed -eq 0 ]] || { echo "fetch.sh: $failed of ${#ids[@]} call(s) failed" >&2; exit 1; }

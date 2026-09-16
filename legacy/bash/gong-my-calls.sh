#!/bin/bash
#
# Download transcripts of *your own* calls, foldered by day.
#
#   ./gong-my-calls.sh                        # date range from gong.env
#   ./gong-my-calls.sh 2026-09-01 2026-09-04
#   ./gong-my-calls.sh --days 7               # trailing week
#   ./gong-my-calls.sh --dry-run              # list what it would fetch
#
# Layout:
#   transcripts/Sep-3/Options-for-Learning-Paylocity-to-Entra-transcript.md
#   transcripts/Sep-4/Aquera-Bluprintx-Implemetnation-call-transcript.md
#
# "Your calls" means calls you were on — host, attendee or invitee — resolved
# from the user id inside the CSRF token, so nothing is hardcoded. This is
# user-scoped, unlike gong-calls.sh which is account-scoped.

source "$(dirname "${BASH_SOURCE[0]}")/gong-lib.sh"

DRY=0; DAYS=''
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run|-n) DRY=1; shift ;;
    --days)       DAYS="${2:?--days needs a number}"; shift 2 ;;
    -h|--help)    sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)            args+=("$1"); shift ;;
  esac
done

gong_init

if [[ -n "$DAYS" ]]; then
  FROM=$(date -v-"${DAYS}"d '+%Y-%m-%d'); TO=$(date '+%Y-%m-%d')
else
  FROM="${args[0]:-${GONG_DAY_FROM:-$(date -v-7d '+%Y-%m-%d')}}"
  TO="${args[1]:-${GONG_DAY_TO:-$(date '+%Y-%m-%d')}}"
fi

OUT_DIR="${GONG_OUT_DIR:-transcripts}"
EXT=$(gong_ext "$FORMAT")

echo "your calls · $FROM .. $TO · workspace $WS · user $ME" >&2

filters=$(jq -cn --argjson me "$(gong_filter_me)" --argjson d "$(gong_filter_dates "$FROM" "$TO")" '[$me,$d]')
calls=$(gong_search "$filters")

[[ -n "$calls" ]] || { echo "no calls found in that range" >&2; exit 0; }
echo "found $(printf '%s\n' "$calls" | grep -c .) call(s)" >&2
echo >&2

ok=0; skipped=0; failed=0
# macOS ships bash 3.2, which has no associative arrays — a newline-delimited
# list of claimed paths does the same job here.
taken=''

while IFS= read -r call; do
  [[ -n "$call" ]] || continue

  id=$(jq -r '.id|tostring' <<<"$call")
  title=$(jq -r '.title // "Untitled call"' <<<"$call")
  status=$(jq -r '.status // ""' <<<"$call")
  started=$(jq -r '.started // ""' <<<"$call")
  access=$(jq -r '.access' <<<"$call")

  day=$(gong_dayfolder "$started")
  slug=$(gong_slug "$title")
  dir="$OUT_DIR/$day"
  out="$dir/${slug}-transcript.$EXT"

  # Two calls can share a title on the same day (recurring meetings). Only
  # then disambiguate with a slice of the call id — keyed on what this run has
  # already claimed, so re-running overwrites in place instead of piling up
  # suffixed duplicates.
  if printf '%s' "$taken" | grep -Fxq "$out"; then
    out="$dir/${slug}-${id: -6}-transcript.$EXT"
  fi
  taken="$taken$out
"

  if (( DRY )); then
    printf '%-7s %-10s %s\n' "$day" "$status" "$out"
    continue
  fi

  if [[ "$status" != COMPLETED ]]; then
    echo "$day  ~ $title — $status, no transcript" >&2
    skipped=$((skipped + 1)); continue
  fi
  if [[ "$access" != true ]]; then
    echo "$day  ~ $title — no access" >&2
    skipped=$((skipped + 1)); continue
  fi

  mkdir -p "$dir" raw
  if gong_transcript "$id" "raw/$id.json" && gong_render "raw/$id.json" "$out"; then
    echo "$day  ✓ $out"
    ok=$((ok + 1))
  else
    echo "$day  ✗ $title ($id)" >&2
    failed=$((failed + 1))
  fi
done <<<"$calls"

echo >&2
echo "$ok saved · $skipped skipped · $failed failed" >&2
[[ $failed -eq 0 ]]

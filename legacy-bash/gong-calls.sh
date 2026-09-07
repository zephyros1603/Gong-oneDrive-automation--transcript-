#!/bin/bash
#
# List Gong call IDs for an account over a date range.
#
#   ./gong-calls.sh                          # GONG_ACCOUNT_ID + date range from gong.env
#   ./gong-calls.sh 8432685238695217670
#   ./gong-calls.sh 8432685238695217670 2026-01-01 2026-09-04
#   ./gong-calls.sh --name "Creative Networking Consulting Limited"
#   ./gong-calls.sh --ids-only                # bare ids, pipe into ./fetch.sh
#   ./gong-calls.sh --workspaces              # list workspaces and exit
#
# "Account id" here is the *Gong account id* (a CRM account, e.g.
# 8432685238695217670) — not your user id and not the call id. It scopes
# /ajax/account/day-activities, which returns every activity for that account
# across all reps: emails, calls and meetings.

source "$(dirname "${BASH_SOURCE[0]}")/gong-lib.sh"

IDS_ONLY=0
NAME=''
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ids-only)   IDS_ONLY=1; shift ;;
    --workspaces) gong_init; gong_workspaces; exit 0 ;;
    --name)       NAME="${2:?--name needs an account name}"; shift 2 ;;
    -h|--help)    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)            args+=("$1"); shift ;;
  esac
done

gong_init

ACCOUNT="${args[0]:-${GONG_ACCOUNT_ID:-}}"
FROM="${args[1]:-${GONG_DAY_FROM:-$(date -v-30d '+%Y-%m-%d')}}"
TO="${args[2]:-${GONG_DAY_TO:-$(date '+%Y-%m-%d')}}"

# Resolve a name to an account id via the global typeahead.
if [[ -n "$NAME" ]]; then
  ACCOUNT=$(gong_get "/search-box/ajax/fetch-suggestions?workspace-id=$WS&q=$(
      jq -rn --arg q "$NAME" '$q|@uri')&t=false" \
    | jq -r '.CRM_ACCOUNT[0].id // empty')
  [[ -n "$ACCOUNT" ]] || { echo "no account matched: $NAME" >&2; exit 1; }
  echo "resolved \"$NAME\" -> $ACCOUNT" >&2
fi

[[ -n "$ACCOUNT" ]] || {
  echo "no account id: pass one, set GONG_ACCOUNT_ID in gong.env, or use --name" >&2
  exit 64
}

echo "account $ACCOUNT  ·  $FROM .. $TO  ·  workspace $WS" >&2

resp=$(gong_get "/ajax/account/day-activities?id=$ACCOUNT&day-from=$FROM&day-to=$TO&type=ACCOUNT&workspace-id=$WS")

printf '%s' "$resp" | jq -e 'type=="object"' >/dev/null 2>&1 || {
  echo "unexpected response — cookie expired? $(printf '%s' "$resp" | head -c 120)" >&2
  exit 1
}

# Each day maps to an array of activities; on a CALL/MEETING the activity's own
# `id` IS the Gong call id (verified against /call?id=<id>).
if (( IDS_ONLY )); then
  printf '%s' "$resp" | jq -r '
    to_entries[] | .value[]
    | select(.type=="CALL" or .type=="MEETING")
    | select(.status=="COMPLETED") | .id'
else
  printf '%s' "$resp" | jq -r '
    ["DATE","TYPE","STATUS","CALL_ID","TITLE"],
    (to_entries | sort_by(.key)[] as $d | $d.value[]
      | select(.type=="CALL" or .type=="MEETING")
      | [$d.key, .type, .status, (.id|tostring),
         (.extendedData.title // .title // "")])
    | @tsv' | column -t -s $'\t'

  printf '%s' "$resp" | jq -r '
    [to_entries[].value[]] as $a
    | "\n\($a|length) activities · "
      + ([$a[]|select(.type=="EMAIL")]|length|tostring) + " email · "
      + ([$a[]|select(.type=="CALL" or .type=="MEETING")]|length|tostring) + " call/meeting"' >&2
fi

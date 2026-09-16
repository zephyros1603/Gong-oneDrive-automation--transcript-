#!/bin/bash
#
# Shared plumbing for the Gong scripts. Sourced, not run.
#
# Everything here talks to Gong's *internal* app API using your browser
# session cookie. Undocumented, tied to UI releases, and the cookie expires —
# fine for local pulls, fragile for anything unattended. See README.md.

set -euo pipefail

GONG_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

gong_init() {
  cd "$GONG_LIB_DIR"

  [[ -f gong.env ]] || { echo "missing $GONG_LIB_DIR/gong.env" >&2; exit 78; }

  # Sourcing would clobber anything the caller pre-set, so a one-off override
  # like `GONG_DAY_FROM=2026-01-01 ./gong-my-calls.sh` would be silently
  # ignored. Snapshot first, then restore whatever arrived from the
  # environment so it wins over the file.
  local v pre_
  for v in GONG_HOST GONG_COOKIE GONG_WORKSPACE_ID GONG_USER_ID \
           GONG_ACCOUNT_ID GONG_DAY_FROM GONG_DAY_TO \
           GONG_OUT_DIR GONG_FORMAT GONG_PAGE_SIZE NODE_BIN; do
    eval "pre_$v=\${$v:-}"
  done

  # shellcheck disable=SC1091
  source ./gong.env

  for v in GONG_HOST GONG_COOKIE GONG_WORKSPACE_ID GONG_USER_ID \
           GONG_ACCOUNT_ID GONG_DAY_FROM GONG_DAY_TO \
           GONG_OUT_DIR GONG_FORMAT GONG_PAGE_SIZE NODE_BIN; do
    eval "if [[ -n \${pre_$v:-} ]]; then $v=\$pre_$v; fi"
  done

  : "${GONG_HOST:?set GONG_HOST in gong.env}"
  : "${GONG_COOKIE:?set GONG_COOKIE in gong.env}"

  H="https://$GONG_HOST"
  WS="${GONG_WORKSPACE_ID:-}"
  FORMAT="${GONG_FORMAT:-md}"

  for bin in curl jq; do
    command -v "$bin" >/dev/null || { echo "$bin not found" >&2; exit 78; }
  done

  # launchd hands the job a bare PATH, so never assume a bare `node` resolves.
  NODE="${NODE_BIN:-$(command -v node || true)}"
  [[ -x "$NODE" ]] || { echo "node not found; set NODE_BIN in gong.env" >&2; exit 78; }

  # /ajax/common/rtkn returns a short-lived CSRF token whose payload also
  # carries our own user id — so "my calls" needs no hardcoded id.
  local rtkn
  rtkn=$(curl -sS --max-time 30 -H "cookie: $GONG_COOKIE" "$H/ajax/common/rtkn") \
    || { echo "cannot reach $GONG_HOST" >&2; exit 69; }

  CSRF=$(printf '%s' "$rtkn" | jq -r '.token // empty')
  [[ -n "$CSRF" ]] || { echo "no CSRF token — cookie in gong.env is expired" >&2; exit 77; }

  ME="${GONG_USER_ID:-$(gong_jwt_field "$CSRF" userId)}"
  [[ -n "$ME" ]] || { echo "could not determine your user id" >&2; exit 77; }

  [[ -n "$WS" ]] || WS=$(gong_default_workspace)
  [[ -n "$WS" ]] || { echo "set GONG_WORKSPACE_ID in gong.env" >&2; exit 78; }
}

# Decode a JWT payload field without extra tooling. base64url -> base64.
gong_jwt_field() {
  local payload
  payload=$(printf '%s' "$1" | cut -d. -f2 | tr '_-' '/+')
  # base64 needs the padding restored before it will decode.
  while (( ${#payload} % 4 )); do payload+='='; done
  printf '%s' "$payload" | base64 -d 2>/dev/null | jq -r ".$2 // empty"
}

# The conversations page embeds window.pageData, which lists every workspace
# you can see. First entry is the default.
gong_default_workspace() {
  curl -sS --compressed --max-time 40 -H "cookie: $GONG_COOKIE" \
    "$H/conversations" 2>/dev/null \
  | grep -oE '"workspaces":\[\{"id":"[0-9]+"' | head -1 \
  | grep -oE '[0-9]{10,}' | head -1
}

gong_workspaces() {
  curl -sS --compressed --max-time 40 -H "cookie: $GONG_COOKIE" "$H/conversations" \
  | python3 "$GONG_LIB_DIR/pagedata.py" workspaces
}

# POST to an internal endpoint. Gong rejects these without BOTH a matching
# referer and origin, on top of the CSRF header — that combination is not
# optional and a missing one shows up as a bare {"error":true} 400.
gong_post() {
  local path="$1" body="$2"
  curl -sS --max-time 120 -X POST \
    -H "cookie: $GONG_COOKIE" \
    -H "X-CSRF-TOKEN: $CSRF" \
    -H "referer: $H/conversations?workspace-id=$WS" \
    -H "origin: $H" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/plain, */*' \
    -d "$body" \
    "$H$path"
}

gong_get() {
  curl -sS --compressed --max-time 120 \
    -H "cookie: $GONG_COOKIE" \
    -H 'accept: application/json, text/plain, */*' \
    -H "referer: $H/home" \
    "$H$1"
}

# --- call search -----------------------------------------------------------
#
# POST /conversations/ajax/results with a serialized filter tree:
#   {"search":{"type":"And","filters":[...]},"sort":null}
#
# Filter shapes confirmed against the live API:
#   {"type":"AbsoluteCallDateRange","from":"YYYY-MM-DD","to":"YYYY-MM-DD"}
#   {"type":"Participants","userIds":["<id>"],"host":true,"attendee":true,"invitee":true}
#   {"type":"AccountCrmId","phrase":"<salesforce id>"}
# An empty filters array is invalid — use "search":null for no filter.

# gong_search <filters-json-array> -> newline-delimited compact call objects
gong_search() {
  local filters="$1" offset=0 page="${GONG_PAGE_SIZE:-100}" total='' got body chunk
  local search
  if [[ "$filters" == '[]' ]]; then
    search='{"search":null,"sort":null}'
  else
    search=$(jq -cn --argjson f "$filters" '{search:{type:"And",filters:$f},sort:null}')
  fi

  while :; do
    body=$(jq -cn --arg s "$search" --argjson o "$offset" --argjson p "$page" \
      '{callsSearchJson:$s,pageSize:$p,callsOffset:$o}')
    chunk=$(gong_post "/conversations/ajax/results?workspace-id=$WS" "$body")

    if ! printf '%s' "$chunk" | jq -e '.items' >/dev/null 2>&1; then
      echo "search failed at offset $offset: $(printf '%s' "$chunk" | head -c 200)" >&2
      return 1
    fi

    [[ -n "$total" ]] || total=$(printf '%s' "$chunk" | jq -r '.numOfTotalItemsThatPassedFilter')

    # -c keeps each call on one line; jq leaves the 19-digit ids untouched, so
    # they survive as exact integers (see the big-int note in gongTranscript.js).
    printf '%s' "$chunk" | jq -c '.items[] | {
      id, title, status: .callStatus,
      started: .effectiveStartDateTime,
      duration, owner: .ownerName,
      access: .userCanAccess
    }'

    got=$(printf '%s' "$chunk" | jq -r '.items | length')
    offset=$(( offset + got ))
    (( got > 0 && offset < total )) || break
  done
}

gong_filter_dates() {
  jq -cn --arg f "$1" --arg t "$2" \
    '{type:"AbsoluteCallDateRange",from:$f,to:$t}'
}

gong_filter_me() {
  jq -cn --arg me "$ME" \
    '{type:"Participants",userIds:[$me],host:true,attendee:true,invitee:true}'
}

# --- transcripts -----------------------------------------------------------

# gong_transcript <call-id> <raw-json-path> — returns 0 on a usable payload.
gong_transcript() {
  local id="$1" raw="$2" status
  status=$(curl -sS --compressed --max-time 120 -w '%{http_code}' -o "$raw" \
    -H "cookie: $GONG_COOKIE" \
    -H 'accept: application/json, text/plain, */*' \
    -H "referer: $H/call?id=$id" \
    "$H/call/detailed-transcript?call-id=$id" || echo 000)

  if [[ "$status" != 200 ]]; then
    echo "  ! HTTP $status" >&2
    return 1
  fi
  # A signed-out request comes back as login HTML at status 200, so confirm we
  # actually got JSON before handing it to the renderer.
  if ! head -c 1 "$raw" | grep -q '{'; then
    echo "  ! not JSON (session expired?)" >&2
    return 1
  fi
  return 0
}

gong_render() {
  local raw="$1" out="$2"
  "$NODE" gongTranscript.js "$raw" -f "$FORMAT" --full-names -o "$out" 2>/dev/null
}

gong_ext() {
  case "${1:-text}" in md) echo md;; srt) echo srt;; vtt) echo vtt;; *) echo txt;; esac
}

# "Aquera / Pennrose: implementation calls" -> "Aquera-Pennrose-implementation-calls"
gong_slug() {
  printf '%s' "$1" \
  | tr -cs '[:alnum:]' '-' \
  | sed -e 's/--*/-/g' -e 's/^-//' -e 's/-$//' \
  | cut -c1-90
}

# "2026/09/03 10:30:00" -> "Sep-3"
gong_dayfolder() {
  local d="${1%% *}"
  [[ -n "$d" ]] || { echo "unknown-date"; return; }
  date -j -f '%Y/%m/%d' "$d" '+%b-%d' 2>/dev/null | sed 's/-0/-/' \
    || echo "${d//\//-}"
}

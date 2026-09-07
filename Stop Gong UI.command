#!/bin/bash
#
# Double-click to stop the Gong transcript puller.

cd "$(dirname "$0")" || exit 1

PORT="${GONG_UI_PORT:-7878}"
PIDFILE=".server.pid"

pause() { echo; read -n 1 -s -r -p "Press any key to close this window."; echo; }

printf '\n  Stopping Gong Transcript Puller\n'
printf '  ───────────────────────────────\n\n'

stopped=0

if [[ -f "$PIDFILE" ]]; then
  pid=$(cat "$PIDFILE")
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null
    for _ in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.2
    done
    # Escalate only if it ignored the polite request.
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
    echo "  ✓ stopped (pid $pid)"
    stopped=1
  else
    echo "  · stale pid file, cleaning up"
  fi
  rm -f "$PIDFILE"
fi

# Catch a server started some other way (npm run ui, a second copy).
#
# -sTCP:LISTEN is not optional here: without it lsof also returns processes
# holding *client* connections to this port, and this block would kill the
# user's browser.
leftover=$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null)
if [[ -n "$leftover" ]]; then
  echo "  · also freeing port $PORT"
  # shellcheck disable=SC2086
  kill $leftover 2>/dev/null; sleep 0.5
  leftover=$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null)
  # shellcheck disable=SC2086
  [[ -n "$leftover" ]] && kill -9 $leftover 2>/dev/null
  echo "  ✓ port $PORT freed"
  stopped=1
fi

if [[ $stopped -eq 0 ]]; then
  echo "  · nothing was running on port $PORT"
fi

if curl -s -o /dev/null -m 1 "http://127.0.0.1:$PORT/api/pulse"; then
  echo "  ✕ something is still answering on port $PORT"
else
  printf '\n  Port %s is clear.\n' "$PORT"
fi

pause

#!/bin/bash
#
# Double-click to start the Gong transcript puller.
#
# .command rather than .sh: double-clicking a .sh opens it in a text editor,
# while Finder runs a .command in Terminal. Both are plain bash.

cd "$(dirname "$0")" || exit 1

PORT="${GONG_UI_PORT:-7878}"
PIDFILE=".server.pid"
LOG="logs/server.log"
NEXT="node_modules/.bin/next"

# Finder launches this with a bare PATH, so nvm is not set up. Find node the
# same way gong.env does, then fall back to common install locations.
find_node() {
  if [[ -f gong.env ]]; then
    local pinned
    pinned=$(sed -n "s/^NODE_BIN='\\(.*\\)'.*/\\1/p" gong.env | head -1)
    [[ -x "$pinned" ]] && { echo "$pinned"; return; }
  fi
  command -v node 2>/dev/null && return
  for c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do
    [[ -x "$c" ]] && { echo "$c"; return; }
  done
}

pause() { echo; read -n 1 -s -r -p "Press any key to close this window."; echo; }

printf '\n  Gong Transcript Puller\n'
printf '  ──────────────────────\n\n'

NODE=$(find_node)
if [[ -z "$NODE" ]]; then
  echo "  ✕ Node.js not found."
  echo "    Install it from https://nodejs.org, or set NODE_BIN in gong.env."
  pause; exit 1
fi
echo "  node     $("$NODE" --version) at $NODE"

# The app is a Next.js server now, so it needs its dependencies installed and
# a production build present. Both are one-off, but a fresh clone has neither.
if [[ ! -d node_modules ]]; then
  echo "  setup    installing dependencies (one-off, a few minutes)…"
  if ! "$NODE" "$(dirname "$NODE")/npm" install >> "$LOG" 2>&1; then
    echo "  ✕ npm install failed. Last lines of the log:"
    tail -15 "$LOG" | sed 's/^/    /'
    pause; exit 1
  fi
fi

if [[ ! -d .next ]]; then
  echo "  setup    building the app (one-off, about a minute)…"
  mkdir -p logs
  if ! "$NODE" "$NEXT" build >> "$LOG" 2>&1; then
    echo "  ✕ The build failed. Last lines of the log:"
    tail -20 "$LOG" | sed 's/^/    /'
    pause; exit 1
  fi
fi

# Already running? Reuse it rather than starting a second one on a busy port.
if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "  status   already running (pid $(cat "$PIDFILE"))"
  open "http://127.0.0.1:$PORT"
  echo "  opened   http://127.0.0.1:$PORT"
  pause; exit 0
fi

# -sTCP:LISTEN matters: a plain "lsof -ti tcp:PORT" also matches *client*
# connections, so an open browser tab would look like a busy port.
if lsof -ti "tcp:$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "  ✕ Port $PORT is already in use by another program."
  echo "    Run 'Stop Gong UI.command', or set GONG_UI_PORT to a free port."
  pause; exit 1
fi

mkdir -p logs
# nohup + setsid-style detach so closing the Terminal window leaves it running.
# -H 127.0.0.1 is load-bearing: next start binds 0.0.0.0 by default, and the
# loopback bind *is* this app's entire authorization model. There is no auth.
nohup "$NODE" "$NEXT" start -H 127.0.0.1 -p "$PORT" >> "$LOG" 2>&1 &
echo $! > "$PIDFILE"

# Wait for it to actually accept connections before opening the browser.
for _ in $(seq 1 40); do
  if curl -s -o /dev/null -m 1 "http://127.0.0.1:$PORT/api/pulse"; then
    echo "  status   running (pid $(cat "$PIDFILE"))"
    echo "  log      $(pwd)/$LOG"
    open "http://127.0.0.1:$PORT"
    echo "  opened   http://127.0.0.1:$PORT"
    printf '\n  Leave this running. To stop it, double-click "Stop Gong UI.command".\n'
    pause; exit 0
  fi
  sleep 0.25
done

echo "  ✕ The server did not start. Last lines of the log:"
echo
tail -15 "$LOG" 2>/dev/null | sed 's/^/    /'
rm -f "$PIDFILE"
pause; exit 1

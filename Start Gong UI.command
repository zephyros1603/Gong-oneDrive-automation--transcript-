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
nohup "$NODE" serve.js --port "$PORT" >> "$LOG" 2>&1 &
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

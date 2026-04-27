#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
export PORT="${PORT:-5002}"
export FLASK_RELOADER=0
PY="${PYTHON:-/usr/bin/python3}"

force_free_port() {
  local port="$1"
  command -v lsof >/dev/null 2>&1 || return 0
  local pids
  pids="$(lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  [[ -z "$pids" ]] && return 0
  echo "[network_coverage] Force-killing listener(s) on port ${port}: $(echo "$pids" | tr '\n' ' ')"
  # shellcheck disable=SC2086
  kill -9 $pids 2>/dev/null || true
  sleep 0.2
}

while true; do
  if [[ "${START_NO_KILL_PORT:-}" != "1" ]]; then
    force_free_port "$PORT"
  fi
  echo "[network_coverage] http://127.0.0.1:${PORT}/ (Ctrl+C to stop)"
  "$PY" app.py || true
  echo "[network_coverage] exited — restarting in 1s…"
  sleep 1
done

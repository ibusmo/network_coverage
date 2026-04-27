#!/usr/bin/env bash
# One-shot dev server: http://127.0.0.1:5002/  (override with PORT=8080 ./start.sh)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# Kill anything listening on $1 (SIGKILL). No-op if lsof missing or port free.
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

# On macOS prefer the system framework Python — it lives in a signed .app bundle so
# CoreLocation can actually prompt for Location Services, which modern CoreWLAN now
# requires to return SSIDs/BSSIDs. A venv python is a thin shim without that bundle
# identity and silently gets redacted results. Override with START_USE_VENV=1.
if [[ "$(uname -s)" == "Darwin" && "${START_USE_VENV:-}" != "1" && -x /usr/bin/python3 ]]; then
  PY=/usr/bin/python3
  echo "[network_coverage] Using system Python (needed for macOS Location → real SSIDs)."
else
  # Prefer project .venv on non-macOS or when START_USE_VENV=1; create on first run if missing.
  if [[ "${START_NO_VENV:-}" != "1" && ! -x "$ROOT/.venv/bin/python" ]] && command -v python3 >/dev/null 2>&1; then
    echo "[network_coverage] Creating .venv (set START_NO_VENV=1 to use system Python)…"
    python3 -m venv "$ROOT/.venv"
  fi

  if [[ -x "$ROOT/.venv/bin/python" ]]; then
    PY="$ROOT/.venv/bin/python"
  elif command -v python3 >/dev/null 2>&1; then
    PY=python3
  else
    PY=python
  fi
fi

need_pip=0
if ! "$PY" -c "import flask" 2>/dev/null; then
  need_pip=1
fi
if [[ "$(uname -s)" == "Darwin" ]] && ! "$PY" -c "import CoreWLAN" 2>/dev/null; then
  need_pip=1
fi
if [[ "$need_pip" == "1" ]]; then
  echo "[network_coverage] Installing requirements (Flask + macOS CoreWLAN if needed)…"
  # System /usr/bin/python3 has read-only site-packages; install into user site instead.
  if [[ "$PY" == "/usr/bin/python3" ]]; then
    "$PY" -m pip install --user -r "$ROOT/requirements.txt"
  else
    "$PY" -m pip install -r "$ROOT/requirements.txt"
  fi
fi

export PORT="${PORT:-5002}"
if [[ "${START_NO_KILL_PORT:-}" != "1" ]]; then
  force_free_port "$PORT"
fi
echo "[network_coverage] http://127.0.0.1:${PORT}/  (Ctrl+C to stop)"
echo "[network_coverage] Python edits in this folder auto-reload the server (FLASK_RELOADER=1)."
if [[ "$(uname -s)" == "Darwin" ]]; then
  echo "[network_coverage] SSID enrich runs Apple’s airport binary (not on PATH)."
fi
exec "$PY" "$ROOT/app.py"

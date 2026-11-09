#!/usr/bin/env bash
# Start the proxy.
#
# --factory defers config loading to app construction, so importing the module (in
# tests) never requires a config file on disk.
#
#   ./start.sh                        # foreground on 127.0.0.1:4000
#   LLM_PROXY_PORT=4001 ./start.sh
#   ./start.sh --reload               # extra args pass through to uvicorn
set -euo pipefail
cd "$(dirname "$0")"

PYTHON="${PYTHON:-.venv/bin/python}"
CONFIG="${LLM_PROXY_CONFIG:-proxy.yaml}"
HOST="${LLM_PROXY_HOST:-127.0.0.1}"
PORT="${LLM_PROXY_PORT:-4000}"

if [[ ! -x "$PYTHON" ]]; then
  echo "no interpreter at $PYTHON" >&2
  echo "  python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'" >&2
  echo "(a venv hard-codes absolute paths — if you moved this directory, delete" >&2
  echo " .venv and recreate it rather than reusing it)" >&2
  exit 1
fi

if [[ ! -f "$CONFIG" ]]; then
  echo "no config at $CONFIG" >&2
  exit 1
fi

# Uvicorn's own "address already in use" fires *after* it prints "startup complete",
# which reads like the server came up and then died of something unrelated. Check
# first and say what is actually holding the port.
if command -v ss >/dev/null 2>&1 && ss -ltn "sport = :$PORT" 2>/dev/null | grep -q ":$PORT"; then
  echo "port $PORT is already in use." >&2
  if command -v curl >/dev/null 2>&1 &&
     curl -sf --max-time 2 "http://$HOST:$PORT/healthz" >/dev/null 2>&1; then
    echo "It is an llm-proxy, and it is healthy — you probably want to just use it:" >&2
    echo "  curl http://$HOST:$PORT/healthz" >&2
    echo "To restart it instead:" >&2
  else
    echo "Something else is listening there. To see what:" >&2
    echo "  ss -ltnp 'sport = :$PORT'" >&2
    echo "To take the port:" >&2
  fi
  echo "  kill \$(ss -ltnpH \"sport = :$PORT\" | grep -oP 'pid=\\K[0-9]+' | head -1)" >&2
  echo "Or run on another port:  LLM_PROXY_PORT=4001 $0" >&2
  exit 1
fi

LLM_PROXY_CONFIG="$CONFIG" exec "$PYTHON" -m uvicorn llm_proxy.main:create_app \
  --factory --host "$HOST" --port "$PORT" \
  --log-level "${LLM_PROXY_LOG_LEVEL:-info}" "$@"

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-3001}"
SERVICE_URL="http://${HOST}:${PORT}"
LOCAL_HEALTH_URL="${SERVICE_URL}/api/health"
RUNTIME_DIR="${TMPDIR:-/tmp}/pi-web-ui-tailscale"
WEB_PID=""
SERVE_PID=""
TAILSCALED_PID=""
TAILSCALE_STATUS_JSON=""
TAILSCALE_SOCKET=""
TAILSCALE=(tailscale)

cleanup() {
  local exit_code=$?

  if [[ -n "$SERVE_PID" ]] && kill -0 "$SERVE_PID" 2>/dev/null; then
    kill "$SERVE_PID" 2>/dev/null || true
  fi

  if [[ -n "$WEB_PID" ]] && kill -0 "$WEB_PID" 2>/dev/null; then
    kill "$WEB_PID" 2>/dev/null || true
  fi

  if [[ -n "$TAILSCALED_PID" ]] && kill -0 "$TAILSCALED_PID" 2>/dev/null; then
    kill "$TAILSCALED_PID" 2>/dev/null || true
  fi

  wait "$SERVE_PID" 2>/dev/null || true
  wait "$WEB_PID" 2>/dev/null || true
  wait "$TAILSCALED_PID" 2>/dev/null || true
  exit "$exit_code"
}

trap cleanup EXIT INT TERM

require_command() {
  local name="$1"

  if ! command -v "$name" >/dev/null 2>&1; then
    echo "$name is required but was not found in PATH" >&2
    exit 1
  fi
}

wait_for_health() {
  local name="$1"
  local url="$2"
  local attempts="$3"
  local body=""

  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if body="$(curl --fail --location --silent --show-error --max-time 5 "$url" 2>/dev/null)" && [[ "$body" == *'"ok":true'* ]]; then
      echo "${name} health check passed: ${url}"
      return 0
    fi

    sleep 1
  done

  echo "${name} health check failed: ${url}" >&2
  return 1
}

get_tailscale_status() {
  "${TAILSCALE[@]}" status --json 2>/dev/null
}

read_tailscale_backend_state() {
  printf '%s' "$1" | python3 -c 'import json, sys; print(json.load(sys.stdin).get("BackendState", ""))'
}

read_tailscale_dns_name() {
  printf '%s' "$1" | python3 -c 'import json, sys; print((json.load(sys.stdin).get("Self") or {}).get("DNSName", "").rstrip("."))'
}

start_user_mode_tailscaled() {
  require_command tailscaled

  mkdir -p "$RUNTIME_DIR"
  TAILSCALE_SOCKET="${RUNTIME_DIR}/tailscaled.sock"
  local tailscaled_log="${RUNTIME_DIR}/tailscaled.log"

  rm -f "$TAILSCALE_SOCKET"

  echo "Tailscale system daemon is not reachable; starting user-mode tailscaled..."
  tailscaled --tun=userspace-networking --socket="$TAILSCALE_SOCKET" >"$tailscaled_log" 2>&1 &
  TAILSCALED_PID=$!
  TAILSCALE=(tailscale --socket "$TAILSCALE_SOCKET")

  for ((attempt = 1; attempt <= 20; attempt++)); do
    if [[ -S "$TAILSCALE_SOCKET" ]]; then
      return 0
    fi

    if ! kill -0 "$TAILSCALED_PID" 2>/dev/null; then
      echo "tailscaled exited before creating its socket. Log: ${tailscaled_log}" >&2
      exit 1
    fi

    sleep 0.25
  done

  echo "tailscaled did not create its socket: ${TAILSCALE_SOCKET}. Log: ${tailscaled_log}" >&2
  exit 1
}

ensure_tailscale_running() {
  local backend_state=""

  if ! TAILSCALE_STATUS_JSON="$(get_tailscale_status)"; then
    start_user_mode_tailscaled
  fi

  for ((attempt = 1; attempt <= 30; attempt++)); do
    if TAILSCALE_STATUS_JSON="$(get_tailscale_status)"; then
      backend_state="$(read_tailscale_backend_state "$TAILSCALE_STATUS_JSON")"

      if [[ "$backend_state" == "Running" ]]; then
        return 0
      fi

      if [[ "$backend_state" == "NeedsLogin" ]]; then
        echo "Tailscale needs login." >&2
        if [[ -n "$TAILSCALE_SOCKET" ]]; then
          echo "Run: tailscale --socket '$TAILSCALE_SOCKET' up" >&2
        else
          echo "Run: tailscale up" >&2
        fi
        exit 1
      fi
    fi

    sleep 1
  done

  echo "Tailscale did not reach Running state. Last state: ${backend_state:-unknown}" >&2
  if [[ -n "$TAILSCALE_SOCKET" ]]; then
    echo "User-mode tailscaled log: ${RUNTIME_DIR}/tailscaled.log" >&2
  fi
  exit 1
}

require_command bun
require_command curl
require_command python3
require_command tailscale

ensure_tailscale_running

TAILSCALE_DNS_NAME="$(read_tailscale_dns_name "$TAILSCALE_STATUS_JSON")"
PUBLIC_URL=""
if [[ -n "$TAILSCALE_DNS_NAME" ]]; then
  PUBLIC_URL="https://${TAILSCALE_DNS_NAME}"
fi

echo "Building Pi web UI..."
(cd "$ROOT_DIR" && bun run build)

echo "Starting Pi web UI on ${SERVICE_URL}..."
(
  cd "$ROOT_DIR"
  HOST="$HOST" PORT="$PORT" bun run start
) &
WEB_PID=$!

wait_for_health "Local web UI" "$LOCAL_HEALTH_URL" 30

echo "Starting Tailscale Serve for ${SERVICE_URL}..."
"${TAILSCALE[@]}" serve --yes "$SERVICE_URL" &
SERVE_PID=$!

sleep 1
if ! kill -0 "$SERVE_PID" 2>/dev/null; then
  wait "$SERVE_PID"
fi

if [[ -n "$PUBLIC_URL" ]]; then
  echo "Pi web UI is available on your tailnet at ${PUBLIC_URL}"
else
  echo "Tailscale Serve started. Run '${TAILSCALE[*]} serve status' to see the tailnet URL."
fi
echo "Press Ctrl+C to stop the web UI and Tailscale Serve."

if [[ -n "$TAILSCALED_PID" ]]; then
  wait -n "$WEB_PID" "$SERVE_PID" "$TAILSCALED_PID"
else
  wait -n "$WEB_PID" "$SERVE_PID"
fi

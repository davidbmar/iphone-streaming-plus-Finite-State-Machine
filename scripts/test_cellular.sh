#!/usr/bin/env bash
#
# test_cellular.sh — Start a Cloudflare Tunnel and print QR code for
# iPhone testing over cellular (AT&T, etc).
#
# Requires: cloudflared (brew install cloudflared)
#
# Usage: bash scripts/test_cellular.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8080}"
LOG_DIR="$REPO_ROOT/logs"
LOG_FILE="$LOG_DIR/server.log"
TUNNEL_LOG="$LOG_DIR/cloudflared.log"

mkdir -p "$LOG_DIR"

echo "=== Cellular Test (Cloudflare Tunnel) ==="

# ── Check cloudflared ─────────────────────────────────────────
if ! command -v cloudflared >/dev/null 2>&1; then
  echo "ERROR: cloudflared not found"
  echo "  Install: brew install cloudflared"
  exit 1
fi
echo "  cloudflared: $(cloudflared --version 2>&1 | head -1)"

# ── Check/start server ───────────────────────────────────────
if ! lsof -i :"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "  Starting server on 0.0.0.0:$PORT..."
  cd "$REPO_ROOT"
  /usr/bin/python3 -m gateway.server > "$LOG_FILE" 2>&1 &
  SERVER_PID=$!
  echo "  Server PID: $SERVER_PID"

  for i in $(seq 1 10); do
    if lsof -i :"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "  Server ready"
      break
    fi
    sleep 0.5
  done

  if ! lsof -i :"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "ERROR: Server failed to start. Check $LOG_FILE"
    exit 1
  fi
else
  echo "  Server already running on port $PORT"
fi

# ── Start cloudflared tunnel ─────────────────────────────────
TUNNEL_CONFIG="$REPO_ROOT/.tunnel-config"

if [ -f "$TUNNEL_CONFIG" ]; then
  # Named tunnel (permanent URL)
  # shellcheck disable=SC1090
  source "$TUNNEL_CONFIG"
  echo "  Using named tunnel: $TUNNEL_NAME"
  echo "  Starting Cloudflare Tunnel..."
  cloudflared tunnel --url "http://localhost:$PORT" run "$TUNNEL_NAME" > "$TUNNEL_LOG" 2>&1 &
  CF_PID=$!
  echo "  cloudflared PID: $CF_PID"
  TUNNEL_URL="$TUNNEL_URL"

  echo "  Waiting for tunnel to connect..."
  for i in $(seq 1 30); do
    if grep -q "Registered tunnel connection" "$TUNNEL_LOG" 2>/dev/null; then
      break
    fi
    sleep 1
  done

  if ! grep -q "Registered tunnel connection" "$TUNNEL_LOG" 2>/dev/null; then
    echo "WARNING: Tunnel may not be fully connected yet."
    echo "  Check: $TUNNEL_LOG"
  fi
else
  # Quick tunnel (random URL)
  echo "  No named tunnel found. Using quick tunnel."
  echo "  Tip: run 'bash scripts/setup_tunnel.sh' for a permanent URL."
  echo ""
  echo "  Starting Cloudflare Tunnel..."
  cloudflared tunnel --ha-connections 4 --url "http://localhost:$PORT" > "$TUNNEL_LOG" 2>&1 &
  CF_PID=$!
  echo "  cloudflared PID: $CF_PID"

  echo "  Waiting for tunnel URL..."
  TUNNEL_URL=""
  for i in $(seq 1 30); do
    TUNNEL_URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1 || echo "")
    if [ -n "$TUNNEL_URL" ]; then
      break
    fi
    sleep 1
  done

  if [ -z "$TUNNEL_URL" ]; then
    echo "ERROR: Could not capture tunnel URL after 30s"
    echo "  Check $TUNNEL_LOG"
    exit 1
  fi
fi

# Cleanup on exit
cleanup() {
  echo ""
  echo "Stopping cloudflared (PID $CF_PID)..."
  kill $CF_PID 2>/dev/null || true
  if [ -n "${SERVER_PID:-}" ]; then
    echo "Stopping server (PID $SERVER_PID)..."
    kill $SERVER_PID 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo ""
echo "  Tunnel URL: $TUNNEL_URL"
echo ""

# ── QR code ───────────────────────────────────────────────────
echo "  Scan this QR code on your iPhone (cellular):"
echo ""

if command -v qrencode >/dev/null 2>&1; then
  qrencode -t ANSIUTF8 "$TUNNEL_URL"
elif python3 -c "import qrcode" 2>/dev/null; then
  python3 -c "
import qrcode
qr = qrcode.QRCode(border=1)
qr.add_data('$TUNNEL_URL')
qr.print_ascii(invert=True)
"
else
  echo "  (Install qrencode for QR: brew install qrencode)"
  echo "  Or: pip install qrcode"
  echo ""
  echo "  Manual URL: $TUNNEL_URL"
fi

echo ""
echo "  This tunnel provides HTTPS, which Safari requires for WebRTC."
echo "  TURN relay (Twilio) is recommended for reliable cellular NAT traversal."
echo ""

# ── Tail both logs ────────────────────────────────────────────
echo "=== Server + Tunnel Logs (Ctrl+C to stop) ==="
echo ""
tail -f "$LOG_FILE" "$TUNNEL_LOG"

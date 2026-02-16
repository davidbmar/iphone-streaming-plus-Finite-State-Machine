#!/usr/bin/env bash
#
# run.sh — Unified launcher with mode selection and health checks.
#
# Usage: bash scripts/run.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8080}"
LOG_DIR="$REPO_ROOT/logs"
LOG_FILE="$LOG_DIR/server.log"
TUNNEL_LOG="$LOG_DIR/cloudflared.log"

mkdir -p "$LOG_DIR"

# PIDs to clean up on exit
SERVER_PID=""
CF_PID=""

cleanup() {
  echo ""
  if [ -n "$CF_PID" ]; then
    echo "Stopping cloudflared (PID $CF_PID)..."
    kill "$CF_PID" 2>/dev/null || true
  fi
  if [ -n "$SERVER_PID" ]; then
    echo "Stopping server (PID $SERVER_PID)..."
    kill "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ── Python detection ─────────────────────────────────────────
# Try candidates in order, verify each can import our deps.
find_python() {
  local candidates=(
    "python3"
    "python"
    "/usr/bin/python3"
    "/usr/local/bin/python3"
    "/Library/Developer/CommandLineTools/usr/bin/python3"
  )

  for py in "${candidates[@]}"; do
    if command -v "$py" >/dev/null 2>&1 || [ -x "$py" ]; then
      if "$py" -c "import aiohttp, aiortc" 2>/dev/null; then
        echo "$py"
        return 0
      fi
    fi
  done
  return 1
}

echo "=== WebRTC Speaker Streaming ==="
echo ""
echo "Finding Python with required dependencies..."

PYTHON=$(find_python) || {
  echo ""
  echo "ERROR: No Python found with aiohttp + aiortc installed."
  echo ""
  echo "Tried: python3, python, /usr/bin/python3, /usr/local/bin/python3,"
  echo "       /Library/Developer/CommandLineTools/usr/bin/python3"
  echo ""
  echo "Fix:   pip install -r requirements.txt"
  echo "       (or: pip3 install -r requirements.txt)"
  exit 1
}

echo "  Using: $PYTHON ($($PYTHON --version 2>&1))"
echo ""

# ── Mode selection ───────────────────────────────────────────
echo "How do you want to connect?"
echo ""
echo "  1) Local      — http://localhost:$PORT (Mac browser)"
echo "  2) LAN/WiFi   — https://<ip>:$PORT (iPhone on same WiFi)"
echo "  3) Cellular   — Cloudflare Tunnel (iPhone on cell network)"
echo ""
read -rp "Select mode [1/2/3]: " MODE

case "$MODE" in
  1|2|3) ;;
  *)
    echo "Invalid selection: $MODE"
    exit 1
    ;;
esac

# ── Mode-specific setup ─────────────────────────────────────

# Variables set per mode
SERVE_ENV=""
CONNECT_URL=""
LOCAL_IP=""

if [ "$MODE" = "2" ]; then
  # Detect local IP
  if command -v ipconfig >/dev/null 2>&1; then
    LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "")
  fi
  if [ -z "$LOCAL_IP" ] && command -v hostname >/dev/null 2>&1; then
    LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "")
  fi
  if [ -z "$LOCAL_IP" ]; then
    echo "ERROR: Could not detect local IP. Are you connected to Wi-Fi?"
    exit 1
  fi
  SERVE_ENV="HTTPS=1 LOCAL_IP=$LOCAL_IP"
  CONNECT_URL="https://$LOCAL_IP:$PORT"
fi

if [ "$MODE" = "3" ]; then
  if ! command -v cloudflared >/dev/null 2>&1; then
    echo "ERROR: cloudflared not found."
    echo "  Install: brew install cloudflared"
    exit 1
  fi
  echo "  cloudflared: $(cloudflared --version 2>&1 | head -1)"
  CONNECT_URL=""  # Set after tunnel starts
fi

if [ "$MODE" = "1" ]; then
  CONNECT_URL="http://localhost:$PORT"
fi

# ── Start server ─────────────────────────────────────────────
if lsof -i :"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo ""
  echo "  Server already running on port $PORT"
else
  echo ""
  echo "  Starting server on port $PORT..."
  cd "$REPO_ROOT"

  if [ -n "$SERVE_ENV" ]; then
    env $SERVE_ENV "$PYTHON" -m gateway.server > "$LOG_FILE" 2>&1 &
  else
    "$PYTHON" -m gateway.server > "$LOG_FILE" 2>&1 &
  fi
  SERVER_PID=$!
  echo "  Server PID: $SERVER_PID"

  # Wait for port
  echo "  Waiting for port $PORT..."
  for i in $(seq 1 10); do
    if lsof -i :"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done

  if ! lsof -i :"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "ERROR: Server failed to bind port $PORT after 5s."
    echo "  Check: $LOG_FILE"
    exit 1
  fi
fi

# ── Health check ─────────────────────────────────────────────
echo "  Running health check..."
HEALTH_OK=false
if [ "$MODE" = "2" ]; then
  HEALTH_URL="https://localhost:$PORT/health"
  CURL_FLAGS="-sfk"  # -k: skip self-signed cert verification
else
  HEALTH_URL="http://localhost:$PORT/health"
  CURL_FLAGS="-sf"
fi
for i in $(seq 1 5); do
  if curl $CURL_FLAGS "$HEALTH_URL" >/dev/null 2>&1; then
    HEALTH_OK=true
    break
  fi
  sleep 1
done

if $HEALTH_OK; then
  echo "  Health check PASSED"
else
  echo "  Health check FAILED — server may not be responding."
  echo "  Check: $LOG_FILE"
  exit 1
fi

# ── Cellular: start tunnel ───────────────────────────────────
if [ "$MODE" = "3" ]; then
  echo ""
  echo "  Starting Cloudflare Tunnel..."
  cloudflared tunnel --url "http://localhost:$PORT" > "$TUNNEL_LOG" 2>&1 &
  CF_PID=$!
  echo "  cloudflared PID: $CF_PID"

  echo "  Waiting for tunnel URL..."
  for i in $(seq 1 30); do
    CONNECT_URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1 || echo "")
    if [ -n "$CONNECT_URL" ]; then
      break
    fi
    sleep 1
  done

  if [ -z "$CONNECT_URL" ]; then
    echo "ERROR: Could not get tunnel URL after 30s."
    echo "  Check: $TUNNEL_LOG"
    exit 1
  fi
fi

# ── Display connection info ──────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  URL: $CONNECT_URL"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── QR code (modes 2 and 3) ─────────────────────────────────
show_qr() {
  local url="$1"
  echo "  Scan this QR code on your iPhone:"
  echo ""
  if command -v qrencode >/dev/null 2>&1; then
    qrencode -t ANSIUTF8 "$url"
  elif "$PYTHON" -c "import qrcode" 2>/dev/null; then
    "$PYTHON" -c "
import qrcode
qr = qrcode.QRCode(border=1)
qr.add_data('$url')
qr.print_ascii(invert=True)
"
  else
    echo "  No QR code tool found. Install one:"
    echo "    brew install qrencode"
    echo "    pip install qrcode"
    echo ""
    echo "  Open this URL manually on your iPhone:"
    echo "  $url"
  fi
  echo ""
}

if [ "$MODE" = "2" ]; then
  show_qr "$CONNECT_URL"
  echo "  NOTE: Self-signed HTTPS for mic access (getUserMedia)."
  echo "  On first visit, Safari will show a certificate warning."
  echo "  Tap 'Show Details' → 'visit this website' → 'Visit Website'."
  echo ""
fi

if [ "$MODE" = "3" ]; then
  show_qr "$CONNECT_URL"
  echo "  Tunnel provides HTTPS (required for WebRTC in Safari)."
  echo "  TURN relay (Twilio) recommended for reliable cellular NAT traversal."
  echo ""
fi

# ── Local mode: open browser ────────────────────────────────
if [ "$MODE" = "1" ]; then
  if command -v open >/dev/null 2>&1; then
    open "$CONNECT_URL"
    echo "  Opened in default browser"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$CONNECT_URL"
    echo "  Opened in default browser"
  fi
  echo ""
fi

# ── Tail logs ────────────────────────────────────────────────
echo "=== Server Log (Ctrl+C to stop) ==="
echo ""
if [ "$MODE" = "3" ] && [ -f "$TUNNEL_LOG" ]; then
  tail -f "$LOG_FILE" "$TUNNEL_LOG"
else
  tail -f "$LOG_FILE"
fi

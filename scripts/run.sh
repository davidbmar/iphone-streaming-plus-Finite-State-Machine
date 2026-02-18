#!/usr/bin/env bash
#
# run.sh — Unified launcher with mode selection, health checks, and watchdog.
#
# Features:
#   - caffeinate: prevents Mac sleep while running
#   - Watchdog: checks health every 60s, auto-restarts on failure (option B: clean restart)
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
TAIL_PID=""
CAFFEINATE_PID=""

SLEEP_DISABLED_BY_US=false

cleanup() {
  echo ""
  echo "Shutting down..."
  [ -n "$TAIL_PID" ] && kill "$TAIL_PID" 2>/dev/null || true
  if [ -n "$CF_PID" ]; then
    echo "  Stopping cloudflared (PID $CF_PID)..."
    kill "$CF_PID" 2>/dev/null || true
  fi
  if [ -n "$SERVER_PID" ]; then
    echo "  Stopping server (PID $SERVER_PID)..."
    kill "$SERVER_PID" 2>/dev/null || true
  fi
  [ -n "$CAFFEINATE_PID" ] && kill "$CAFFEINATE_PID" 2>/dev/null || true
  if pmset -g 2>/dev/null | grep -qi "sleepdisabled.*1"; then
    echo ""
    echo "  NOTE: lid-close sleep is still disabled."
    echo "  Run 'sudo pmset disablesleep 0' to re-enable."
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

# ── Ollama pre-check ──────────────────────────────────────
# Read model from .env or default
OLLAMA_MODEL=$(grep '^OLLAMA_MODEL=' "$REPO_ROOT/.env" 2>/dev/null | cut -d= -f2 || echo "qwen3:8b")
[ -z "$OLLAMA_MODEL" ] && OLLAMA_MODEL="qwen3:8b"

echo "Checking Ollama ($OLLAMA_MODEL)..."
if ! curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
  echo "  Ollama not running — starting it..."
  open -a Ollama 2>/dev/null || ollama serve >/dev/null 2>&1 &
  for i in $(seq 1 15); do
    if curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  if ! curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
    echo "  WARNING: Ollama still not responding. LLM calls will fail."
  else
    echo "  Ollama started"
  fi
else
  echo "  Ollama running"
fi

# Verify model is available
if curl -sf http://localhost:11434/api/tags 2>/dev/null | grep -q "\"$OLLAMA_MODEL\""; then
  echo "  Model $OLLAMA_MODEL: available"
else
  echo "  Model $OLLAMA_MODEL not found — pulling..."
  ollama pull "$OLLAMA_MODEL" 2>&1 | tail -1
fi

# Warm the model into memory (first inference is slow otherwise)
echo "  Warming model into memory..."
curl -sf http://localhost:11434/api/generate -d "{\"model\":\"$OLLAMA_MODEL\",\"prompt\":\"hi\",\"stream\":false}" >/dev/null 2>&1 &
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

# ── Prevent Mac sleep ─────────────────────────────────────
caffeinate -s -w $$ &
CAFFEINATE_PID=$!
echo "  caffeinate enabled — Mac will stay awake (idle sleep)"

# ── Prevent lid-close sleep (requires sudo) ──────────────
# caffeinate prevents idle sleep but NOT lid-close sleep.
# pmset disablesleep 1 keeps the Mac running even with the lid closed.
if pmset -g 2>/dev/null | grep -qi "sleepdisabled.*1"; then
  echo "  lid-close protection: already enabled"
  echo ""
else
  echo ""
  echo "  ┌─────────────────────────────────────────────────────┐"
  echo "  │  Lid-close sleep is NOT disabled.                   │"
  echo "  │  Closing the MacBook lid will kill the server.      │"
  echo "  │                                                     │"
  echo "  │  Run this in another terminal:                      │"
  echo "  │                                                     │"
  echo "  │    sudo pmset disablesleep 1                        │"
  echo "  │                                                     │"
  echo "  │  To undo later:  sudo pmset disablesleep 0          │"
  echo "  └─────────────────────────────────────────────────────┘"
  echo ""
  read -rp "  Press ENTER once done (or to skip): "
  echo ""
  if pmset -g 2>/dev/null | grep -qi "sleepdisabled.*1"; then
    echo "  lid-close sleep disabled"
  else
    echo "  WARNING: still not set — Mac may sleep if lid is closed"
  fi
  echo ""
fi

WATCHDOG_INTERVAL="${WATCHDOG_INTERVAL:-60}"
RESTART_COUNT=0

# ═══════════════════════════════════════════════════════════
# Main service loop — tears down & restarts everything on failure
# ═══════════════════════════════════════════════════════════
while true; do

if [ "$RESTART_COUNT" -gt 0 ]; then
  echo ""
  echo "[watchdog] ═══ Restart #$RESTART_COUNT ═══"
  echo ""
fi
RESTART_COUNT=$((RESTART_COUNT + 1))
SERVER_PID=""
CF_PID=""
TAIL_PID=""

# ── Start server ─────────────────────────────────────────────
if lsof -i :"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo ""
  echo "  Server already running on port $PORT"
else
  echo ""
  echo "  Starting server on port $PORT..."
  cd "$REPO_ROOT"

  # Append logs (preserve crash evidence across restarts)
  echo "--- server start $(date '+%Y-%m-%d %H:%M:%S') ---" >> "$LOG_FILE"
  if [ -n "$SERVE_ENV" ]; then
    env $SERVE_ENV "$PYTHON" -m gateway.server >> "$LOG_FILE" 2>&1 &
  else
    "$PYTHON" -m gateway.server >> "$LOG_FILE" 2>&1 &
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
    if [ "$RESTART_COUNT" -le 1 ]; then
      exit 1  # First attempt — bail out
    fi
    echo "[watchdog] Will retry..."
    sleep 3
    continue  # Retry in the restart loop
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
  if [ "$RESTART_COUNT" -le 1 ]; then
    exit 1  # First attempt — bail out
  fi
  echo "[watchdog] Will retry..."
  kill "$SERVER_PID" 2>/dev/null || true
  SERVER_PID=""
  sleep 3
  continue  # Retry in the restart loop
fi

# ── Cellular: start tunnel ───────────────────────────────────
if [ "$MODE" = "3" ]; then
  TUNNEL_CONFIG="$REPO_ROOT/.tunnel-config"

  if [ -f "$TUNNEL_CONFIG" ]; then
    # Named tunnel (permanent URL)
    # shellcheck disable=SC1090
    source "$TUNNEL_CONFIG"
    echo ""
    echo "  Using named tunnel: $TUNNEL_NAME"
    echo "  Starting Cloudflare Tunnel..."
    echo "--- cloudflared start $(date '+%Y-%m-%d %H:%M:%S') ---" >> "$TUNNEL_LOG"
    cloudflared tunnel --url "http://localhost:$PORT" run "$TUNNEL_NAME" >> "$TUNNEL_LOG" 2>&1 &
    CF_PID=$!
    echo "  cloudflared PID: $CF_PID"
    CONNECT_URL="$TUNNEL_URL"

    # Wait for tunnel to register
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
    echo ""
    echo "  No named tunnel found. Using quick tunnel (random URL)."
    echo "  Tip: run 'bash scripts/setup_tunnel.sh' for a permanent URL."
    echo ""
    echo "  Starting Cloudflare Tunnel..."
    cloudflared tunnel --ha-connections 4 --url "http://localhost:$PORT" > "$TUNNEL_LOG" 2>&1 &
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
echo "=== Watchdog active — health check every ${WATCHDOG_INTERVAL}s (Ctrl+C to stop) ==="
echo ""
if [ "$MODE" = "3" ] && [ -f "$TUNNEL_LOG" ]; then
  tail -f "$LOG_FILE" "$TUNNEL_LOG" &
else
  tail -f "$LOG_FILE" &
fi
TAIL_PID=$!

# Determine health URL for watchdog
if [ "$MODE" = "2" ]; then
  WD_HEALTH_URL="https://localhost:$PORT/health"
  WD_CURL_FLAGS="-sfk"
else
  WD_HEALTH_URL="http://localhost:$PORT/health"
  WD_CURL_FLAGS="-sf"
fi

# ── Watchdog loop ────────────────────────────────────────
while true; do
  sleep "$WATCHDOG_INTERVAL"

  HEALTHY=true
  REASON=""

  # Check: server process alive?
  if [ -n "$SERVER_PID" ] && ! kill -0 "$SERVER_PID" 2>/dev/null; then
    HEALTHY=false
    REASON="server process (PID $SERVER_PID) died"
  fi

  # Check: cloudflared alive? (mode 3 only)
  if [ "$MODE" = "3" ] && [ -n "$CF_PID" ] && ! kill -0 "$CF_PID" 2>/dev/null; then
    HEALTHY=false
    REASON="cloudflared process (PID $CF_PID) died"
  fi

  # Check: /health endpoint responds?
  if $HEALTHY && ! curl $WD_CURL_FLAGS "$WD_HEALTH_URL" >/dev/null 2>&1; then
    HEALTHY=false
    REASON="health endpoint unresponsive ($WD_HEALTH_URL)"
  fi

  if ! $HEALTHY; then
    echo ""
    echo "[watchdog] $(date '+%Y-%m-%d %H:%M:%S') FAILURE: $REASON"
    echo "[watchdog] Tearing down all services for clean restart..."

    # Kill log tail
    kill "$TAIL_PID" 2>/dev/null || true
    TAIL_PID=""

    # Kill cloudflared
    if [ -n "$CF_PID" ]; then
      kill "$CF_PID" 2>/dev/null || true
      CF_PID=""
    fi

    # Kill server
    if [ -n "$SERVER_PID" ]; then
      kill "$SERVER_PID" 2>/dev/null || true
      SERVER_PID=""
    fi

    # Wait for port to free
    echo "[watchdog] Waiting for port $PORT to free..."
    for i in $(seq 1 10); do
      if ! lsof -i :"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
        break
      fi
      sleep 1
    done

    echo "[watchdog] Restarting in 3s..."
    sleep 3
    break  # Break watchdog loop → outer loop restarts services
  fi
done

done  # ═══ End main service loop ═══

"""Gateway server — HTTP static serving + WebSocket signaling."""

import asyncio
import json
import logging
import os
import time
from pathlib import Path

from aiohttp import web
from dotenv import load_dotenv

load_dotenv()  # Must be before engine imports so they see .env vars

from engine.tts import list_voices, DEFAULT_VOICE
from engine.llm import (
    is_configured as llm_is_configured,
    get_provider_name,
    available_providers,
    get_available_models,
    pull_ollama_model,
)
from engine.search import (
    get_quota_status,
    is_configured as search_is_configured,
)
from engine.orchestrator import OrchestratorConfig
from engine.workflow import WorkflowRunner, get_workflow_def_for_client
from voice_assistant.tools import get_all_schemas
from voice_assistant.tool_router import dispatch_tool_call
from gateway.turn import fetch_twilio_turn_credentials

log = logging.getLogger("gateway")

PORT = int(os.getenv("PORT", "8080"))
AUTH_TOKEN = os.getenv("AUTH_TOKEN", "devtoken")
ICE_SERVERS_JSON = os.getenv("ICE_SERVERS_JSON", "[]")

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
INDEX_TEMPLATE = None  # Loaded on startup
_START_TIME = None  # Set on app creation

LOOKUP_PHRASE = "Let me look that up."


def build_index_html() -> str:
    """Read index.html and inject ICE servers config."""
    raw = (WEB_DIR / "index.html").read_text()
    return raw.replace("__ICE_SERVERS_PLACEHOLDER__", ICE_SERVERS_JSON)


# ── HTTP routes ───────────────────────────────────────────────

async def handle_index(request: web.Request) -> web.Response:
    """Serve index.html with injected config."""
    return web.Response(text=INDEX_TEMPLATE, content_type="text/html")


async def handle_health(request: web.Request) -> web.Response:
    """Lightweight health check — confirms event loop is responsive."""
    uptime = round(time.time() - _START_TIME, 1) if _START_TIME else 0
    return web.json_response({"status": "ok", "uptime": uptime})


async def handle_quota(request: web.Request) -> web.Response:
    """Return search provider quota status."""
    return web.json_response(await get_quota_status())


# ── WebSocket handler ─────────────────────────────────────────

async def handle_ws(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(request)
    log.info("WebSocket connected from %s", request.remote)

    session = None  # Will hold WebRTC Session once created
    ice_servers = []  # Populated on hello, shared with WebRTC session
    agent_mode = llm_is_configured()
    llm_provider = ""  # Empty = use default from env
    llm_model = ""  # Empty = use OLLAMA_MODEL env var
    tts_voice = DEFAULT_VOICE
    search_enabled = True  # User toggle, defaults ON

    # ── Orchestrator setup (shared tool registry) ───────────
    # Tools come from voice_assistant/tools/ — same registry for both UIs.
    # web_search is real; check_calendar and search_notes are mocks (F-003, F-004).
    all_tool_schemas = get_all_schemas()

    async def _safe_ws_send(data: dict) -> bool:
        """Send JSON over WS, returning False if the connection is gone."""
        try:
            if not ws.closed:
                await ws.send_json(data)
                return True
        except Exception:
            log.debug("WS send failed (connection closing)")
        return False

    async def _on_status(status: str) -> None:
        if status == "thinking":
            await _safe_ws_send({"type": "agent_thinking"})
        elif status == "searching":
            await _safe_ws_send({"type": "agent_searching"})

    async def _on_tool_call(name: str, args: dict) -> None:
        if ws.closed:
            return
        if name == "web_search" and session:
            await _safe_ws_send({"type": "agent_reply", "text": LOOKUP_PHRASE})
            try:
                await session.speak_text(LOOKUP_PHRASE, voice_id=tts_voice)
            except Exception:
                log.debug("TTS for lookup phrase failed (session closing)")
            await _safe_ws_send({"type": "agent_searching"})

    runner = WorkflowRunner(config=OrchestratorConfig(
        provider=llm_provider,
        model=llm_model,
        tools=all_tool_schemas if search_is_configured() else [],
        dispatch=dispatch_tool_call,
        on_status=_on_status,
        on_tool_call=_on_tool_call,
    ))

    # ── Workflow callbacks (rich WS messages for visual debugger) ──
    async def _on_workflow_start(workflow_id, wf):
        client_def = get_workflow_def_for_client(workflow_id)
        if client_def:
            await _safe_ws_send({
                "type": "workflow_start",
                **client_def,
            })

    async def _on_workflow_state(state_id, status, **kwargs):
        if status == "loop_update":
            await _safe_ws_send({
                "type": "workflow_loop_update",
                "state_id": state_id,
                "children": kwargs.get("children", []),
                "active_index": kwargs.get("active_index", -1),
            })
        else:
            msg = {
                "type": "workflow_state",
                "state_id": state_id,
                "status": status,
            }
            if "detail" in kwargs:
                msg["detail"] = kwargs["detail"]
            if "step" in kwargs:
                msg["step"] = kwargs["step"]
            if "total" in kwargs:
                msg["total"] = kwargs["total"]
            if "step_name" in kwargs:
                msg["step_name"] = kwargs["step_name"]
            await _safe_ws_send(msg)

    async def _on_workflow_exit(workflow_id):
        await _safe_ws_send({
            "type": "workflow_exit",
            "workflow_id": workflow_id,
        })

    async def _on_narration(text):
        await _safe_ws_send({"type": "workflow_narration", "text": text})

    async def _on_activity(activity, timeout_secs):
        await _safe_ws_send({"type": "workflow_activity", "activity": activity, "timeout_secs": timeout_secs})

    async def _on_debug(diag):
        await _safe_ws_send({"type": "workflow_debug", **diag})

    runner.on_workflow_start = _on_workflow_start
    runner.on_workflow_state = _on_workflow_state
    runner.on_workflow_exit = _on_workflow_exit
    runner.on_narration = _on_narration
    runner.on_activity = _on_activity
    runner.on_debug = _on_debug

    def _refresh_orchestrator_tools():
        """Update runner tools based on current search toggle."""
        if search_enabled and search_is_configured():
            runner.update_config(tools=all_tool_schemas)
        else:
            runner.update_config(tools=[])

    async def _do_agent_reply(user_text: str) -> None:
        """Run workflow runner + TTS in background so WS loop stays responsive."""
        try:
            reply = await runner.chat(user_text)
        except Exception as e:
            log.error("WorkflowRunner error: %s", e)
            await _safe_ws_send({"type": "error", "message": f"LLM error: {e}"})
            return

        if not await _safe_ws_send({"type": "agent_reply", "text": reply}):
            return  # Client gone, skip TTS
        log.info("Agent reply: %r (voice=%s)", reply[:80], tts_voice)

        try:
            if session:
                await session.speak_text(reply, voice_id=tts_voice)
        except Exception as e:
            log.warning("TTS speak failed: %s", e)

    async for raw in ws:
        if raw.type != web.WSMsgType.TEXT:
            continue
        try:
            msg = json.loads(raw.data)
        except json.JSONDecodeError:
            await ws.send_json({"type": "error", "message": "Invalid JSON"})
            continue

        msg_type = msg.get("type")
        log.debug("WS recv: %s", msg_type)

        if msg_type == "hello":
            token = msg.get("token", "")
            if token != AUTH_TOKEN:
                await ws.send_json({"type": "error", "message": "Bad token"})
                await ws.close()
                break
            # Fetch fresh TURN credentials (falls back to ICE_SERVERS_JSON)
            ice_servers = await fetch_twilio_turn_credentials()
            if not ice_servers:
                try:
                    ice_servers = json.loads(ICE_SERVERS_JSON)
                except json.JSONDecodeError:
                    ice_servers = []
            tts_voices = list_voices()
            model_catalog = await get_available_models()
            # Default to Ollama if it has installed models, else fall back to cloud
            default_model = ""
            if model_catalog["ollama_installed"]:
                default_provider = "ollama"
                # Respect OLLAMA_MODEL env var, else prefer qwen3:8b, else first installed
                installed_names = [m["name"] for m in model_catalog["ollama_installed"]]
                env_model = os.getenv("OLLAMA_MODEL", "")
                if env_model and env_model in installed_names:
                    default_model = env_model
                elif "qwen3:8b" in installed_names:
                    default_model = "qwen3:8b"
                else:
                    default_model = installed_names[0]
                llm_provider = "ollama"
                llm_model = default_model
                runner.update_config(provider=llm_provider, model=llm_model)
                log.info("Default model: ollama/%s", default_model)
            else:
                default_provider = get_provider_name()
            search_quota = await get_quota_status()
            await ws.send_json({
                "type": "hello_ack",
                "voices": tts_voices,
                "tts_voices": tts_voices,
                "tts_default_voice": tts_voice,
                "ice_servers": ice_servers,
                "llm_providers": available_providers(),
                "llm_default": default_provider,
                "model_catalog": model_catalog,
                "llm_default_provider": default_provider,
                "llm_default_model": default_model,
                "search_enabled": search_enabled,
                "search_quota": search_quota,
            })

        elif msg_type == "webrtc_offer":
            sdp = msg.get("sdp", "")
            if not sdp:
                await ws.send_json({"type": "error", "message": "Missing SDP"})
                continue
            from gateway.webrtc import Session
            session = Session(ice_servers=ice_servers)
            answer_sdp = await session.handle_offer(sdp)
            await ws.send_json({"type": "webrtc_answer", "sdp": answer_sdp})

        elif msg_type == "start":
            voice_id = msg.get("voice_id", "")
            if session:
                session.start_audio(voice_id)
                log.info("Audio started: %s", voice_id)
            else:
                await ws.send_json({"type": "error", "message": "No WebRTC session"})

        elif msg_type == "stop":
            if session:
                session.stop_audio()
                log.info("Audio stopped")

        elif msg_type == "speak":
            text = msg.get("text", "").strip()
            if not text:
                await ws.send_json({"type": "error", "message": "Empty text"})
            elif session:
                log.info("TTS speak: %r (voice=%s)", text[:80], tts_voice)
                await session.speak_text(text, voice_id=tts_voice)
            else:
                await ws.send_json({"type": "error", "message": "No WebRTC session"})

        elif msg_type == "set_provider":
            provider = msg.get("provider", "")
            if provider in ("claude", "openai", "ollama"):
                llm_provider = provider
                runner.update_config(provider=provider)
                log.info("LLM provider switched to: %s", provider)
                await ws.send_json({"type": "provider_set", "provider": provider})
            else:
                await ws.send_json({"type": "error", "message": f"Unknown provider: {provider}"})

        elif msg_type == "set_model":
            provider = msg.get("provider", "")
            model = msg.get("model", "")
            if provider in ("claude", "openai", "ollama"):
                llm_provider = provider
                llm_model = model if provider == "ollama" else ""
                runner.update_config(provider=llm_provider, model=llm_model)
                runner.clear_history()
                log.info("Model switched: provider=%s, model=%s (conversation cleared)", provider, model)
                await ws.send_json({"type": "model_set", "provider": provider, "model": model})
            else:
                await ws.send_json({"type": "error", "message": f"Unknown provider: {provider}"})

        elif msg_type == "set_voice":
            voice_id = msg.get("voice_id", "")
            known_ids = {v["id"] for v in list_voices()}
            if voice_id in known_ids:
                tts_voice = voice_id
                log.info("Voice switched to: %s", voice_id)
                await ws.send_json({
                    "type": "voice_set",
                    "voice_id": voice_id,
                    "tts_voices": list_voices(),
                })
            else:
                await ws.send_json({"type": "error", "message": f"Unknown voice: {voice_id}"})

        elif msg_type == "pull_model":
            model_name = msg.get("model", "")
            if not model_name:
                await ws.send_json({"type": "error", "message": "Missing model name"})
                continue
            log.info("Starting model pull: %s", model_name)
            await ws.send_json({"type": "pull_started", "model": model_name})

            async def _do_pull(ws, model_name):
                try:
                    async for progress in pull_ollama_model(model_name):
                        if ws.closed:
                            log.warning("WS closed during pull of %s", model_name)
                            return
                        status = progress.get("status", "")
                        total = progress.get("total", 0)
                        completed = progress.get("completed", 0)
                        pct = int(completed / total * 100) if total > 0 else 0
                        await ws.send_json({
                            "type": "pull_progress",
                            "model": model_name,
                            "status": status,
                            "percent": pct,
                            "total": total,
                            "completed": completed,
                        })
                    if not ws.closed:
                        updated_catalog = await get_available_models()
                        await ws.send_json({"type": "pull_complete", "model": model_name})
                        await ws.send_json({"type": "model_catalog_update", "model_catalog": updated_catalog})
                    log.info("Model pull complete: %s", model_name)
                except Exception as e:
                    log.error("Model pull failed: %s — %s", model_name, e)
                    if not ws.closed:
                        await ws.send_json({"type": "pull_error", "model": model_name, "message": str(e)})

            asyncio.create_task(_do_pull(ws, model_name))

        elif msg_type == "stop_speaking":
            if session:
                session.stop_speaking()
                log.info("TTS playback stopped by user")

        elif msg_type == "mic_start":
            if session:
                async def on_transcription(text, partial):
                    await _safe_ws_send({"type": "transcription", "text": text, "partial": partial})
                    log.debug("Partial transcription: %r", text[:80] if text else "")
                session.start_recording(on_transcription=on_transcription)
                log.info("Mic recording started (live)")
            else:
                await ws.send_json({"type": "error", "message": "No WebRTC session"})

        elif msg_type == "mic_stop":
            if session:
                log.info("Mic recording stopping, final STT...")
                text = await session.stop_recording()
                await ws.send_json({"type": "transcription", "text": text, "partial": False})
                log.info("Final transcription: %r", text[:80] if text else "")

                # Agent mode: run in background so WS loop stays responsive
                if agent_mode and text.strip():
                    _refresh_orchestrator_tools()
                    asyncio.create_task(_do_agent_reply(text))
            else:
                await ws.send_json({"type": "error", "message": "No WebRTC session"})

        elif msg_type == "chat":
            # Text-only chat (no mic/WebRTC needed) — useful for testing
            text = msg.get("text", "").strip()
            if text:
                _refresh_orchestrator_tools()
                await _safe_ws_send({"type": "transcription", "text": text, "partial": False})
                asyncio.create_task(_do_agent_reply(text))
            else:
                await ws.send_json({"type": "error", "message": "Empty chat text"})

        elif msg_type == "set_search_enabled":
            search_enabled = msg.get("enabled", True)
            _refresh_orchestrator_tools()
            log.info("Web search %s by user", "enabled" if search_enabled else "disabled")
            await ws.send_json({"type": "search_enabled_set", "enabled": search_enabled})

        elif msg_type == "ping":
            await ws.send_json({"type": "pong"})

        else:
            await ws.send_json({"type": "error", "message": f"Unknown type: {msg_type}"})

    # Cleanup on disconnect
    if session:
        await session.close()
    log.info("WebSocket disconnected")
    return ws


# ── App setup ─────────────────────────────────────────────────

def create_app() -> web.Application:
    global INDEX_TEMPLATE, _START_TIME
    INDEX_TEMPLATE = build_index_html()
    _START_TIME = time.time()

    app = web.Application()
    app.router.add_get("/", handle_index)
    app.router.add_get("/health", handle_health)
    app.router.add_get("/api/quota", handle_quota)
    app.router.add_get("/ws", handle_ws)
    app.router.add_static("/static", WEB_DIR, show_index=False)
    return app


LOG_DIR = Path(__file__).resolve().parent.parent / "logs"


if __name__ == "__main__":
    LOG_DIR.mkdir(exist_ok=True)
    log_file = LOG_DIR / "server.log"

    fmt = logging.Formatter("%(asctime)s %(name)-12s %(levelname)-8s %(message)s")

    console = logging.StreamHandler()
    console.setLevel(logging.INFO)
    console.setFormatter(fmt)

    filelog = logging.FileHandler(log_file)
    filelog.setLevel(logging.INFO)
    filelog.setFormatter(fmt)

    logging.basicConfig(level=logging.INFO, handlers=[console, filelog])

    # Silence noisy internals
    logging.getLogger("aiortc").setLevel(logging.WARNING)
    logging.getLogger("aioice").setLevel(logging.WARNING)
    logging.getLogger("asyncio").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("aiohttp.access").setLevel(logging.WARNING)
    log.info("Logging to %s", log_file)
    app = create_app()

    # HTTPS mode for LAN testing (getUserMedia requires secure context)
    ssl_ctx = None
    if os.getenv("HTTPS"):
        import ssl
        from gateway.cert import ensure_cert

        local_ip = os.getenv("LOCAL_IP", "192.168.1.1")
        cert_path, key_path = ensure_cert(local_ip)
        ssl_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ssl_ctx.load_cert_chain(str(cert_path), str(key_path))
        log.info("HTTPS enabled with self-signed cert for %s", local_ip)
        log.info("Serving on https://0.0.0.0:%d", PORT)
    else:
        log.info("Serving on http://0.0.0.0:%d", PORT)

    web.run_app(app, host="0.0.0.0", port=PORT, ssl_context=ssl_ctx)

"""Gateway server — HTTP static serving + WebSocket signaling."""

import asyncio
import json
import logging
import os
import sys
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
from voice_assistant.tools import get_all_schemas, get_filtered_schemas
from voice_assistant.tool_router import dispatch_tool_call
from engine.fast_path import try_fast_path
from engine.input_filter import classify as classify_input, InputQuality
from gateway.turn import fetch_twilio_turn_credentials
from gateway.db import (
    init_db, create_session, add_turn, end_session as db_end_session,
    get_user_preferences, update_user_preferences, delete_auth_session,
    cleanup_expired_sessions,
)
from gateway.auth import authenticate_google, authenticate_session_token

log = logging.getLogger("gateway")

PORT = int(os.getenv("PORT", "8080"))
AUTH_TOKEN = os.getenv("AUTH_TOKEN", "devtoken")
ICE_SERVERS_JSON = os.getenv("ICE_SERVERS_JSON", "[]")

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
INDEX_TEMPLATE = None  # Loaded on startup
_START_TIME = None  # Set on app creation

LOOKUP_PHRASE = "Let me look that up."


GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")


def build_index_html() -> str:
    """Read index.html and inject ICE servers config + Google Client ID."""
    raw = (WEB_DIR / "index.html").read_text()
    raw = raw.replace("__ICE_SERVERS_PLACEHOLDER__", ICE_SERVERS_JSON)
    raw = raw.replace("__GOOGLE_CLIENT_ID_PLACEHOLDER__", GOOGLE_CLIENT_ID)
    return raw


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
    client_tz = ""  # IANA timezone from browser (e.g. "America/Chicago")
    db_session_id = None  # SQLite session tracking
    mic_timeout_task = None  # Safety timer for runaway mic recordings

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
        """Update runner tools based on current search toggle AND admin config."""
        import json as _json
        from gateway.db import get_config

        # Admin-level disabled tools
        disabled = _json.loads(get_config("disabled_tools_json", "[]"))

        # Admin-level web search master toggle
        admin_search = get_config("web_search_enabled", "true") == "true"
        if not admin_search or not search_enabled:
            disabled.append("web_search")

        if search_is_configured():
            runner.update_config(tools=get_filtered_schemas(disabled))
        else:
            runner.update_config(tools=[])

    async def _try_fast_reply(user_text: str) -> bool:
        """Try fast-path (no LLM). Returns True if handled, False to fall through."""
        reply = try_fast_path(user_text, client_tz=client_tz)
        if reply is None:
            return False
        if not await _safe_ws_send({"type": "agent_reply", "text": reply}):
            return True
        log.info("Fast-path reply: %r (voice=%s)", reply[:80], tts_voice)
        try:
            if session:
                await session.speak_text(reply, voice_id=tts_voice)
        except Exception as e:
            log.warning("TTS speak failed: %s", e)
        return True

    async def _do_agent_reply(
        user_text: str,
        no_speech_prob: float = 0.0,
        avg_logprob: float = 0.0,
        audio_duration_s: float = 0.0,
    ) -> None:
        """Run workflow runner + TTS in background so WS loop stays responsive."""
        # Layer 1: Input quality filter (see engine/input_filter.py)
        quality = classify_input(user_text, no_speech_prob, avg_logprob, audio_duration_s)
        if quality != InputQuality.VALID:
            log.info("Input filter [%s]: dropped %r", quality.value, user_text)
            return

        # Layer 2: Fast path — answer simple queries without LLM
        if await _try_fast_reply(user_text):
            return

        try:
            reply = await runner.chat(user_text)
        except Exception as e:
            log.error("WorkflowRunner error: %s", e)
            await _safe_ws_send({"type": "error", "message": f"LLM error: {e}"})
            return

        if not await _safe_ws_send({"type": "agent_reply", "text": reply}):
            return  # Client gone, skip TTS
        log.info("Agent reply: %r (voice=%s)", reply[:80], tts_voice)
        if db_session_id:
            add_turn(db_session_id, "agent", reply,
                     model_used=f"{llm_provider}/{llm_model}")

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
        if msg_type != "ping":  # Don't spam heartbeats
            log.info("WS recv: %s", msg_type)

        if msg_type == "hello":
            # ── Authentication (3 methods, priority order) ──
            auth_user_id = None
            auth_user_info = None
            auth_session_token = None

            google_jwt = msg.get("google_jwt", "")
            session_tok = msg.get("session_token", "")
            legacy_token = msg.get("token", "")

            if google_jwt:
                try:
                    auth_user_id, auth_session_token, auth_user_info = authenticate_google(google_jwt)
                except Exception as e:
                    log.warning("Google auth failed: %s", e)
                    await ws.send_json({"type": "error", "message": f"Google auth failed: {e}"})
                    await ws.close()
                    break
            elif session_tok:
                result = authenticate_session_token(session_tok)
                if result:
                    auth_user_id, auth_user_info = result
                    auth_session_token = session_tok  # reuse valid token
                else:
                    await ws.send_json({"type": "auth_expired"})
                    await ws.close()
                    break
            elif legacy_token:
                if legacy_token != AUTH_TOKEN:
                    await ws.send_json({"type": "error", "message": "Bad token"})
                    await ws.close()
                    break
            else:
                await ws.send_json({"type": "error", "message": "No credentials provided"})
                await ws.close()
                break

            # ── Load user preferences if authenticated ──
            if auth_user_id:
                prefs = get_user_preferences(auth_user_id)
                if prefs:
                    if prefs.get("voice"):
                        tts_voice = prefs["voice"]
                    if prefs.get("llm_provider"):
                        llm_provider = prefs["llm_provider"]
                    if prefs.get("llm_model"):
                        llm_model = prefs["llm_model"]
                    if prefs.get("search_enabled") is not None:
                        search_enabled = bool(prefs["search_enabled"])

            # Inject client timezone into system prompt for time awareness
            client_tz = msg.get("timezone", "")
            if client_tz:
                from datetime import datetime
                from zoneinfo import ZoneInfo
                try:
                    now = datetime.now(ZoneInfo(client_tz))
                    time_ctx = (
                        f"The user's timezone is {client_tz}. "
                        f"Their current local time is {now.strftime('%I:%M %p')} "
                        f"on {now.strftime('%A, %B %d, %Y')}. "
                    )
                    from engine.orchestrator import _default_system_prompt
                    runner.update_config(system_prompt=time_ctx + _default_system_prompt())
                    log.info("Client timezone: %s (%s)", client_tz, now.strftime('%I:%M %p %Z'))
                except Exception:
                    log.warning("Invalid client timezone: %s", client_tz)
            # Fetch fresh TURN credentials (falls back to ICE_SERVERS_JSON)
            ice_servers = await fetch_twilio_turn_credentials()
            if not ice_servers:
                try:
                    ice_servers = json.loads(ICE_SERVERS_JSON)
                except json.JSONDecodeError:
                    ice_servers = []
            tts_voices = list_voices()
            model_catalog = await get_available_models()
            # Default to Claude Haiku if API key is set, else Ollama, else auto-detect
            default_model = ""
            if os.getenv("ANTHROPIC_API_KEY", ""):
                default_provider = "claude"
                default_model = "claude-haiku-4-5-20251001"
                if not llm_provider:
                    llm_provider = "claude"
                if not llm_model:
                    llm_model = default_model
                runner.update_config(provider=llm_provider, model=llm_model)
                log.info("Default model: claude/%s", default_model)
            elif model_catalog["ollama_installed"]:
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
                if not llm_provider:
                    llm_provider = "ollama"
                if not llm_model:
                    llm_model = default_model
                runner.update_config(provider=llm_provider, model=llm_model)
                log.info("Default model: ollama/%s", default_model)
            else:
                default_provider = get_provider_name()
            search_quota = await get_quota_status()
            ack = {
                "type": "hello_ack",
                "voices": tts_voices,
                "tts_voices": tts_voices,
                "tts_default_voice": tts_voice,
                "ice_servers": ice_servers,
                "llm_providers": available_providers(),
                "llm_default": default_provider,
                "model_catalog": model_catalog,
                "llm_default_provider": llm_provider or default_provider,
                "llm_default_model": llm_model or default_model,
                "search_enabled": search_enabled,
                "search_quota": search_quota,
            }
            if auth_user_info:
                ack["user"] = auth_user_info
            if auth_session_token:
                ack["session_token"] = auth_session_token
            await ws.send_json(ack)
            db_session_id = create_session(
                client_ip=request.remote or "",
                client_timezone=client_tz,
                llm_provider=llm_provider,
                llm_model=llm_model,
                voice=tts_voice,
                user_id=auth_user_id,
            )

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

                # Safety timeout: auto-stop recording after 30s in case
                # the client's touchend/mic_stop message is lost
                async def _mic_safety_timeout():
                    await asyncio.sleep(30)
                    if session and session.is_recording:
                        log.warning("Mic safety timeout (30s) — auto-stopping recording")
                        text, no_speech_prob, avg_logprob, audio_duration_s = await session.stop_recording()
                        await _safe_ws_send({"type": "transcription", "text": text, "partial": False})
                        await _safe_ws_send({"type": "mic_timeout"})
                        if text.strip():
                            log.info("Safety-timeout transcription: %r", text[:80])
                            if db_session_id:
                                add_turn(db_session_id, "user", text,
                                         audio_duration_s=audio_duration_s,
                                         no_speech_prob=no_speech_prob,
                                         avg_logprob=avg_logprob)
                            if agent_mode:
                                _refresh_orchestrator_tools()
                                asyncio.create_task(_do_agent_reply(text, no_speech_prob, avg_logprob, audio_duration_s))
                mic_timeout_task = asyncio.create_task(_mic_safety_timeout())
            else:
                await ws.send_json({"type": "error", "message": "No WebRTC session"})

        elif msg_type == "mic_stop":
            if session:
                # Cancel safety timeout since client sent mic_stop normally
                if mic_timeout_task and not mic_timeout_task.done():
                    mic_timeout_task.cancel()
                    mic_timeout_task = None
                log.info("Mic recording stopping, final STT...")
                text, no_speech_prob, avg_logprob, audio_duration_s = await session.stop_recording()
                await ws.send_json({"type": "transcription", "text": text, "partial": False})
                log.info("Final transcription: %r", text[:80] if text else "")
                if db_session_id and text.strip():
                    add_turn(db_session_id, "user", text,
                             audio_duration_s=audio_duration_s,
                             no_speech_prob=no_speech_prob,
                             avg_logprob=avg_logprob)

                # Agent mode: run in background so WS loop stays responsive
                if agent_mode and text.strip():
                    _refresh_orchestrator_tools()
                    asyncio.create_task(_do_agent_reply(text, no_speech_prob, avg_logprob, audio_duration_s))
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

        elif msg_type == "save_preferences":
            if auth_user_id:
                update_user_preferences(
                    auth_user_id,
                    voice=tts_voice,
                    llm_provider=llm_provider,
                    llm_model=llm_model,
                    search_enabled=1 if search_enabled else 0,
                )
                log.info("Saved preferences for user %s", auth_user_id)
                await ws.send_json({"type": "preferences_saved"})
            else:
                await ws.send_json({"type": "error", "message": "Not authenticated"})

        elif msg_type == "logout":
            if auth_session_token:
                delete_auth_session(auth_session_token)
                auth_user_id = None
                auth_user_info = None
                auth_session_token = None
                log.info("User logged out")
            await ws.send_json({"type": "logged_out"})

        elif msg_type == "ping":
            await ws.send_json({"type": "pong"})

        else:
            await ws.send_json({"type": "error", "message": f"Unknown type: {msg_type}"})

    # Cleanup on disconnect
    if session:
        await session.close()
    if db_session_id:
        db_end_session(db_session_id)
    log.info("WebSocket disconnected")
    return ws


# ── App setup ─────────────────────────────────────────────────

async def handle_auth_logout(request: web.Request) -> web.Response:
    """REST endpoint for logout — alternative to WS logout message."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)
    token = body.get("session_token", "")
    if token:
        delete_auth_session(token)
    return web.json_response({"status": "logged_out"})


def create_app() -> web.Application:
    global INDEX_TEMPLATE, _START_TIME
    INDEX_TEMPLATE = build_index_html()
    _START_TIME = time.time()

    app = web.Application()
    app.router.add_get("/", handle_index)
    app.router.add_get("/health", handle_health)
    app.router.add_get("/api/quota", handle_quota)
    app.router.add_post("/api/auth/logout", handle_auth_logout)
    app.router.add_get("/ws", handle_ws)
    app.router.add_static("/static", WEB_DIR, show_index=False)
    init_db()
    expired = cleanup_expired_sessions()
    if expired:
        log.info("Cleaned up %d expired auth sessions", expired)
    from gateway.admin import register_admin_routes
    register_admin_routes(app)
    return app


LOG_DIR = Path(__file__).resolve().parent.parent / "logs"


if __name__ == "__main__":
    LOG_DIR.mkdir(exist_ok=True)
    log_file = LOG_DIR / "server.log"

    fmt = logging.Formatter("%(asctime)s %(name)-12s %(levelname)-8s %(message)s")

    filelog = logging.FileHandler(log_file)
    filelog.setLevel(logging.INFO)
    filelog.setFormatter(fmt)

    handlers = [filelog]
    # Only add console handler when stdout is a real terminal.
    # run.sh already redirects stdout to server.log, so adding a
    # StreamHandler too would duplicate every line in the file.
    if sys.stdout.isatty():
        console = logging.StreamHandler()
        console.setLevel(logging.INFO)
        console.setFormatter(fmt)
        handlers.append(console)

    logging.basicConfig(level=logging.INFO, handlers=handlers)

    # Silence noisy internals
    logging.getLogger("aiortc").setLevel(logging.WARNING)
    logging.getLogger("aioice").setLevel(logging.WARNING)

    # Suppress TURN 403 "Forbidden IP" task exceptions (non-fatal, ICE still succeeds)
    class _TurnErrorFilter(logging.Filter):
        def filter(self, record):
            msg = record.getMessage()
            return "TransactionFailed" not in msg and "Forbidden IP" not in msg

    logging.getLogger("asyncio").setLevel(logging.WARNING)
    logging.getLogger("asyncio").addFilter(_TurnErrorFilter())
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
    log.info("Admin dashboard: http://localhost:%d/admin", PORT)

    web.run_app(app, host="0.0.0.0", port=PORT, ssl_context=ssl_ctx)

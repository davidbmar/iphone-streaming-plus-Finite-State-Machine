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
from engine.conversation import ConversationHistory
from engine.llm import (
    generate as llm_generate,
    generate_with_tools as llm_generate_with_tools,
    build_tool_result_messages,
    is_configured as llm_is_configured,
    get_provider_name,
    available_providers,
    get_available_models,
    pull_ollama_model,
)
from engine.search import (
    search as web_search,
    format_results_for_context,
    get_quota_status,
    is_configured as search_is_configured,
)
from gateway.turn import fetch_twilio_turn_credentials

log = logging.getLogger("gateway")

PORT = int(os.getenv("PORT", "8080"))
AUTH_TOKEN = os.getenv("AUTH_TOKEN", "devtoken")
ICE_SERVERS_JSON = os.getenv("ICE_SERVERS_JSON", "[]")

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
INDEX_TEMPLATE = None  # Loaded on startup
_START_TIME = None  # Set on app creation


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


# ── Search tool definition (for native tool calling) ──────────

SEARCH_TOOL = {
    "type": "function",
    "function": {
        "name": "web_search",
        "description": (
            "Search the web for current, real-time information. Use this for "
            "weather, news, stock prices, sports scores, recent events, current "
            "dates, driving times, or any facts that may have changed recently."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "A clean, concise web search query",
                }
            },
            "required": ["query"],
        },
    },
}


# ── Search classifier (fallback for safety net query extraction) ──

SEARCH_CLASSIFIER_PROMPT = (
    "Extract a clean web search query from this user message. "
    "Strip conversational filler and keep only the factual question.\n\n"
    "Reply with ONLY the search query, nothing else.\n\n"
    "Examples:\n"
    "User: 'What is the weather today in Austin?' → weather in Austin today\n"
    "User: 'Yes, look that up, what's the S&P 500?' → S&P 500 current price\n"
    "User: 'Can you tell me who won the Super Bowl?' → who won the Super Bowl"
)


async def _extract_search_query(text: str, provider: str, model: str) -> str:
    """Extract a clean search query from user text via LLM.

    Used as fallback when the safety net triggers (model hedged without tool use).
    """
    try:
        reply = await llm_generate(
            SEARCH_CLASSIFIER_PROMPT,
            [{"role": "user", "content": text}],
            provider,
            model,
        )
        query = reply.strip()
        if len(query) > 5:
            log.info("Query extraction: %r → %r", text[:50], query[:60])
            return query
    except Exception as e:
        log.warning("Query extraction failed: %s", e)
    return text  # fallback to raw text


# ── Search hedging detection (safety net) ─────────────────────

# Phrases that indicate the LLM is refusing or hedging — trigger search fallback
_HEDGING_PHRASES = [
    "don't have access",
    "don't have real-time",
    "don't have current",
    "don't have the ability",
    "don't have live",
    "do not have access",
    "do not have real-time",
    "do not have current",
    "do not have the ability",
    "can't browse",
    "can't access the internet",
    "can't access the web",
    "can't search",
    "cannot browse",
    "cannot access the internet",
    "cannot access the web",
    "cannot search",
    "not able to browse",
    "not able to access",
    "not able to search",
    "unable to browse",
    "unable to access real",
    "unable to search",
    "my knowledge cutoff",
    "my training data",
    "information is outdated",
    "data is outdated",
    "may be outdated",
    "might be outdated",
    "as an ai",
    "as a language model",
    "as a large language model",
    "lack access",
    "beyond my capabilities",
    "outside my capabilities",
    "not available to me",
    "can't actually browse",
    "can't actually access",
    "can't actually search",
    "cannot actually browse",
    "cannot actually access",
    "cannot actually search",
    "don't actually have access",
    "still under development",
]

LOOKUP_PHRASE = "Let me look that up."


def _reply_is_hedging(reply: str) -> bool:
    """Check if the LLM response contains hedging/refusal phrases."""
    lower = reply.lower()
    return any(phrase in lower for phrase in _HEDGING_PHRASES)


# ── WebSocket handler ─────────────────────────────────────────

async def handle_ws(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(request)
    log.info("WebSocket connected from %s", request.remote)

    session = None  # Will hold WebRTC Session once created
    ice_servers = []  # Populated on hello, shared with WebRTC session
    conversation = ConversationHistory()
    agent_mode = llm_is_configured()
    llm_provider = ""  # Empty = use default from env
    llm_model = ""  # Empty = use OLLAMA_MODEL env var
    tts_voice = DEFAULT_VOICE
    search_enabled = True  # User toggle, defaults ON

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
                default_model = model_catalog["ollama_installed"][0]["name"]
                # Set session state so the agent loop actually uses Ollama
                llm_provider = "ollama"
                llm_model = default_model
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
            # Lazy import to avoid loading aiortc until needed
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
                conversation.clear()
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

            # Run pull as background task so the WS message loop stays responsive
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
                    await ws.send_json({"type": "transcription", "text": text, "partial": partial})
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

                # Agent mode: tool-call → [search?] → reply → [hedging? → search → retry]
                if agent_mode and text.strip():
                    conversation.add_turn("user", text)
                    active_provider = llm_provider or get_provider_name()
                    use_tools = search_enabled and search_is_configured()
                    tools = [SEARCH_TOOL] if use_tools else []
                    messages = conversation.get_messages()

                    await ws.send_json({"type": "agent_thinking"})
                    log.info("Agent thinking (provider=%s, tools=%d)...",
                             active_provider, len(tools))

                    try:
                        # ── Primary: generate with tool calling ──
                        reply, tool_calls = await llm_generate_with_tools(
                            conversation.system, messages, tools,
                            llm_provider, llm_model,
                        )

                        # Handle tool calls (model decided to search)
                        search_performed = False
                        if tool_calls:
                            for i, tc in enumerate(tool_calls):
                                func = tc.get("function", {})
                                if func.get("name") == "web_search":
                                    query = func.get("arguments", {}).get("query", text)
                                    log.info("Tool call: web_search(%r)", query)

                                    await ws.send_json({"type": "agent_reply",
                                                        "text": LOOKUP_PHRASE})
                                    await session.speak_text(LOOKUP_PHRASE,
                                                             voice_id=tts_voice)
                                    await ws.send_json({"type": "agent_searching"})

                                    try:
                                        search_result = await web_search(query)
                                        if search_result:
                                            context = format_results_for_context(
                                                search_result)
                                            log.info(
                                                "Search via %s: %d results for %r",
                                                search_result["provider"],
                                                len(search_result["results"]),
                                                query[:60],
                                            )
                                            # Build tool result messages
                                            tool_msgs = build_tool_result_messages(
                                                active_provider, tool_calls,
                                                {i: context}, reply,
                                            )
                                            await ws.send_json(
                                                {"type": "agent_thinking"})
                                            reply, _ = await llm_generate_with_tools(
                                                conversation.system,
                                                messages + tool_msgs,
                                                [],  # no tools on followup
                                                llm_provider, llm_model,
                                            )
                                            search_performed = True
                                    except Exception as e:
                                        log.warning("Tool search failed: %s", e)

                        # ── Safety net: model didn't use tools but hedged ──
                        if (not search_performed and not tool_calls
                                and use_tools and _reply_is_hedging(reply)):
                            log.info("LLM hedged without tools, safety net search")
                            search_query = await _extract_search_query(
                                text, llm_provider, llm_model)

                            await ws.send_json({"type": "agent_reply",
                                                "text": LOOKUP_PHRASE})
                            await session.speak_text(LOOKUP_PHRASE,
                                                     voice_id=tts_voice)
                            await ws.send_json({"type": "agent_searching"})
                            try:
                                search_result = await web_search(search_query)
                                if search_result:
                                    context = format_results_for_context(
                                        search_result)
                                    log.info("Safety net search via %s: %d results",
                                             search_result["provider"],
                                             len(search_result["results"]))
                                    # Inject as assistant message (fallback path)
                                    search_msgs = messages + [{
                                        "role": "assistant",
                                        "content": (
                                            "I searched the web and found:\n\n"
                                            + context
                                            + "\nI'll use these results to answer."
                                        ),
                                    }]
                                    await ws.send_json({"type": "agent_thinking"})
                                    reply = await llm_generate(
                                        conversation.system, search_msgs,
                                        llm_provider, llm_model,
                                    )
                            except Exception as e:
                                log.warning("Safety net search failed: %s", e)

                        conversation.add_turn("assistant", reply)
                        await ws.send_json({"type": "agent_reply", "text": reply})
                        log.info("Agent reply: %r (voice=%s)", reply[:80], tts_voice)
                        await session.speak_text(reply, voice_id=tts_voice)
                    except Exception as e:
                        log.error("LLM error: %s", e)
                        await ws.send_json({"type": "error", "message": f"LLM error: {e}"})
            else:
                await ws.send_json({"type": "error", "message": "No WebRTC session"})

        elif msg_type == "set_search_enabled":
            search_enabled = msg.get("enabled", True)
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

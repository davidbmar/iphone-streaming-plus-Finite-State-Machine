"""Admin dashboard — HTTP routes, REST API, and live-log WebSocket.

Provides endpoints for managing sessions, tools, search providers,
RAG endpoints, server config, and tailing the server log in real time.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from pathlib import Path

from aiohttp import web

from gateway import db
from gateway.auth import authenticate_session_token
from voice_assistant.tools import TOOL_REGISTRY

log = logging.getLogger("admin")

AUTH_TOKEN = os.getenv("AUTH_TOKEN", "devtoken")
WEB_DIR = Path(__file__).resolve().parent.parent / "web"
LOG_FILE = Path(__file__).resolve().parent.parent / "logs" / "server.log"

# Search provider definitions (label + env-var for key detection)
_SEARCH_PROVIDERS = [
    {"name": "serper",     "label": "Serper (Google)",  "env": "SERPER_API_KEY"},
    {"name": "tavily",     "label": "Tavily",           "env": "TAVILY_API_KEY"},
    {"name": "brave",      "label": "Brave Search",     "env": "BRAVE_API_KEY"},
    {"name": "duckduckgo", "label": "DuckDuckGo",       "env": None},  # no key needed
]

# Config keys that may be written via PUT /api/admin/config
_ALLOWED_CONFIG_KEYS = {
    "default_llm_provider",
    "default_llm_model",
    "web_search_enabled",
    "search_providers_json",
    "disabled_tools_json",
}


# ---------------------------------------------------------------------------
# Auth helper
# ---------------------------------------------------------------------------

class _AuthCtx:
    """Result of _check_auth: who is making the request."""
    __slots__ = ("is_admin", "user_id")

    def __init__(self, is_admin: bool, user_id: int | None):
        self.is_admin = is_admin
        self.user_id = user_id


def _check_auth(request: web.Request) -> _AuthCtx:
    """Authenticate via admin token OR user session token.

    Admin token → full access (is_admin=True, user_id=None).
    Session token → user-scoped access (is_admin=False, user_id=N).
    Neither valid → raise 401.
    """
    token = (
        request.query.get("token", "")
        or request.headers.get("X-Auth-Token", "")
    )

    # 1. Check admin token
    if token and token == AUTH_TOKEN:
        return _AuthCtx(is_admin=True, user_id=None)

    # 2. Check user session token (header or query param for WebSocket)
    session_token = (
        request.headers.get("X-Session-Token", "")
        or request.query.get("session_token", "")
    )
    if session_token:
        result = authenticate_session_token(session_token)
        if result:
            user_id, _user_info = result
            return _AuthCtx(is_admin=False, user_id=user_id)

    raise web.HTTPUnauthorized(text="Bad token")


# ---------------------------------------------------------------------------
# 1. Admin page
# ---------------------------------------------------------------------------

async def handle_admin_page(request: web.Request) -> web.Response:
    """GET /admin — serve the admin SPA.

    The page itself is public (static HTML/JS/CSS). All API endpoints
    are authenticated, and the JS shows an auth gate for unauthenticated
    users. This allows Google-authenticated users to access the dashboard
    without knowing the admin token.
    """
    html_path = WEB_DIR / "admin.html"
    if not html_path.exists():
        raise web.HTTPNotFound(text="admin.html not found")
    return web.Response(text=html_path.read_text(), content_type="text/html")


async def handle_admin_me(request: web.Request) -> web.Response:
    """GET /api/admin/me — return current auth context."""
    auth = _check_auth(request)
    if auth.is_admin:
        return web.json_response({"role": "admin", "user": None})
    user = db.get_user(auth.user_id)
    return web.json_response({
        "role": "user",
        "user": {
            "id": user["id"],
            "name": user["name"],
            "email": user["email"],
            "avatar_url": user["avatar_url"],
        } if user else None,
    })


# ---------------------------------------------------------------------------
# 2. Sessions API
# ---------------------------------------------------------------------------

async def handle_list_sessions(request: web.Request) -> web.Response:
    """GET /api/admin/sessions — admin sees all, user sees own."""
    auth = _check_auth(request)
    limit = int(request.query.get("limit", "50"))
    offset = int(request.query.get("offset", "0"))
    search = request.query.get("search") or None
    uid = None if auth.is_admin else auth.user_id
    rows = db.list_sessions(limit=limit, offset=offset, search=search, user_id=uid)
    return web.json_response(rows)


async def handle_get_session(request: web.Request) -> web.Response:
    """GET /api/admin/sessions/{id} — user can only view own sessions."""
    auth = _check_auth(request)
    session_id = request.match_info["id"]
    uid = None if auth.is_admin else auth.user_id
    session = db.get_session(session_id, user_id=uid)
    if session is None:
        raise web.HTTPNotFound(text="Session not found")
    return web.json_response(session)


async def handle_delete_sessions(request: web.Request) -> web.Response:
    """DELETE /api/admin/sessions — user deletes own, admin deletes all."""
    auth = _check_auth(request)
    uid = None if auth.is_admin else auth.user_id
    db.delete_all_sessions(user_id=uid)
    return web.json_response({"status": "cleared"})


# ---------------------------------------------------------------------------
# 3. Tools API
# ---------------------------------------------------------------------------

async def handle_list_tools(request: web.Request) -> web.Response:
    """GET /api/admin/tools"""
    _check_auth(request)
    disabled_raw = db.get_config("disabled_tools_json", "[]")
    try:
        disabled: list = json.loads(disabled_raw)
    except (json.JSONDecodeError, TypeError):
        disabled = []

    tools = []
    for name, tool in TOOL_REGISTRY.items():
        tools.append({
            "name": name,
            "description": getattr(tool, "description", ""),
            "enabled": name not in disabled,
        })
    return web.json_response(tools)


async def handle_toggle_tool(request: web.Request) -> web.Response:
    """POST /api/admin/tools/{name}/toggle"""
    _check_auth(request)
    tool_name = request.match_info["name"]
    if tool_name not in TOOL_REGISTRY:
        raise web.HTTPNotFound(text=f"Tool not found: {tool_name}")

    disabled_raw = db.get_config("disabled_tools_json", "[]")
    try:
        disabled: list = json.loads(disabled_raw)
    except (json.JSONDecodeError, TypeError):
        disabled = []

    if tool_name in disabled:
        disabled.remove(tool_name)
        enabled = True
    else:
        disabled.append(tool_name)
        enabled = False

    db.set_config("disabled_tools_json", json.dumps(disabled))
    return web.json_response({"name": tool_name, "enabled": enabled})


# ---------------------------------------------------------------------------
# 4. Search Providers API
# ---------------------------------------------------------------------------

async def handle_list_search_providers(request: web.Request) -> web.Response:
    """GET /api/admin/search-providers"""
    _check_auth(request)
    master = db.get_config("web_search_enabled", "true")
    master_enabled = master.lower() in ("true", "1", "yes")

    enabled_raw = db.get_config("search_providers_json",
                                '["serper","tavily","brave","duckduckgo"]')
    try:
        enabled_list: list = json.loads(enabled_raw)
    except (json.JSONDecodeError, TypeError):
        enabled_list = []

    providers = []
    for p in _SEARCH_PROVIDERS:
        has_key = True if p["env"] is None else bool(os.getenv(p["env"], ""))
        providers.append({
            "name": p["name"],
            "label": p["label"],
            "has_key": has_key,
            "enabled": p["name"] in enabled_list,
        })

    return web.json_response({
        "master_enabled": master_enabled,
        "providers": providers,
    })


async def handle_toggle_search_provider(request: web.Request) -> web.Response:
    """POST /api/admin/search-providers/{name}/toggle"""
    _check_auth(request)
    name = request.match_info["name"]

    if name == "_master":
        current = db.get_config("web_search_enabled", "true")
        new_val = "false" if current.lower() in ("true", "1", "yes") else "true"
        db.set_config("web_search_enabled", new_val)
        return web.json_response({
            "master_enabled": new_val == "true",
        })

    # Validate provider name
    valid_names = {p["name"] for p in _SEARCH_PROVIDERS}
    if name not in valid_names:
        raise web.HTTPNotFound(text=f"Unknown provider: {name}")

    enabled_raw = db.get_config("search_providers_json",
                                '["serper","tavily","brave","duckduckgo"]')
    try:
        enabled_list: list = json.loads(enabled_raw)
    except (json.JSONDecodeError, TypeError):
        enabled_list = []

    if name in enabled_list:
        enabled_list.remove(name)
        enabled = False
    else:
        enabled_list.append(name)
        enabled = True

    db.set_config("search_providers_json", json.dumps(enabled_list))
    return web.json_response({"name": name, "enabled": enabled})


# ---------------------------------------------------------------------------
# 5. RAG API
# ---------------------------------------------------------------------------

async def handle_list_rag(request: web.Request) -> web.Response:
    """GET /api/admin/rag"""
    _check_auth(request)
    return web.json_response(db.list_rag_endpoints())


async def handle_add_rag(request: web.Request) -> web.Response:
    """POST /api/admin/rag"""
    _check_auth(request)
    body = await request.json()
    new_id = db.add_rag_endpoint(
        name=body.get("name", ""),
        url=body.get("url", ""),
        description=body.get("description", ""),
        upload_url=body.get("upload_url", ""),
    )
    return web.json_response({"id": new_id}, status=201)


async def handle_update_rag(request: web.Request) -> web.Response:
    """PUT /api/admin/rag/{id}"""
    _check_auth(request)
    rag_id = int(request.match_info["id"])
    body = await request.json()
    db.update_rag_endpoint(rag_id, **body)
    return web.json_response({"status": "updated"})


async def handle_delete_rag(request: web.Request) -> web.Response:
    """DELETE /api/admin/rag/{id}"""
    _check_auth(request)
    rag_id = int(request.match_info["id"])
    db.delete_rag_endpoint(rag_id)
    return web.json_response({"status": "deleted"})


async def handle_rag_health(request: web.Request) -> web.Response:
    """POST /api/admin/rag/{id}/health — ping the RAG endpoint."""
    _check_auth(request)
    rag_id = int(request.match_info["id"])

    endpoints = db.list_rag_endpoints()
    endpoint = next((e for e in endpoints if e["id"] == rag_id), None)
    if endpoint is None:
        raise web.HTTPNotFound(text="RAG endpoint not found")

    url = endpoint["url"].rstrip("/") + "/health"
    healthy = False
    try:
        import httpx
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(url)
            healthy = resp.status_code < 400
    except Exception:
        healthy = False

    if healthy:
        from datetime import datetime, timezone
        db.update_rag_endpoint(rag_id, last_health=datetime.now(timezone.utc).isoformat())

    return web.json_response({
        "id": rag_id,
        "healthy": healthy,
        "url": url,
    })


# ---------------------------------------------------------------------------
# 6. Config & Stats API
# ---------------------------------------------------------------------------

async def handle_get_config(request: web.Request) -> web.Response:
    """GET /api/admin/config"""
    _check_auth(request)

    # Import inside handler to avoid circular imports
    from gateway.server import _START_TIME, PORT

    all_cfg = db.get_all_config()
    uptime = round(time.time() - _START_TIME, 1) if _START_TIME else 0
    log_size = LOG_FILE.stat().st_size if LOG_FILE.exists() else 0

    return web.json_response({
        "config": all_cfg,
        "server": {
            "uptime": uptime,
            "port": PORT,
            "https": bool(os.getenv("HTTPS")),
            "log_size_bytes": log_size,
        },
        "llm": {
            "anthropic_key_set": bool(os.getenv("ANTHROPIC_API_KEY", "")),
            "openai_key_set": bool(os.getenv("OPENAI_API_KEY", "")),
            "ollama_url": os.getenv("OLLAMA_URL", "http://localhost:11434"),
        },
    })


async def handle_put_config(request: web.Request) -> web.Response:
    """PUT /api/admin/config — update allowed admin config keys."""
    _check_auth(request)
    body = await request.json()

    updated = {}
    for key, value in body.items():
        if key in _ALLOWED_CONFIG_KEYS:
            db.set_config(key, str(value))
            updated[key] = str(value)

    return web.json_response({"updated": updated})


# ---------------------------------------------------------------------------
# 7. Logs API
# ---------------------------------------------------------------------------

def _read_log_lines(limit: int = 200,
                    level: str | None = None,
                    search: str | None = None) -> tuple[list[str], int]:
    """Read last *limit* lines from server.log, optionally filtering."""
    if not LOG_FILE.exists():
        return [], 0

    with open(LOG_FILE, "r", encoding="utf-8", errors="replace") as f:
        all_lines = f.readlines()

    total = len(all_lines)

    # Take tail first, then filter
    tail = all_lines[-limit:] if limit < total else all_lines

    filtered = []
    for line in tail:
        if level and level.upper() not in line:
            continue
        if search and search.lower() not in line.lower():
            continue
        filtered.append(line.rstrip("\n"))

    return filtered, total


async def handle_get_logs(request: web.Request) -> web.Response:
    """GET /api/admin/logs"""
    _check_auth(request)
    limit = int(request.query.get("limit", "200"))
    level = request.query.get("level") or None
    search = request.query.get("search") or None

    lines, total = _read_log_lines(limit=limit, level=level, search=search)
    return web.json_response({"lines": lines, "total": total})


# ---------------------------------------------------------------------------
# 8. Live Log WebSocket
# ---------------------------------------------------------------------------

async def handle_admin_ws(request: web.Request) -> web.WebSocketResponse:
    """GET /admin/ws — stream new log lines over WebSocket."""
    _check_auth(request)

    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(request)
    log.info("Admin log WS connected from %s", request.remote)

    # Send last 100 lines on connect
    lines, _ = _read_log_lines(limit=100)
    for line in lines:
        if ws.closed:
            return ws
        await ws.send_str(line)

    # Tail the file: seek to end and poll for new lines
    if not LOG_FILE.exists():
        await ws.close()
        return ws

    try:
        with open(LOG_FILE, "r", encoding="utf-8", errors="replace") as f:
            f.seek(0, 2)  # seek to end
            while not ws.closed:
                line = f.readline()
                if line:
                    await ws.send_str(line.rstrip("\n"))
                else:
                    await asyncio.sleep(0.5)
    except asyncio.CancelledError:
        pass
    except Exception as exc:
        log.warning("Admin log WS error: %s", exc)
    finally:
        if not ws.closed:
            await ws.close()

    log.info("Admin log WS disconnected")
    return ws


# ---------------------------------------------------------------------------
# Route registration
# ---------------------------------------------------------------------------

def register_admin_routes(app: web.Application) -> None:
    """Add all admin routes to the aiohttp application."""
    # Admin page
    app.router.add_get("/admin", handle_admin_page)

    # Auth context
    app.router.add_get("/api/admin/me", handle_admin_me)

    # Live log WebSocket
    app.router.add_get("/admin/ws", handle_admin_ws)

    # Sessions
    app.router.add_get("/api/admin/sessions", handle_list_sessions)
    app.router.add_get("/api/admin/sessions/{id}", handle_get_session)
    app.router.add_delete("/api/admin/sessions", handle_delete_sessions)

    # Tools
    app.router.add_get("/api/admin/tools", handle_list_tools)
    app.router.add_post("/api/admin/tools/{name}/toggle", handle_toggle_tool)

    # Search providers
    app.router.add_get("/api/admin/search-providers", handle_list_search_providers)
    app.router.add_post("/api/admin/search-providers/{name}/toggle",
                        handle_toggle_search_provider)

    # RAG endpoints
    app.router.add_get("/api/admin/rag", handle_list_rag)
    app.router.add_post("/api/admin/rag", handle_add_rag)
    app.router.add_put("/api/admin/rag/{id}", handle_update_rag)
    app.router.add_delete("/api/admin/rag/{id}", handle_delete_rag)
    app.router.add_post("/api/admin/rag/{id}/health", handle_rag_health)

    # Config & stats
    app.router.add_get("/api/admin/config", handle_get_config)
    app.router.add_put("/api/admin/config", handle_put_config)

    # Logs
    app.router.add_get("/api/admin/logs", handle_get_logs)

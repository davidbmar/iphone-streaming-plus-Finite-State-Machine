# Admin Dashboard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `/admin` dashboard with conversation history, live logs, RAG/tool management, and server controls.

**Architecture:** SQLite database records all conversations automatically. Admin page served as separate HTML page with vanilla JS. Admin API endpoints provide data and control plane. Live log streaming via WebSocket.

**Tech Stack:** Python aiohttp (existing), SQLite3 (stdlib), vanilla JS + art-deco CSS (existing theme).

**Design doc:** `docs/plans/2026-02-18-admin-dashboard-design.md`

---

### Task 1: SQLite Database Module

**Files:**
- Create: `gateway/db.py`
- Test: `scripts/test_db.py`

**Step 1: Create the database module**

Create `gateway/db.py` with all four tables and CRUD operations. Uses Python's built-in `sqlite3`. Thread-safe via one connection per call (SQLite handles file locking). All timestamps are ISO 8601 UTC.

```python
"""Admin database — SQLite storage for conversations, RAG registry, and config."""

import json
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "logs" / "admin.db"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    started_at  TEXT NOT NULL,
    ended_at    TEXT,
    client_ip   TEXT,
    timezone    TEXT,
    llm_provider TEXT,
    llm_model   TEXT,
    voice       TEXT,
    turn_count  INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS turns (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL REFERENCES sessions(id),
    timestamp       TEXT NOT NULL,
    role            TEXT NOT NULL,
    text            TEXT NOT NULL,
    audio_duration_s REAL,
    rms             REAL,
    peak            INTEGER,
    no_speech_prob  REAL,
    avg_logprob     REAL,
    model_used      TEXT,
    workflow_used   TEXT,
    tool_calls_json TEXT
);

CREATE TABLE IF NOT EXISTS rag_endpoints (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    url         TEXT NOT NULL,
    description TEXT,
    upload_url  TEXT,
    active      INTEGER DEFAULT 1,
    created_at  TEXT NOT NULL,
    last_health TEXT
);

CREATE TABLE IF NOT EXISTS admin_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def _connect():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    DB_PATH.parent.mkdir(exist_ok=True)
    with _connect() as conn:
        conn.executescript(_SCHEMA)
    # Seed default config if empty
    defaults = {
        "web_search_enabled": "true",
        "search_providers_json": json.dumps(["serper", "tavily", "brave", "duckduckgo"]),
        "disabled_tools_json": json.dumps([]),
        "default_llm_provider": "",
        "default_llm_model": "",
    }
    with _connect() as conn:
        for k, v in defaults.items():
            conn.execute(
                "INSERT OR IGNORE INTO admin_config (key, value) VALUES (?, ?)",
                (k, v),
            )


# ── Sessions ──────────────────────────────────────────────

def create_session(client_ip="", timezone="", llm_provider="", llm_model="", voice=""):
    sid = str(uuid.uuid4())
    now = datetime.now(timezone_module.utc).isoformat()  # fixed below
    with _connect() as conn:
        conn.execute(
            "INSERT INTO sessions (id, started_at, client_ip, timezone, llm_provider, llm_model, voice) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (sid, now, client_ip, timezone, llm_provider, llm_model, voice),
        )
    return sid


def end_session(session_id):
    now = datetime.now(timezone.utc).isoformat()
    with _connect() as conn:
        conn.execute("UPDATE sessions SET ended_at = ? WHERE id = ?", (now, session_id))
        count = conn.execute("SELECT COUNT(*) FROM turns WHERE session_id = ?", (session_id,)).fetchone()[0]
        conn.execute("UPDATE sessions SET turn_count = ? WHERE id = ?", (count, session_id))


def list_sessions(limit=50, offset=0, search=""):
    with _connect() as conn:
        if search:
            rows = conn.execute(
                "SELECT s.*, (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id) as turn_count "
                "FROM sessions s WHERE s.id IN (SELECT DISTINCT session_id FROM turns WHERE text LIKE ?) "
                "ORDER BY s.started_at DESC LIMIT ? OFFSET ?",
                (f"%{search}%", limit, offset),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT *, (SELECT COUNT(*) FROM turns t WHERE t.session_id = sessions.id) as turn_count "
                "FROM sessions ORDER BY started_at DESC LIMIT ? OFFSET ?",
                (limit, offset),
            ).fetchall()
    return [dict(r) for r in rows]


def get_session(session_id):
    with _connect() as conn:
        session = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if not session:
            return None
        turns = conn.execute(
            "SELECT * FROM turns WHERE session_id = ? ORDER BY timestamp ASC",
            (session_id,),
        ).fetchall()
    return {"session": dict(session), "turns": [dict(t) for t in turns]}


def delete_all_sessions():
    with _connect() as conn:
        conn.execute("DELETE FROM turns")
        conn.execute("DELETE FROM sessions")


# ── Turns ─────────────────────────────────────────────────

def add_turn(session_id, role, text, **kwargs):
    now = datetime.now(timezone.utc).isoformat()
    with _connect() as conn:
        conn.execute(
            "INSERT INTO turns (session_id, timestamp, role, text, audio_duration_s, rms, peak, "
            "no_speech_prob, avg_logprob, model_used, workflow_used, tool_calls_json) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                session_id, now, role, text,
                kwargs.get("audio_duration_s"),
                kwargs.get("rms"),
                kwargs.get("peak"),
                kwargs.get("no_speech_prob"),
                kwargs.get("avg_logprob"),
                kwargs.get("model_used"),
                kwargs.get("workflow_used"),
                kwargs.get("tool_calls_json"),
            ),
        )


# ── RAG Endpoints ─────────────────────────────────────────

def list_rag_endpoints():
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM rag_endpoints ORDER BY id").fetchall()
    return [dict(r) for r in rows]


def add_rag_endpoint(name, url, description="", upload_url=""):
    now = datetime.now(timezone.utc).isoformat()
    with _connect() as conn:
        conn.execute(
            "INSERT INTO rag_endpoints (name, url, description, upload_url, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (name, url, description, upload_url, now),
        )
        return conn.execute("SELECT last_insert_rowid()").fetchone()[0]


def update_rag_endpoint(rag_id, **kwargs):
    allowed = {"name", "url", "description", "upload_url", "active", "last_health"}
    updates = {k: v for k, v in kwargs.items() if k in allowed}
    if not updates:
        return
    set_clause = ", ".join(f"{k} = ?" for k in updates)
    with _connect() as conn:
        conn.execute(
            f"UPDATE rag_endpoints SET {set_clause} WHERE id = ?",
            (*updates.values(), rag_id),
        )


def delete_rag_endpoint(rag_id):
    with _connect() as conn:
        conn.execute("DELETE FROM rag_endpoints WHERE id = ?", (rag_id,))


# ── Admin Config ──────────────────────────────────────────

def get_config(key, default=""):
    with _connect() as conn:
        row = conn.execute("SELECT value FROM admin_config WHERE key = ?", (key,)).fetchone()
    return row[0] if row else default


def set_config(key, value):
    with _connect() as conn:
        conn.execute(
            "INSERT INTO admin_config (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )


def get_all_config():
    with _connect() as conn:
        rows = conn.execute("SELECT key, value FROM admin_config").fetchall()
    return {r[0]: r[1] for r in rows}
```

**Note:** The `timezone` import conflict with the parameter name needs fixing — use `from datetime import datetime, timezone as tz_utc` or similar. The actual implementation should use `datetime.now(timezone.utc)` correctly.

**Step 2: Write a smoke test**

Create `scripts/test_db.py`:

```python
"""Smoke test for admin database module."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from gateway.db import init_db, create_session, add_turn, end_session, list_sessions, get_session
from gateway.db import add_rag_endpoint, list_rag_endpoints, get_config, set_config, DB_PATH

# Use a temp DB
import tempfile, gateway.db as db
db.DB_PATH = type(DB_PATH)(tempfile.mktemp(suffix=".db"))

init_db()
print("1. DB initialized at", db.DB_PATH)

sid = create_session(client_ip="127.0.0.1", timezone="America/Chicago", llm_provider="claude", llm_model="haiku")
print(f"2. Session created: {sid[:8]}...")

add_turn(sid, "user", "What time is it?", audio_duration_s=2.1, rms=450.0, peak=12000)
add_turn(sid, "agent", "It's 3:00 PM Central Time.", model_used="claude-haiku-4-5-20251001")
print("3. Two turns added")

end_session(sid)
sessions = list_sessions()
assert len(sessions) == 1
assert sessions[0]["turn_count"] == 2
print(f"4. Session listed: {sessions[0]['turn_count']} turns")

detail = get_session(sid)
assert len(detail["turns"]) == 2
assert detail["turns"][0]["text"] == "What time is it?"
assert detail["turns"][1]["text"] == "It's 3:00 PM Central Time."
print(f"5. Session detail: user said '{detail['turns'][0]['text']}'")

rag_id = add_rag_endpoint("GitHub RAG", "http://localhost:8100", "Main knowledge base", "http://localhost:8100/docs")
rags = list_rag_endpoints()
assert len(rags) == 1
print(f"6. RAG endpoint added: {rags[0]['name']} at {rags[0]['url']}")

set_config("web_search_enabled", "false")
assert get_config("web_search_enabled") == "false"
print("7. Config set/get works")

os.unlink(str(db.DB_PATH))
print("\nAll tests passed!")
```

**Step 3: Run the smoke test**

Run: `python scripts/test_db.py`
Expected: "All tests passed!"

**Step 4: Commit**

```bash
git add gateway/db.py scripts/test_db.py
git commit -m "feat: add SQLite admin database module

Session: S-2026-02-18-admin-dashboard"
```

---

### Task 2: Conversation Recording in Server

**Files:**
- Modify: `gateway/server.py` — add recording calls to the WS handler

**Step 1: Add DB imports and session tracking to `handle_ws`**

At the top of `gateway/server.py`, add import:
```python
from gateway.db import init_db, create_session, add_turn, end_session as db_end_session
```

In `handle_ws`, after the `hello` message is processed and `hello_ack` is sent (around line 324), create a DB session:
```python
# After hello_ack is sent:
db_session_id = create_session(
    client_ip=request.remote or "",
    timezone=client_tz,
    llm_provider=llm_provider,
    llm_model=llm_model,
    voice=tts_voice,
)
```

Initialize `db_session_id = None` at the top of `handle_ws` alongside the other state variables.

**Step 2: Record user turns after final transcription**

In the `mic_stop` handler (around line 454), after `log.info("Final transcription: ...")`:
```python
if db_session_id and text.strip():
    add_turn(db_session_id, "user", text,
             audio_duration_s=audio_duration_s,
             rms=getattr(session, '_last_rms', None),
             peak=getattr(session, '_last_peak', None),
             no_speech_prob=no_speech_prob,
             avg_logprob=avg_logprob)
```

**Step 3: Record agent turns after reply**

In `_do_agent_reply`, after the `log.info("Agent reply: ...")` line (around line 232):
```python
if db_session_id:
    add_turn(db_session_id, "agent", reply,
             model_used=f"{llm_provider}/{llm_model}",
             workflow_used=getattr(runner, '_last_workflow_id', None))
```

**Step 4: End session on disconnect**

In the cleanup block at the end of `handle_ws` (around line 488):
```python
if db_session_id:
    db_end_session(db_session_id)
```

**Step 5: Initialize DB on startup**

In `create_app()` (around line 494), add:
```python
init_db()
```

**Step 6: Add admin URL log on startup**

In the `__main__` block, after the existing "Serving on" log lines (around line 557):
```python
log.info("Admin dashboard: http://localhost:%d/admin", PORT)
```

**Step 7: Test manually**

Run: `python -m gateway.server`
Expected: startup output includes "Admin dashboard: http://localhost:8080/admin"
Connect with a client, speak a message, check that `logs/admin.db` is created and has data:
```bash
sqlite3 logs/admin.db "SELECT * FROM sessions; SELECT * FROM turns;"
```

**Step 8: Commit**

```bash
git add gateway/server.py
git commit -m "feat: auto-record conversations to SQLite

Session: S-2026-02-18-admin-dashboard"
```

---

### Task 3: Admin API Routes

**Files:**
- Create: `gateway/admin.py`

**Step 1: Create the admin routes module**

This file handles all `/admin` and `/api/admin/*` routes. It also serves the admin HTML page and provides the live log WebSocket.

```python
"""Admin dashboard — HTTP routes, API endpoints, and live log WebSocket."""

import asyncio
import json
import logging
import os
import time
from pathlib import Path

import httpx
from aiohttp import web

from gateway import db
from voice_assistant.tools import TOOL_REGISTRY

log = logging.getLogger("admin")

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
LOG_FILE = Path(__file__).resolve().parent.parent / "logs" / "server.log"
AUTH_TOKEN = os.getenv("AUTH_TOKEN", "devtoken")


def _check_auth(request):
    """Check auth token from query param or header."""
    token = request.query.get("token", "") or request.headers.get("X-Auth-Token", "")
    if token != AUTH_TOKEN:
        raise web.HTTPUnauthorized(text="Bad token")


# ── Page ──────────────────────────────────────────────────

async def handle_admin_page(request):
    _check_auth(request)
    html = (WEB_DIR / "admin.html").read_text()
    return web.Response(text=html, content_type="text/html")


# ── Sessions API ──────────────────────────────────────────

async def handle_list_sessions(request):
    _check_auth(request)
    limit = int(request.query.get("limit", "50"))
    offset = int(request.query.get("offset", "0"))
    search = request.query.get("search", "")
    sessions = db.list_sessions(limit=limit, offset=offset, search=search)
    return web.json_response(sessions)


async def handle_get_session(request):
    _check_auth(request)
    session_id = request.match_info["id"]
    data = db.get_session(session_id)
    if not data:
        raise web.HTTPNotFound(text="Session not found")
    return web.json_response(data)


async def handle_clear_sessions(request):
    _check_auth(request)
    db.delete_all_sessions()
    return web.json_response({"status": "cleared"})


# ── Tools API ─────────────────────────────────────────────

async def handle_list_tools(request):
    _check_auth(request)
    disabled = json.loads(db.get_config("disabled_tools_json", "[]"))
    tools = []
    for name, tool in TOOL_REGISTRY.items():
        tools.append({
            "name": name,
            "description": tool.description,
            "enabled": name not in disabled,
        })
    return web.json_response(tools)


async def handle_toggle_tool(request):
    _check_auth(request)
    name = request.match_info["name"]
    if name not in TOOL_REGISTRY:
        raise web.HTTPNotFound(text=f"Unknown tool: {name}")
    disabled = json.loads(db.get_config("disabled_tools_json", "[]"))
    if name in disabled:
        disabled.remove(name)
        enabled = True
    else:
        disabled.append(name)
        enabled = False
    db.set_config("disabled_tools_json", json.dumps(disabled))
    return web.json_response({"name": name, "enabled": enabled})


# ── Search Providers API ──────────────────────────────────

async def handle_list_search_providers(request):
    _check_auth(request)
    enabled_list = json.loads(db.get_config("search_providers_json", '["serper","tavily","brave","duckduckgo"]'))
    master_enabled = db.get_config("web_search_enabled", "true") == "true"
    providers = [
        {"name": "serper", "label": "Serper (Google)", "has_key": bool(os.getenv("SERPER_API_KEY", "")),
         "enabled": "serper" in enabled_list},
        {"name": "tavily", "label": "Tavily", "has_key": bool(os.getenv("TAVILY_API_KEY", "")),
         "enabled": "tavily" in enabled_list},
        {"name": "brave", "label": "Brave", "has_key": bool(os.getenv("BRAVE_API_KEY", "")),
         "enabled": "brave" in enabled_list},
        {"name": "duckduckgo", "label": "DuckDuckGo", "has_key": True,
         "enabled": "duckduckgo" in enabled_list},
    ]
    return web.json_response({"master_enabled": master_enabled, "providers": providers})


async def handle_toggle_search_provider(request):
    _check_auth(request)
    name = request.match_info["name"]
    if name == "_master":
        current = db.get_config("web_search_enabled", "true")
        new_val = "false" if current == "true" else "true"
        db.set_config("web_search_enabled", new_val)
        return web.json_response({"master_enabled": new_val == "true"})
    enabled_list = json.loads(db.get_config("search_providers_json", '["serper","tavily","brave","duckduckgo"]'))
    if name in enabled_list:
        enabled_list.remove(name)
    else:
        enabled_list.append(name)
    db.set_config("search_providers_json", json.dumps(enabled_list))
    return web.json_response({"name": name, "enabled": name in enabled_list})


# ── RAG API ───────────────────────────────────────────────

async def handle_list_rag(request):
    _check_auth(request)
    return web.json_response(db.list_rag_endpoints())


async def handle_add_rag(request):
    _check_auth(request)
    body = await request.json()
    rag_id = db.add_rag_endpoint(
        name=body.get("name", ""),
        url=body.get("url", ""),
        description=body.get("description", ""),
        upload_url=body.get("upload_url", ""),
    )
    return web.json_response({"id": rag_id, "status": "created"})


async def handle_update_rag(request):
    _check_auth(request)
    rag_id = int(request.match_info["id"])
    body = await request.json()
    db.update_rag_endpoint(rag_id, **body)
    return web.json_response({"status": "updated"})


async def handle_delete_rag(request):
    _check_auth(request)
    rag_id = int(request.match_info["id"])
    db.delete_rag_endpoint(rag_id)
    return web.json_response({"status": "deleted"})


async def handle_rag_health(request):
    _check_auth(request)
    rag_id = int(request.match_info["id"])
    endpoints = db.list_rag_endpoints()
    endpoint = next((e for e in endpoints if e["id"] == rag_id), None)
    if not endpoint:
        raise web.HTTPNotFound(text="RAG endpoint not found")
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(endpoint["url"].rstrip("/") + "/health")
            healthy = resp.status_code == 200
    except Exception:
        healthy = False
    if healthy:
        from datetime import datetime, timezone
        db.update_rag_endpoint(rag_id, last_health=datetime.now(timezone.utc).isoformat())
    return web.json_response({"id": rag_id, "healthy": healthy, "url": endpoint["url"]})


# ── Config & Stats API ────────────────────────────────────

async def handle_get_config(request):
    _check_auth(request)
    from gateway.server import _START_TIME, PORT
    config = db.get_all_config()
    uptime = round(time.time() - _START_TIME, 1) if _START_TIME else 0
    log_size = LOG_FILE.stat().st_size if LOG_FILE.exists() else 0
    return web.json_response({
        "config": config,
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


async def handle_update_config(request):
    _check_auth(request)
    body = await request.json()
    allowed_keys = {"default_llm_provider", "default_llm_model", "web_search_enabled",
                    "search_providers_json", "disabled_tools_json"}
    for k, v in body.items():
        if k in allowed_keys:
            db.set_config(k, str(v) if not isinstance(v, str) else v)
    return web.json_response({"status": "updated"})


# ── Logs API ──────────────────────────────────────────────

async def handle_get_logs(request):
    _check_auth(request)
    limit = int(request.query.get("limit", "200"))
    level = request.query.get("level", "").upper()
    search = request.query.get("search", "")
    if not LOG_FILE.exists():
        return web.json_response({"lines": []})
    with open(LOG_FILE, "r") as f:
        all_lines = f.readlines()
    lines = all_lines[-limit:]
    if level:
        lines = [l for l in lines if level in l]
    if search:
        lines = [l for l in lines if search.lower() in l.lower()]
    return web.json_response({"lines": [l.rstrip() for l in lines], "total": len(all_lines)})


# ── Live Log WebSocket ────────────────────────────────────

async def handle_admin_ws(request):
    token = request.query.get("token", "")
    if token != AUTH_TOKEN:
        return web.Response(status=401, text="Bad token")
    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(request)
    log.info("Admin log viewer connected")

    # Tail the log file
    if not LOG_FILE.exists():
        await ws.close()
        return ws

    with open(LOG_FILE, "r") as f:
        # Send last 100 lines as initial batch
        all_lines = f.readlines()
        for line in all_lines[-100:]:
            await ws.send_str(line.rstrip())
        # Now tail for new lines
        f.seek(0, 2)  # seek to end
        try:
            while not ws.closed:
                line = f.readline()
                if line:
                    await ws.send_str(line.rstrip())
                else:
                    await asyncio.sleep(0.5)
        except Exception:
            pass

    log.info("Admin log viewer disconnected")
    return ws


# ── Route registration ────────────────────────────────────

def register_admin_routes(app):
    """Register all admin routes on the aiohttp app."""
    app.router.add_get("/admin", handle_admin_page)
    app.router.add_get("/admin/ws", handle_admin_ws)
    app.router.add_get("/api/admin/sessions", handle_list_sessions)
    app.router.add_get("/api/admin/sessions/{id}", handle_get_session)
    app.router.add_delete("/api/admin/sessions", handle_clear_sessions)
    app.router.add_get("/api/admin/tools", handle_list_tools)
    app.router.add_post("/api/admin/tools/{name}/toggle", handle_toggle_tool)
    app.router.add_get("/api/admin/search-providers", handle_list_search_providers)
    app.router.add_post("/api/admin/search-providers/{name}/toggle", handle_toggle_search_provider)
    app.router.add_get("/api/admin/rag", handle_list_rag)
    app.router.add_post("/api/admin/rag", handle_add_rag)
    app.router.add_put("/api/admin/rag/{id}", handle_update_rag)
    app.router.add_delete("/api/admin/rag/{id}", handle_delete_rag)
    app.router.add_post("/api/admin/rag/{id}/health", handle_rag_health)
    app.router.add_get("/api/admin/config", handle_get_config)
    app.router.add_put("/api/admin/config", handle_update_config)
    app.router.add_get("/api/admin/logs", handle_get_logs)
```

**Step 2: Register routes in server.py**

In `gateway/server.py`, in `create_app()` after the existing routes:
```python
from gateway.admin import register_admin_routes
register_admin_routes(app)
```

**Step 3: Test API manually**

Run: `python -m gateway.server`
Test: `curl -s "http://localhost:8080/api/admin/config?token=devtoken" | python -m json.tool`
Expected: JSON with config, server, and llm fields.

Test: `curl -s "http://localhost:8080/api/admin/tools?token=devtoken" | python -m json.tool`
Expected: JSON array of 5 tools with enabled status.

**Step 4: Commit**

```bash
git add gateway/admin.py gateway/server.py
git commit -m "feat: add admin API routes for dashboard

Session: S-2026-02-18-admin-dashboard"
```

---

### Task 4: Admin HTML Page

**Files:**
- Create: `web/admin.html`

**Step 1: Create the admin page HTML**

The page uses the same art-deco design system (Cinzel/Raleway fonts, gold palette, dark backgrounds). Four tabs for the four features. Auth token passed via query param from a simple login form.

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin Dashboard</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;500;600;700&family=Raleway:wght@300;400;500;600&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/static/admin.css?v=1">
</head>
<body>
    <div id="admin-app">
        <!-- Auth gate -->
        <div id="auth-gate">
            <div class="auth-card">
                <h1>Admin Dashboard</h1>
                <div class="deco-divider"></div>
                <input type="password" id="admin-token" placeholder="Enter token">
                <button id="auth-btn" class="btn-primary">Authenticate</button>
            </div>
        </div>

        <!-- Dashboard (hidden until authed) -->
        <div id="dashboard" class="hidden">
            <header>
                <h1>Voice Agent Admin</h1>
                <span id="server-uptime" class="uptime"></span>
            </header>

            <nav class="tab-bar">
                <button class="tab active" data-tab="conversations">Conversations</button>
                <button class="tab" data-tab="logs">Live Logs</button>
                <button class="tab" data-tab="tools">Tools & RAG</button>
                <button class="tab" data-tab="config">Config</button>
            </nav>

            <!-- Tab: Conversations -->
            <section id="tab-conversations" class="tab-content active">
                <div class="toolbar">
                    <input type="text" id="conv-search" placeholder="Search conversations...">
                    <button id="conv-refresh" class="btn-sm">Refresh</button>
                    <button id="conv-clear" class="btn-sm btn-danger">Clear All</button>
                </div>
                <div id="sessions-list"></div>
                <div id="session-detail" class="hidden"></div>
            </section>

            <!-- Tab: Live Logs -->
            <section id="tab-logs" class="tab-content hidden">
                <div class="toolbar">
                    <div class="level-filters">
                        <button class="level-btn active" data-level="">All</button>
                        <button class="level-btn" data-level="ERROR">Error</button>
                        <button class="level-btn" data-level="WARNING">Warn</button>
                        <button class="level-btn" data-level="INFO">Info</button>
                    </div>
                    <input type="text" id="log-search" placeholder="Filter logs...">
                    <button id="log-pause" class="btn-sm">Pause</button>
                </div>
                <pre id="log-output" class="log-viewer"></pre>
            </section>

            <!-- Tab: Tools & RAG -->
            <section id="tab-tools" class="tab-content hidden">
                <h2>Tool Registry</h2>
                <div id="tools-list"></div>

                <h2>Web Search Providers</h2>
                <div id="search-providers"></div>

                <h2>RAG Endpoints</h2>
                <div id="rag-list"></div>
                <button id="add-rag-btn" class="btn-sm">+ Add RAG Endpoint</button>
                <div id="rag-form" class="hidden">
                    <input type="text" id="rag-name" placeholder="Name (e.g. GitHub RAG)">
                    <input type="text" id="rag-url" placeholder="URL (e.g. http://localhost:8100)">
                    <input type="text" id="rag-desc" placeholder="Description">
                    <input type="text" id="rag-upload" placeholder="Upload/Config page URL">
                    <button id="rag-save" class="btn-sm">Save</button>
                    <button id="rag-cancel" class="btn-sm">Cancel</button>
                </div>
            </section>

            <!-- Tab: Config -->
            <section id="tab-config" class="tab-content hidden">
                <h2>Server</h2>
                <div id="server-info"></div>

                <h2>LLM Defaults</h2>
                <div id="llm-config"></div>

                <h2>Search Quota</h2>
                <div id="search-quota"></div>

                <h2>Actions</h2>
                <div class="actions">
                    <a id="download-log" class="btn-sm" download>Download Log</a>
                </div>
            </section>
        </div>
    </div>
    <script src="/static/admin.js?v=1"></script>
</body>
</html>
```

**Step 2: Commit**

```bash
git add web/admin.html
git commit -m "feat: add admin dashboard HTML skeleton

Session: S-2026-02-18-admin-dashboard"
```

---

### Task 5: Admin CSS

**Files:**
- Create: `web/admin.css`

**Step 1: Create admin styles**

Uses the same CSS variables as `styles.css` (redeclared in `:root` so admin.css is self-contained). Art-deco theme with wider layout suitable for a dashboard (not the narrow mobile container of the main app).

Key styling needed:
- Tab bar with gold active indicator
- Session list table with alternating rows
- Turn cards (user=dim border, agent=gold border)
- Log viewer: monospace, dark background, scrollable, color-coded by level
- Tool cards with toggle switches
- RAG cards with health status dots (green/red)
- Search provider nested cards under master toggle
- Form inputs matching the main app's octagonal style
- Responsive: works on desktop (primary) and tablet

The CSS should be approximately 400-500 lines covering all the above elements. Use the existing color palette: `--gold`, `--bg-void`, `--bg-card`, `--cyan`, `--red-ember`, `--text-primary`, `--text-muted`. Use `--font-display` (Cinzel) for headings and `--font-body` (Raleway) for body text. Use `clip-path` for the art-deco angled corners on cards and buttons.

**Step 2: Commit**

```bash
git add web/admin.css
git commit -m "feat: add admin dashboard CSS (art-deco theme)

Session: S-2026-02-18-admin-dashboard"
```

---

### Task 6: Admin JavaScript

**Files:**
- Create: `web/admin.js`

**Step 1: Create the admin client logic**

This is the largest file — handles all four tabs, API calls, WebSocket log streaming, and UI state.

Key sections:
1. **Auth** — token input, stored in `sessionStorage`, appended to all API calls as `?token=X`
2. **Tab switching** — click handlers on tab buttons, show/hide tab content sections
3. **Conversations tab** — fetch `/api/admin/sessions`, render table, click to expand, render turns with full text and audio stats
4. **Live Logs tab** — WebSocket to `/admin/ws?token=X`, append lines to `<pre>`, level filtering (client-side filter on the streamed lines), search filtering, auto-scroll with pause
5. **Tools tab** — fetch `/api/admin/tools`, render cards with toggle switches, POST to toggle endpoint on click
6. **Search providers** — fetch `/api/admin/search-providers`, render master toggle + nested provider toggles
7. **RAG tab** — fetch `/api/admin/rag`, render cards with health status, toggle, configure/upload link, health check button, add/delete forms
8. **Config tab** — fetch `/api/admin/config`, render server info, LLM defaults (dropdowns), search quota, action buttons

Key implementation details:
- All API calls use `fetch()` with the token appended
- Error handling: show error messages in a toast/banner
- Refresh buttons on each tab
- Auto-refresh conversations list every 30 seconds when tab is active
- Log WebSocket reconnects automatically on disconnect
- Toggle switches use POST and update UI optimistically

The JS should be approximately 500-600 lines.

**Step 2: Commit**

```bash
git add web/admin.js
git commit -m "feat: add admin dashboard JavaScript

Session: S-2026-02-18-admin-dashboard"
```

---

### Task 7: Wire Admin Controls to Server Behavior

**Files:**
- Modify: `gateway/server.py` — read admin config in tool refresh
- Modify: `voice_assistant/tools/__init__.py` — add filtered schema function

**Step 1: Add filtered tool schemas function**

In `voice_assistant/tools/__init__.py`, add:
```python
def get_filtered_schemas(disabled_tools: list[str] = None) -> list[dict]:
    """Return tool schemas excluding disabled tools."""
    disabled = set(disabled_tools or [])
    return [tool.to_openai_schema() for name, tool in TOOL_REGISTRY.items() if name not in disabled]
```

**Step 2: Update `_refresh_orchestrator_tools` in server.py**

Modify the existing function to also check admin-level toggles:

```python
def _refresh_orchestrator_tools():
    """Update runner tools based on current search toggle AND admin config."""
    from gateway.db import get_config
    import json

    # Admin-level disabled tools
    disabled = json.loads(get_config("disabled_tools_json", "[]"))

    # Admin-level web search master toggle
    admin_search = get_config("web_search_enabled", "true") == "true"

    if not admin_search:
        disabled.append("web_search")

    if search_enabled and search_is_configured():
        from voice_assistant.tools import get_filtered_schemas
        runner.update_config(tools=get_filtered_schemas(disabled))
    else:
        runner.update_config(tools=[])
```

**Step 3: Seed the default RAG endpoint**

In `gateway/db.py`'s `init_db()`, after seeding default config, add:
```python
# Seed default RAG endpoint if table is empty
with _connect() as conn:
    count = conn.execute("SELECT COUNT(*) FROM rag_endpoints").fetchone()[0]
    if count == 0:
        from voice_assistant.config import settings
        conn.execute(
            "INSERT INTO rag_endpoints (name, url, description, upload_url, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            ("GitHub Repos RAG", settings.rag_url, "Main knowledge base (LanceDB)",
             settings.rag_url.rstrip("/") + "/docs",
             datetime.now(timezone.utc).isoformat()),
        )
```

**Step 4: Test the integration**

Run: `python -m gateway.server`
1. Open admin page, disable a tool, verify it's no longer in the LLM's tool list
2. Toggle web search off, verify agent can't search
3. Add a RAG endpoint, verify it appears in the list

**Step 5: Commit**

```bash
git add gateway/server.py gateway/db.py voice_assistant/tools/__init__.py
git commit -m "feat: wire admin controls to server behavior

Session: S-2026-02-18-admin-dashboard"
```

---

### Task 8: End-to-End Testing

**Files:**
- Modify: `scripts/test_db.py` — extend with API tests

**Step 1: Manual end-to-end test checklist**

1. Start server: `python -m gateway.server`
2. Verify startup log shows admin URL
3. Open `http://localhost:8080/admin?token=devtoken`
4. Verify auth gate appears, enter token, see dashboard
5. Connect a voice client, have a conversation
6. Switch to admin Conversations tab — verify session appears with full text
7. Switch to Live Logs tab — verify log lines streaming
8. Switch to Tools tab:
   - Verify all 5 tools listed
   - Toggle web_search off, verify in voice client search doesn't work
   - Toggle it back on
9. In Search Providers section:
   - Toggle master off, verify nested providers dim
   - Toggle individual providers
10. In RAG section:
    - Verify default endpoint listed
    - Click health check, verify green/red status
    - Click Configure link, verify opens RAG page
    - Add a new RAG endpoint
    - Delete it
11. Switch to Config tab:
    - Verify uptime, port, log size displayed
    - Verify API key status (configured/not)
    - Click Download Log

**Step 2: Commit final polish**

```bash
git add -A
git commit -m "feat: admin dashboard complete — conversations, logs, tools, RAG, config

Session: S-2026-02-18-admin-dashboard"
```

---

## Summary of All Files

**New files (5):**
| File | Purpose | ~Lines |
|------|---------|--------|
| `gateway/db.py` | SQLite CRUD for sessions, turns, RAG, config | ~200 |
| `gateway/admin.py` | Admin HTTP/WS routes, 15+ endpoints | ~300 |
| `web/admin.html` | Admin page HTML, 4-tab layout | ~100 |
| `web/admin.css` | Art-deco themed admin styles | ~450 |
| `web/admin.js` | Admin client logic, all tabs | ~550 |

**Modified files (3):**
| File | Changes |
|------|---------|
| `gateway/server.py` | Import admin routes, init DB, record conversations, admin URL log |
| `voice_assistant/tools/__init__.py` | Add `get_filtered_schemas()` function |
| `voice_assistant/config.py` | No changes needed (RAG URL read by db.py seed) |

**Total:** ~1,600 lines of new code across 8 tasks.

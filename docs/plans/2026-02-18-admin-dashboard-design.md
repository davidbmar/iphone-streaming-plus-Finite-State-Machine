# Admin Dashboard Design

**Date:** 2026-02-18
**Status:** Approved

## Goal

Add an administration page at `/admin` that provides conversation history viewing, live debug logs, RAG/tool management, and server configuration controls. The admin page is both a **viewer** and a **live control plane** that affects server behavior.

## Architecture Decisions

- **Recording:** Hybrid — system auto-records all conversations (no LLM involvement). A read-only LLM tool for cross-session memory can be added later.
- **Storage:** SQLite (`logs/admin.db`) — survives restarts, zero external dependencies.
- **Auth:** Uses existing `AUTH_TOKEN` for now. Google OAuth planned for a future session.
- **UI:** Vanilla JS + same art-deco CSS theme. No new frameworks.
- **Control plane:** Admin toggles affect the running server globally. New sessions inherit admin defaults.

## Features

### Tab 1: Conversations

Full transcript viewer for all voice conversations.

**Session list table:**
- Timestamp, user (derived from token), duration, turn count, model used
- Search across all conversations
- Click row to expand

**Expanded session detail:**
- Each user turn: full transcription, audio duration, RMS, peak, no_speech_prob, avg_logprob
- Each agent turn: **full reply text** (no truncation), model, workflow triggered, tool calls
- Timestamps on every turn

**Recording mechanism:**
- Automatic in the WS handler — every final transcription and agent reply written to SQLite
- Happens at the system level in `gateway/server.py`, no LLM awareness

### Tab 2: Live Logs

Real-time log viewer streaming `logs/server.log`.

- WebSocket stream via `/admin/ws` tails new log lines
- Level filter buttons: ERROR / WARNING / INFO / DEBUG
- Text search/filter input
- Auto-scroll with pause button
- Historical view: load last N lines on page load

### Tab 3: Tools & RAG

#### Tool Registry

Card for each registered tool showing:
- Name, description, status (live / mock / disabled / error)
- On/off toggle — disabling removes the tool from the LLM's available tool set

#### Web Search (nested controls)

```
Web Search [ON/OFF master toggle]
  +-- Serper (Google)  [ON/OFF]  API key status
  +-- Tavily           [ON/OFF]  API key status
  +-- Brave            [ON/OFF]  API key status
  +-- DuckDuckGo       [ON/OFF]  No key needed
```

Master off = `web_search` tool removed from LLM entirely.
Master on = uses enabled sub-providers in priority order.
Each provider shows whether its API key is configured (not the key itself).

#### RAG Registry

Managed list of RAG service endpoints:

Each entry shows:
- Name (e.g., "GitHub Repos RAG", "Voice-Optimal RAG")
- URL + port (e.g., `http://localhost:8100`)
- Description
- Health status: green (reachable) / red (unreachable) — checked via HTTP ping
- On/off toggle — when off, that RAG's tool is removed from the LLM
- **"Configure / Upload" link** — opens the RAG service's own admin/upload page in a new tab (e.g., `http://localhost:8100/docs`). Clickable even when RAG is down.
- **Health check button** — manually ping the endpoint

Adding a RAG: form with name, URL, description, upload page URL.
Removing a RAG: delete button with confirmation.

RAG registry is persisted in SQLite so endpoints survive restarts.

### Tab 4: Config & Stats

**Server info (read-only):**
- Uptime, port, HTTPS mode, log file size
- Active WebSocket session count

**LLM defaults (editable):**
- Default provider dropdown (Claude / OpenAI / Ollama)
- Default model dropdown (populated from model catalog)
- New sessions inherit these defaults

**Search quota:**
- Remaining quota for each search provider
- Links to provider dashboards

**Quick actions:**
- Clear conversation history
- Download server log

## Data Model (SQLite)

### `sessions` table
```sql
CREATE TABLE sessions (
    id          TEXT PRIMARY KEY,  -- UUID
    started_at  TEXT NOT NULL,     -- ISO 8601
    ended_at    TEXT,
    client_ip   TEXT,
    timezone    TEXT,
    llm_provider TEXT,
    llm_model   TEXT,
    voice       TEXT,
    turn_count  INTEGER DEFAULT 0
);
```

### `turns` table
```sql
CREATE TABLE turns (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL REFERENCES sessions(id),
    timestamp       TEXT NOT NULL,
    role            TEXT NOT NULL,  -- 'user' or 'agent'
    text            TEXT NOT NULL,  -- full text, no truncation
    audio_duration_s REAL,
    rms             REAL,
    peak            INTEGER,
    no_speech_prob  REAL,
    avg_logprob     REAL,
    model_used      TEXT,
    workflow_used   TEXT,
    tool_calls_json TEXT           -- JSON array of {name, args, result_summary}
);
```

### `rag_endpoints` table
```sql
CREATE TABLE rag_endpoints (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    url         TEXT NOT NULL,
    description TEXT,
    upload_url  TEXT,             -- URL to RAG's own admin/upload page
    active      INTEGER DEFAULT 1,
    created_at  TEXT NOT NULL,
    last_health TEXT              -- ISO 8601 of last successful health check
);
```

### `admin_config` table
```sql
CREATE TABLE admin_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
-- Keys: default_llm_provider, default_llm_model, web_search_enabled,
--        search_providers_json (enabled provider list),
--        disabled_tools_json (list of disabled tool names)
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin` | Serve admin HTML page |
| GET | `/admin/ws` | WebSocket for live log streaming |
| GET | `/api/admin/sessions` | List sessions (paginated, newest first) |
| GET | `/api/admin/sessions/:id` | Get session with all turns |
| GET | `/api/admin/tools` | List tools with status and toggles |
| POST | `/api/admin/tools/:name/toggle` | Enable/disable a tool |
| GET | `/api/admin/search-providers` | List search providers with status |
| POST | `/api/admin/search-providers/:name/toggle` | Enable/disable a provider |
| GET | `/api/admin/rag` | List RAG endpoints |
| POST | `/api/admin/rag` | Add a RAG endpoint |
| PUT | `/api/admin/rag/:id` | Update RAG endpoint |
| DELETE | `/api/admin/rag/:id` | Remove RAG endpoint |
| POST | `/api/admin/rag/:id/health` | Check RAG health |
| GET | `/api/admin/config` | Get server config + stats |
| PUT | `/api/admin/config` | Update default LLM, search master toggle |
| GET | `/api/admin/logs` | Get recent log lines (query: level, search, limit) |

## New Files

```
gateway/admin.py       -- Admin HTTP routes + WebSocket log streamer
gateway/db.py          -- SQLite wrapper (sessions, turns, RAG registry, config)
web/admin.html         -- Admin page HTML
web/admin.css          -- Admin-specific styles (imports shared art-deco vars)
web/admin.js           -- Admin page client logic
```

## Modified Files

```
gateway/server.py      -- Register admin routes, add conversation recording
                          to WS handler, print admin URL on startup
voice_assistant/config.py -- Add RAG registry support (multi-URL)
```

## Startup Output

```
INFO  Serving on http://0.0.0.0:8080
INFO  Admin dashboard: http://localhost:8080/admin
```

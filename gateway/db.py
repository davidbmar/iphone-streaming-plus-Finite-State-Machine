"""SQLite database module for admin dashboard.

Stores conversation sessions, turns, RAG endpoint registry, and admin config.
Uses WAL journal mode and one connection per call for thread safety.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timezone as _tz
from pathlib import Path

DB_PATH: Path = Path(__file__).resolve().parent.parent / "logs" / "admin.db"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _utcnow() -> str:
    """Return current UTC time as ISO 8601 string."""
    return datetime.now(_tz.utc).isoformat()


def _connect() -> sqlite3.Connection:
    """Open a new connection with WAL mode and foreign keys enabled."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


# ---------------------------------------------------------------------------
# Schema / Init
# ---------------------------------------------------------------------------

_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id              TEXT PRIMARY KEY,
    started_at      TEXT,
    ended_at        TEXT,
    client_ip       TEXT,
    timezone        TEXT,
    llm_provider    TEXT,
    llm_model       TEXT,
    voice           TEXT,
    turn_count      INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS turns (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    timestamp       TEXT,
    role            TEXT,
    text            TEXT,
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
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT,
    url             TEXT,
    description     TEXT,
    upload_url      TEXT,
    active          INTEGER DEFAULT 1,
    created_at      TEXT,
    last_health     TEXT
);

CREATE TABLE IF NOT EXISTS admin_config (
    key             TEXT PRIMARY KEY,
    value           TEXT
);
"""

_DEFAULT_CONFIG = {
    "web_search_enabled": "true",
    "search_providers_json": '["serper","tavily","brave","duckduckgo"]',
    "disabled_tools_json": "[]",
    "default_llm_provider": "",
    "default_llm_model": "",
}


def init_db() -> None:
    """Create tables, seed default config values, seed default RAG endpoint."""
    conn = _connect()
    try:
        conn.executescript(_SCHEMA)

        # Seed default config (INSERT OR IGNORE keeps existing values)
        for key, value in _DEFAULT_CONFIG.items():
            conn.execute(
                "INSERT OR IGNORE INTO admin_config (key, value) VALUES (?, ?)",
                (key, value),
            )

        # Seed default RAG endpoint if table is empty
        row = conn.execute("SELECT COUNT(*) FROM rag_endpoints").fetchone()
        if row[0] == 0:
            try:
                from voice_assistant.config import settings
                rag_url = settings.rag_url
            except Exception:
                rag_url = "http://localhost:8100"
            conn.execute(
                "INSERT INTO rag_endpoints (name, url, description, upload_url, created_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (
                    "GitHub Repos RAG",
                    rag_url,
                    "Main knowledge base (LanceDB)",
                    rag_url.rstrip("/") + "/docs",
                    _utcnow(),
                ),
            )

        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------

def create_session(
    client_ip: str,
    client_timezone: str,
    llm_provider: str,
    llm_model: str,
    voice: str,
) -> str:
    """Create a new session and return its UUID."""
    session_id = str(uuid.uuid4())
    conn = _connect()
    try:
        conn.execute(
            "INSERT INTO sessions (id, started_at, client_ip, timezone, llm_provider, llm_model, voice) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (session_id, _utcnow(), client_ip, client_timezone, llm_provider, llm_model, voice),
        )
        conn.commit()
    finally:
        conn.close()
    return session_id


def end_session(session_id: str) -> None:
    """Mark session as ended and update turn_count from actual rows."""
    conn = _connect()
    try:
        count = conn.execute(
            "SELECT COUNT(*) FROM turns WHERE session_id = ?", (session_id,)
        ).fetchone()[0]
        conn.execute(
            "UPDATE sessions SET ended_at = ?, turn_count = ? WHERE id = ?",
            (_utcnow(), count, session_id),
        )
        conn.commit()
    finally:
        conn.close()


def list_sessions(
    limit: int = 50, offset: int = 0, search: str | None = None
) -> list[dict]:
    """Return sessions newest-first. If *search* is given, only include sessions
    that have at least one turn whose text matches the search term."""
    conn = _connect()
    try:
        if search:
            rows = conn.execute(
                "SELECT DISTINCT s.* FROM sessions s "
                "JOIN turns t ON t.session_id = s.id "
                "WHERE t.text LIKE ? "
                "ORDER BY s.started_at DESC LIMIT ? OFFSET ?",
                (f"%{search}%", limit, offset),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM sessions ORDER BY started_at DESC LIMIT ? OFFSET ?",
                (limit, offset),
            ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_session(session_id: str) -> dict | None:
    """Return a session dict with an embedded ``turns`` list, or None."""
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT * FROM sessions WHERE id = ?", (session_id,)
        ).fetchone()
        if row is None:
            return None
        session = dict(row)
        turns = conn.execute(
            "SELECT * FROM turns WHERE session_id = ? ORDER BY timestamp ASC",
            (session_id,),
        ).fetchall()
        session["turns"] = [dict(t) for t in turns]
        return session
    finally:
        conn.close()


def delete_all_sessions() -> None:
    """Delete every session and its turns (CASCADE)."""
    conn = _connect()
    try:
        conn.execute("DELETE FROM sessions")
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Turns
# ---------------------------------------------------------------------------

def add_turn(session_id: str, role: str, text: str, **kwargs) -> int:
    """Insert a turn and return its row id.

    Optional kwargs: audio_duration_s, rms, peak, no_speech_prob,
    avg_logprob, model_used, workflow_used, tool_calls (list/dict will be
    JSON-serialised).
    """
    tool_calls = kwargs.get("tool_calls")
    if tool_calls is not None and not isinstance(tool_calls, str):
        tool_calls = json.dumps(tool_calls)

    conn = _connect()
    try:
        cur = conn.execute(
            "INSERT INTO turns "
            "(session_id, timestamp, role, text, audio_duration_s, rms, peak, "
            " no_speech_prob, avg_logprob, model_used, workflow_used, tool_calls_json) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                session_id,
                _utcnow(),
                role,
                text,
                kwargs.get("audio_duration_s"),
                kwargs.get("rms"),
                kwargs.get("peak"),
                kwargs.get("no_speech_prob"),
                kwargs.get("avg_logprob"),
                kwargs.get("model_used"),
                kwargs.get("workflow_used"),
                tool_calls,
            ),
        )
        conn.commit()
        return cur.lastrowid  # type: ignore[return-value]
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# RAG Endpoints
# ---------------------------------------------------------------------------

def list_rag_endpoints() -> list[dict]:
    conn = _connect()
    try:
        rows = conn.execute("SELECT * FROM rag_endpoints ORDER BY id").fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def add_rag_endpoint(
    name: str, url: str, description: str, upload_url: str
) -> int:
    conn = _connect()
    try:
        cur = conn.execute(
            "INSERT INTO rag_endpoints (name, url, description, upload_url, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (name, url, description, upload_url, _utcnow()),
        )
        conn.commit()
        return cur.lastrowid  # type: ignore[return-value]
    finally:
        conn.close()


def update_rag_endpoint(rag_id: int, **kwargs) -> None:
    """Update fields on a RAG endpoint.  Accepted kwargs: name, url,
    description, upload_url, active, last_health."""
    allowed = {"name", "url", "description", "upload_url", "active", "last_health"}
    updates = {k: v for k, v in kwargs.items() if k in allowed}
    if not updates:
        return
    set_clause = ", ".join(f"{col} = ?" for col in updates)
    values = list(updates.values()) + [rag_id]
    conn = _connect()
    try:
        conn.execute(
            f"UPDATE rag_endpoints SET {set_clause} WHERE id = ?", values
        )
        conn.commit()
    finally:
        conn.close()


def delete_rag_endpoint(rag_id: int) -> None:
    conn = _connect()
    try:
        conn.execute("DELETE FROM rag_endpoints WHERE id = ?", (rag_id,))
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Admin Config
# ---------------------------------------------------------------------------

def get_config(key: str, default: str | None = None) -> str | None:
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT value FROM admin_config WHERE key = ?", (key,)
        ).fetchone()
        return row["value"] if row else default
    finally:
        conn.close()


def set_config(key: str, value: str) -> None:
    conn = _connect()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO admin_config (key, value) VALUES (?, ?)",
            (key, value),
        )
        conn.commit()
    finally:
        conn.close()


def get_all_config() -> dict[str, str]:
    conn = _connect()
    try:
        rows = conn.execute("SELECT key, value FROM admin_config").fetchall()
        return {r["key"]: r["value"] for r in rows}
    finally:
        conn.close()

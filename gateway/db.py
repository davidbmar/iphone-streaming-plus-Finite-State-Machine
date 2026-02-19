"""SQLite database module for admin dashboard.

Stores conversation sessions, turns, RAG endpoint registry, and admin config.
Uses WAL journal mode and one connection per call for thread safety.
"""

from __future__ import annotations

import json
import secrets
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone as _tz
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

CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    google_id       TEXT UNIQUE NOT NULL,
    email           TEXT,
    name            TEXT,
    avatar_url      TEXT,
    role            TEXT DEFAULT 'user',
    created_at      TEXT,
    last_login      TEXT
);

CREATE TABLE IF NOT EXISTS user_preferences (
    user_id         INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    voice           TEXT,
    llm_provider    TEXT,
    llm_model       TEXT,
    custom_instructions TEXT,
    search_enabled  INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS auth_sessions (
    token           TEXT PRIMARY KEY,
    user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
    created_at      TEXT,
    expires_at      TEXT,
    last_used       TEXT
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

        # Migration: add user_id column to sessions if missing
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(sessions)").fetchall()}
        if "user_id" not in cols:
            conn.execute("ALTER TABLE sessions ADD COLUMN user_id INTEGER")

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
    user_id: int | None = None,
) -> str:
    """Create a new session and return its UUID."""
    session_id = str(uuid.uuid4())
    conn = _connect()
    try:
        conn.execute(
            "INSERT INTO sessions (id, started_at, client_ip, timezone, llm_provider, llm_model, voice, user_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (session_id, _utcnow(), client_ip, client_timezone, llm_provider, llm_model, voice, user_id),
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
    limit: int = 50, offset: int = 0, search: str | None = None,
    user_id: int | None = None,
) -> list[dict]:
    """Return sessions newest-first, optionally filtered by user_id.

    If *search* is given, only include sessions that have at least one
    turn whose text matches the search term.
    """
    conn = _connect()
    try:
        if search:
            where = "WHERE t.text LIKE ?"
            params: list = [f"%{search}%"]
            if user_id is not None:
                where += " AND s.user_id = ?"
                params.append(user_id)
            params += [limit, offset]
            rows = conn.execute(
                "SELECT DISTINCT s.* FROM sessions s "
                "JOIN turns t ON t.session_id = s.id "
                f"{where} "
                "ORDER BY s.started_at DESC LIMIT ? OFFSET ?",
                params,
            ).fetchall()
        else:
            if user_id is not None:
                rows = conn.execute(
                    "SELECT * FROM sessions WHERE user_id = ? "
                    "ORDER BY started_at DESC LIMIT ? OFFSET ?",
                    (user_id, limit, offset),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM sessions ORDER BY started_at DESC LIMIT ? OFFSET ?",
                    (limit, offset),
                ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_session(session_id: str, user_id: int | None = None) -> dict | None:
    """Return a session dict with an embedded ``turns`` list, or None.

    If *user_id* is given, only return the session if it belongs to that user.
    """
    conn = _connect()
    try:
        if user_id is not None:
            row = conn.execute(
                "SELECT * FROM sessions WHERE id = ? AND user_id = ?",
                (session_id, user_id),
            ).fetchone()
        else:
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


def delete_all_sessions(user_id: int | None = None) -> None:
    """Delete sessions and their turns (CASCADE).

    If *user_id* is given, only delete that user's sessions.
    """
    conn = _connect()
    try:
        if user_id is not None:
            conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        else:
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


# ---------------------------------------------------------------------------
# Users
# ---------------------------------------------------------------------------

def upsert_user(google_id: str, email: str, name: str, avatar_url: str) -> int:
    """Create or update a user by Google ID. Returns the user's row id."""
    now = _utcnow()
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT id FROM users WHERE google_id = ?", (google_id,)
        ).fetchone()
        if row:
            conn.execute(
                "UPDATE users SET email = ?, name = ?, avatar_url = ?, last_login = ? "
                "WHERE id = ?",
                (email, name, avatar_url, now, row["id"]),
            )
            conn.commit()
            return row["id"]
        else:
            cur = conn.execute(
                "INSERT INTO users (google_id, email, name, avatar_url, created_at, last_login) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (google_id, email, name, avatar_url, now, now),
            )
            conn.commit()
            return cur.lastrowid  # type: ignore[return-value]
    finally:
        conn.close()


def get_user(user_id: int) -> dict | None:
    """Return a user dict or None."""
    conn = _connect()
    try:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# User Preferences
# ---------------------------------------------------------------------------

def get_user_preferences(user_id: int) -> dict | None:
    """Return user preferences dict or None."""
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT * FROM user_preferences WHERE user_id = ?", (user_id,)
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def update_user_preferences(user_id: int, **kwargs) -> None:
    """Insert or update user preferences. Accepted kwargs: voice, llm_provider,
    llm_model, custom_instructions, search_enabled."""
    allowed = {"voice", "llm_provider", "llm_model", "custom_instructions", "search_enabled"}
    fields = {k: v for k, v in kwargs.items() if k in allowed}
    if not fields:
        return
    conn = _connect()
    try:
        existing = conn.execute(
            "SELECT user_id FROM user_preferences WHERE user_id = ?", (user_id,)
        ).fetchone()
        if existing:
            set_clause = ", ".join(f"{col} = ?" for col in fields)
            values = list(fields.values()) + [user_id]
            conn.execute(
                f"UPDATE user_preferences SET {set_clause} WHERE user_id = ?", values
            )
        else:
            fields["user_id"] = user_id
            cols = ", ".join(fields.keys())
            placeholders = ", ".join("?" for _ in fields)
            conn.execute(
                f"INSERT INTO user_preferences ({cols}) VALUES ({placeholders})",
                list(fields.values()),
            )
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Auth Sessions
# ---------------------------------------------------------------------------

def create_auth_session(user_id: int, ttl_hours: int = 168) -> str:
    """Create a session token valid for ttl_hours (default 7 days). Returns token."""
    token = secrets.token_urlsafe(32)
    now = datetime.now(_tz.utc)
    expires = now + timedelta(hours=ttl_hours)
    conn = _connect()
    try:
        conn.execute(
            "INSERT INTO auth_sessions (token, user_id, created_at, expires_at, last_used) "
            "VALUES (?, ?, ?, ?, ?)",
            (token, user_id, now.isoformat(), expires.isoformat(), now.isoformat()),
        )
        conn.commit()
    finally:
        conn.close()
    return token


def validate_auth_session(token: str) -> int | None:
    """Validate a session token. Returns user_id if valid, None if expired/missing.
    Updates last_used on success."""
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT user_id, expires_at FROM auth_sessions WHERE token = ?", (token,)
        ).fetchone()
        if not row:
            return None
        expires = datetime.fromisoformat(row["expires_at"])
        if datetime.now(_tz.utc) > expires:
            conn.execute("DELETE FROM auth_sessions WHERE token = ?", (token,))
            conn.commit()
            return None
        conn.execute(
            "UPDATE auth_sessions SET last_used = ? WHERE token = ?",
            (_utcnow(), token),
        )
        conn.commit()
        return row["user_id"]
    finally:
        conn.close()


def delete_auth_session(token: str) -> None:
    """Delete a session token (logout)."""
    conn = _connect()
    try:
        conn.execute("DELETE FROM auth_sessions WHERE token = ?", (token,))
        conn.commit()
    finally:
        conn.close()


def cleanup_expired_sessions() -> int:
    """Delete all expired auth sessions. Returns count deleted."""
    conn = _connect()
    try:
        now = _utcnow()
        cur = conn.execute(
            "DELETE FROM auth_sessions WHERE expires_at < ?", (now,)
        )
        conn.commit()
        return cur.rowcount
    finally:
        conn.close()

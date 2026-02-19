#!/usr/bin/env python3
"""Smoke test for gateway.db — runs against a temporary SQLite database."""

import sys
import tempfile
from pathlib import Path

# ---------------------------------------------------------------------------
# Point DB_PATH at a temp file BEFORE importing the module
# ---------------------------------------------------------------------------
_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_path = Path(_tmp.name)
_tmp.close()

# Ensure project root is on sys.path so imports work from the scripts/ dir
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import gateway.db as db  # noqa: E402

db.DB_PATH = _tmp_path

# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_init_db():
    db.init_db()
    # Config seeds should exist
    cfg = db.get_all_config()
    assert "web_search_enabled" in cfg, "missing default config seed"
    assert cfg["web_search_enabled"] == "true"
    print("[PASS] init_db — tables created and config seeded")

    # Default RAG endpoint should exist
    endpoints = db.list_rag_endpoints()
    assert len(endpoints) == 1, "expected 1 seeded RAG endpoint"
    assert endpoints[0]["name"] == "GitHub Repos RAG"
    print("[PASS] init_db — default RAG endpoint seeded")


def test_sessions_and_turns():
    sid = db.create_session("127.0.0.1", "America/Chicago", "ollama", "qwen3:8b", "amy")
    assert sid, "create_session should return a uuid"
    print(f"[PASS] create_session — id={sid[:8]}...")

    # Add turns
    t1 = db.add_turn(sid, "user", "Hello, what is the weather?")
    t2 = db.add_turn(
        sid, "assistant", "It looks sunny today!",
        audio_duration_s=2.5, rms=0.03, model_used="qwen3:8b",
        workflow_used="fast_path", tool_calls=["web_search"],
    )
    assert isinstance(t1, int) and isinstance(t2, int)
    print(f"[PASS] add_turn — turn ids {t1}, {t2}")

    # End session
    db.end_session(sid)
    session = db.get_session(sid)
    assert session is not None
    assert session["ended_at"] is not None
    assert session["turn_count"] == 2
    assert len(session["turns"]) == 2
    print(f"[PASS] end_session — turn_count={session['turn_count']}")

    # List sessions
    sessions = db.list_sessions()
    assert len(sessions) >= 1
    print(f"[PASS] list_sessions — returned {len(sessions)} session(s)")

    # Search sessions by turn text
    found = db.list_sessions(search="weather")
    assert len(found) == 1
    not_found = db.list_sessions(search="xyznonexistent")
    assert len(not_found) == 0
    print("[PASS] list_sessions(search=...) — filtering works")

    # Get session
    s = db.get_session(sid)
    assert s is not None and s["id"] == sid
    assert s["turns"][1]["tool_calls_json"] == '["web_search"]'
    print("[PASS] get_session — turns and tool_calls intact")


def test_rag_endpoints():
    new_id = db.add_rag_endpoint("Test EP", "http://test:9000", "A test endpoint", "http://test:9000/docs")
    assert isinstance(new_id, int)
    eps = db.list_rag_endpoints()
    assert any(e["name"] == "Test EP" for e in eps)
    print(f"[PASS] add_rag_endpoint — id={new_id}")

    db.update_rag_endpoint(new_id, active=0)
    eps = db.list_rag_endpoints()
    updated = [e for e in eps if e["id"] == new_id][0]
    assert updated["active"] == 0
    print("[PASS] update_rag_endpoint — active toggled")

    db.delete_rag_endpoint(new_id)
    eps = db.list_rag_endpoints()
    assert not any(e["id"] == new_id for e in eps)
    print("[PASS] delete_rag_endpoint — removed")


def test_config():
    db.set_config("test_key", "test_value")
    assert db.get_config("test_key") == "test_value"
    assert db.get_config("nonexistent", "fallback") == "fallback"
    all_cfg = db.get_all_config()
    assert "test_key" in all_cfg
    print("[PASS] get_config / set_config / get_all_config")


def test_delete_all_sessions():
    # Create a session to ensure there's something to delete
    sid = db.create_session("10.0.0.1", "UTC", "claude", "haiku", "default")
    db.add_turn(sid, "user", "test turn for deletion")
    db.delete_all_sessions()
    sessions = db.list_sessions()
    assert len(sessions) == 0
    print("[PASS] delete_all_sessions — all sessions removed")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    try:
        test_init_db()
        test_sessions_and_turns()
        test_rag_endpoints()
        test_config()
        test_delete_all_sessions()
        print("\n=== ALL TESTS PASSED ===")
    finally:
        # Cleanup temp DB
        if _tmp_path.exists():
            _tmp_path.unlink()
            print(f"Cleaned up {_tmp_path}")

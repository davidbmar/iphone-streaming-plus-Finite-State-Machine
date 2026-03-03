"""In-memory registry of active voice sessions with pub/sub event bus.

Companions subscribe to a session's event bus and receive all messages
the primary client receives (transcription, agent_reply, workflow_*, etc.).
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any

log = logging.getLogger("session_registry")

# Module-level registry
_sessions: dict[str, "ActiveSession"] = {}


@dataclass
class ActiveSession:
    """A registered active voice session."""
    session_id: str
    user_id: str | None = None
    user_info: dict | None = None
    _subscribers: set[asyncio.Queue] = field(default_factory=set, repr=False)

    def subscribe(self) -> asyncio.Queue:
        """Add a new subscriber, returns queue for receiving events."""
        q: asyncio.Queue = asyncio.Queue(maxsize=100)
        self._subscribers.add(q)
        log.info("Session %s: subscriber added (total=%d)", self.session_id, len(self._subscribers))
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        """Remove a subscriber."""
        self._subscribers.discard(q)
        log.info("Session %s: subscriber removed (total=%d)", self.session_id, len(self._subscribers))

    def broadcast(self, event: dict) -> None:
        """Send event to all subscribers (non-blocking, drops on full queue)."""
        for q in self._subscribers:
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                log.debug("Session %s: dropped event for slow subscriber", self.session_id)


def register(session_id: str, user_id: str | None = None,
             user_info: dict | None = None) -> ActiveSession:
    """Register a new active session."""
    s = ActiveSession(session_id=session_id, user_id=user_id, user_info=user_info)
    _sessions[session_id] = s
    log.info("Registered session %s (total active=%d)", session_id, len(_sessions))
    return s


def unregister(session_id: str) -> None:
    """Remove a session from the registry."""
    if session_id in _sessions:
        del _sessions[session_id]
        log.info("Unregistered session %s (total active=%d)", session_id, len(_sessions))


def get(session_id: str) -> ActiveSession | None:
    """Get a session by ID."""
    return _sessions.get(session_id)


def list_active() -> list[dict]:
    """List all active sessions (for companion session picker)."""
    return [
        {
            "session_id": s.session_id,
            "user_id": s.user_id,
            "user_name": (s.user_info or {}).get("name", ""),
            "user_email": (s.user_info or {}).get("email", ""),
        }
        for s in _sessions.values()
    ]

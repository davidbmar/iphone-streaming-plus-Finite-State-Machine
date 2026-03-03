"""Conversation state — sliding window of turns + system prompt."""

from __future__ import annotations

import os

DEFAULT_SYSTEM_PROMPT = (
    "You are a helpful voice assistant. Keep responses concise — "
    "one to three sentences. Speak naturally as in a conversation."
)

SYSTEM_PROMPT = os.getenv("SYSTEM_PROMPT", "") or DEFAULT_SYSTEM_PROMPT
MAX_TURNS = 10  # Keep last N turns (user + assistant pairs)


class ConversationHistory:
    """Manages conversation turns for the LLM."""

    def __init__(self, system: str = ""):
        self.system = system or SYSTEM_PROMPT
        self._turns: list[dict] = []

    def add_turn(self, role: str, text: str):
        """Add a turn to the history. Trims to MAX_TURNS."""
        self._turns.append({"role": role, "content": text})
        if len(self._turns) > MAX_TURNS:
            self._turns = self._turns[-MAX_TURNS:]

    def get_messages(self) -> list[dict]:
        """Return the message list for the LLM API."""
        return list(self._turns)

    def clear(self):
        """Reset conversation history."""
        self._turns.clear()

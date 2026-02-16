"""Notes search tool — MOCK (returns hardcoded fake notes).

Demonstrates multi-tool routing. Replace with real notes
backend (Apple Notes, Obsidian, RAG over local files, etc.).

See backlog: F-004-real-notes-search.md
"""

from typing import Any

from .base import BaseTool


class NotesTool(BaseTool):
    @property
    def name(self) -> str:
        return "search_notes"

    @property
    def description(self) -> str:
        return "Search your personal notes for saved information, lists, and reminders."

    @property
    def parameters_schema(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search term to find in notes.",
                },
            },
            "required": ["query"],
        }

    async def execute(self, **kwargs: Any) -> str:
        query = kwargs.get("query", "")
        # Fake notes database
        notes = {
            "shopping": "Shopping list (Feb 15):\n- Oat milk\n- Avocados\n- Sourdough bread\n- Dark chocolate\n- Olive oil",
            "recipe": "Pasta recipe:\n1. Boil water, cook spaghetti 8 min\n2. Sauté garlic in olive oil\n3. Add crushed tomatoes, basil, salt\n4. Toss pasta, top with parmesan",
            "ideas": "Project ideas:\n- Build a voice assistant with tool calling\n- Automate home lighting with HomeKit\n- Learn Rust by building a CLI tool",
        }

        # Simple keyword matching
        matches = []
        for key, content in notes.items():
            if query.lower() in key or query.lower() in content.lower():
                matches.append(content)

        if matches:
            return f"[MOCK DATA] Notes matching '{query}':\n\n" + "\n\n".join(matches)
        return f"No notes found matching '{query}'."

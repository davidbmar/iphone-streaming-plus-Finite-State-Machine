"""Tool registry — decorator-based, explicit imports.

No magic scanning or auto-discovery. Each tool is imported and
registered explicitly so the registry is debuggable and predictable.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .base import BaseTool

# Global registry: tool_name -> BaseTool instance
TOOL_REGISTRY: dict[str, BaseTool] = {}


def register_tool(cls):
    """Class decorator that instantiates a BaseTool subclass and registers it."""
    instance = cls()
    TOOL_REGISTRY[instance.name] = instance
    return cls


def get_all_schemas() -> list[dict]:
    """Return OpenAI-format tool definitions for all registered tools."""
    return [tool.to_openai_schema() for tool in TOOL_REGISTRY.values()]


def get_filtered_schemas(disabled_tools: list[str] | None = None) -> list[dict]:
    """Return tool schemas excluding disabled tools."""
    disabled = set(disabled_tools or [])
    return [tool.to_openai_schema() for name, tool in TOOL_REGISTRY.items() if name not in disabled]


def get_tool(name: str):
    """Look up a registered tool by name. Returns None if not found."""
    return TOOL_REGISTRY.get(name)


# ── Explicit registration ─────────────────────────────────────
# Import each tool module so the @register_tool decorator fires.

from .web_search import WebSearchTool
from .calendar import CalendarTool
from .notes import NotesTool
from .datetime_tool import DateTimeTool
from .rag import RAGTool

register_tool(WebSearchTool)
register_tool(CalendarTool)
register_tool(NotesTool)
register_tool(DateTimeTool)
register_tool(RAGTool)

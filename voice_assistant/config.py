"""Settings for the voice assistant orchestrator.

Uses pydantic-settings when available for .env file loading and type
validation. Falls back to a plain dataclass with os.getenv() when
pydantic-settings is not installed (e.g., system Python).
"""

import os
from pathlib import Path

try:
    from pydantic_settings import BaseSettings

    class Settings(BaseSettings):
        # Ollama connection
        ollama_url: str = "http://localhost:11434"
        ollama_model: str = "qwen3:8b"
        ollama_fallback_model: str = "qwen2.5:14b"

        # Search API keys
        serper_api_key: str = ""
        brave_api_key: str = ""
        tavily_api_key: str = ""

        # RAG knowledge base
        rag_url: str = "http://localhost:8100"

        # Orchestrator limits
        max_tool_calls_per_turn: int = 5
        max_history_messages: int = 20
        enable_thinking: bool = False

        # Timeouts (seconds)
        ollama_timeout: float = 60.0
        search_timeout: float = 10.0

        model_config = {
            "env_file": str(Path(__file__).resolve().parent.parent / ".env"),
            "extra": "ignore",
        }

except ImportError:
    # Fallback: read from env vars with same defaults (no .env file loading)
    class Settings:  # type: ignore[no-redef]
        def __init__(self):
            self.ollama_url = os.getenv("OLLAMA_URL", "http://localhost:11434")
            self.ollama_model = os.getenv("OLLAMA_MODEL", "qwen3:8b")
            self.ollama_fallback_model = os.getenv("OLLAMA_FALLBACK_MODEL", "qwen2.5:14b")
            self.serper_api_key = os.getenv("SERPER_API_KEY", "")
            self.brave_api_key = os.getenv("BRAVE_API_KEY", "")
            self.tavily_api_key = os.getenv("TAVILY_API_KEY", "")
            self.rag_url = os.getenv("RAG_URL", "http://localhost:8100")
            self.max_tool_calls_per_turn = int(os.getenv("MAX_TOOL_CALLS_PER_TURN", "5"))
            self.max_history_messages = int(os.getenv("MAX_HISTORY_MESSAGES", "20"))
            self.enable_thinking = os.getenv("ENABLE_THINKING", "").lower() in ("1", "true")
            self.ollama_timeout = float(os.getenv("OLLAMA_TIMEOUT", "60.0"))
            self.search_timeout = float(os.getenv("SEARCH_TIMEOUT", "10.0"))


settings = Settings()

"""LLM wrapper — Claude, OpenAI, or Ollama, switchable via env var."""

import asyncio
import functools
import json
import logging
import os

log = logging.getLogger("llm")

# Provider config from env
LLM_PROVIDER = os.getenv("LLM_PROVIDER", "").lower()
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "qwen2.5:14b")
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")

# Curated Ollama models — fast, conversational, good for voice agent
# Sorted by parameter count ascending for consistent display
OLLAMA_CATALOG = [
    {"name": "llama3.2:1b", "label": "Llama 3.2", "params": "1B", "params_num": 1.0},
    {"name": "gemma2:2b", "label": "Gemma 2", "params": "2B", "params_num": 2.0},
    {"name": "llama3.2:3b", "label": "Llama 3.2", "params": "3B", "params_num": 3.0},
    {"name": "qwen2.5:3b", "label": "Qwen 2.5", "params": "3B", "params_num": 3.0},
    {"name": "phi3:mini", "label": "Phi-3 Mini", "params": "3.8B", "params_num": 3.8},
    {"name": "mistral", "label": "Mistral", "params": "7B", "params_num": 7.0},
    {"name": "qwen2.5:7b", "label": "Qwen 2.5", "params": "7B", "params_num": 7.0},
    {"name": "deepseek-r1:7b", "label": "DeepSeek R1", "params": "7B", "params_num": 7.0},
    {"name": "llama3.1:8b", "label": "Llama 3.1", "params": "8B", "params_num": 8.0},
    {"name": "gemma2:9b", "label": "Gemma 2", "params": "9B", "params_num": 9.0},
    {"name": "mistral-nemo", "label": "Mistral Nemo", "params": "12B", "params_num": 12.0},
    {"name": "qwen2.5:14b", "label": "Qwen 2.5", "params": "14B", "params_num": 14.0},
    {"name": "deepseek-r1:14b", "label": "DeepSeek R1", "params": "14B", "params_num": 14.0},
]

# Lazy-loaded clients
_anthropic_client = None
_openai_client = None
_httpx_client = None
_async_httpx_client = None


def _resolve_provider() -> str:
    """Determine which LLM provider to use."""
    if LLM_PROVIDER in ("claude", "openai", "ollama"):
        return LLM_PROVIDER
    # Auto-detect: Claude > OpenAI > Ollama
    if ANTHROPIC_API_KEY:
        return "claude"
    if OPENAI_API_KEY:
        return "openai"
    return "ollama"


def _get_anthropic():
    global _anthropic_client
    if _anthropic_client is None:
        import anthropic
        _anthropic_client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
        log.info("Anthropic client initialized")
    return _anthropic_client


def _get_openai():
    global _openai_client
    if _openai_client is None:
        from openai import OpenAI
        _openai_client = OpenAI(api_key=OPENAI_API_KEY)
        log.info("OpenAI client initialized")
    return _openai_client


def _get_httpx():
    global _httpx_client
    if _httpx_client is None:
        import httpx
        _httpx_client = httpx.Client(timeout=30.0)
        log.info("httpx client initialized for Ollama at %s", OLLAMA_URL)
    return _httpx_client


def _get_async_httpx():
    global _async_httpx_client
    if _async_httpx_client is None:
        import httpx
        _async_httpx_client = httpx.AsyncClient(timeout=30.0)
        log.info("async httpx client initialized for Ollama at %s", OLLAMA_URL)
    return _async_httpx_client


def _format_size(size_bytes: int) -> str:
    """Format bytes into human-readable size (e.g., '1.9GB')."""
    if size_bytes >= 1e9:
        return f"{size_bytes / 1e9:.1f}GB"
    if size_bytes >= 1e6:
        return f"{size_bytes / 1e6:.0f}MB"
    return f"{size_bytes / 1e3:.0f}KB"


# ── Ollama discovery ──────────────────────────────────────────

async def list_ollama_models() -> list[dict]:
    """Query Ollama API for installed models. Returns [] if Ollama is offline."""
    try:
        client = _get_async_httpx()
        resp = await client.get(f"{OLLAMA_URL}/api/tags")
        resp.raise_for_status()
        models = resp.json().get("models", [])
        return [
            {
                "name": m["name"],
                "size": m.get("size", 0),
                "size_label": _format_size(m.get("size", 0)),
            }
            for m in models
        ]
    except Exception as e:
        log.warning("Ollama not reachable: %s", e)
        return []


async def get_available_models() -> dict:
    """Build full model catalog: installed Ollama + downloadable + cloud providers."""
    installed = await list_ollama_models()

    # Build lookup from catalog (both "mistral" and "mistral:latest" forms)
    catalog_by_name = {}
    for m in OLLAMA_CATALOG:
        catalog_by_name[m["name"]] = m
        catalog_by_name[m["name"] + ":latest"] = m

    # Normalize names: Ollama reports "mistral:latest" but catalog uses "mistral"
    installed_names = set()
    for m in installed:
        installed_names.add(m["name"])
        if m["name"].endswith(":latest"):
            installed_names.add(m["name"][:-7])
        # Enrich with param info from catalog
        cat = catalog_by_name.get(m["name"])
        if cat:
            m["params"] = cat["params"]
            m["params_num"] = cat["params_num"]
            m["label"] = cat["label"]

    # Sort installed by file size (ascending = smallest first)
    installed.sort(key=lambda m: m.get("size", 0))

    ollama_online = len(installed) > 0 or False

    # If Ollama responded but has no models, it's still online
    if not ollama_online:
        try:
            client = _get_async_httpx()
            resp = await client.get(f"{OLLAMA_URL}/api/tags")
            ollama_online = resp.status_code == 200
        except Exception:
            ollama_online = False

    # Curated models not yet installed (already sorted by params_num in OLLAMA_CATALOG)
    available = [
        {"name": m["name"], "label": m["label"], "params": m["params"]}
        for m in OLLAMA_CATALOG
        if m["name"] not in installed_names
    ]

    # Cloud providers
    cloud = []
    if ANTHROPIC_API_KEY:
        cloud.append({"provider": "claude", "name": "Claude Haiku", "model": "claude-haiku-4-5-20251001"})
    if OPENAI_API_KEY:
        cloud.append({"provider": "openai", "name": f"OpenAI ({OPENAI_MODEL})", "model": OPENAI_MODEL})

    return {
        "ollama_installed": installed,
        "ollama_available": available,
        "ollama_online": ollama_online,
        "cloud_providers": cloud,
    }


async def pull_ollama_model(name: str):
    """Stream-pull an Ollama model. Async generator yielding progress dicts."""
    import httpx
    async with httpx.AsyncClient(timeout=None) as client:
        async with client.stream(
            "POST",
            f"{OLLAMA_URL}/api/pull",
            json={"name": name, "stream": True},
        ) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line.strip():
                    continue
                try:
                    data = json.loads(line)
                    yield data
                except json.JSONDecodeError:
                    continue


# ── Generation ────────────────────────────────────────────────

def _generate_claude(system: str, messages: list[dict]) -> str:
    """Call Claude Haiku via the Anthropic SDK (synchronous)."""
    client = _get_anthropic()
    resp = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=300,
        system=system,
        messages=messages,
    )
    text = resp.content[0].text
    log.info("Claude response: %d chars, stop=%s", len(text), resp.stop_reason)
    return text


def _generate_openai(system: str, messages: list[dict]) -> str:
    """Call OpenAI via the OpenAI SDK (synchronous)."""
    client = _get_openai()
    openai_messages = [{"role": "system", "content": system}] + messages
    resp = client.chat.completions.create(
        model=OPENAI_MODEL,
        max_tokens=300,
        messages=openai_messages,
    )
    text = resp.choices[0].message.content
    log.info("OpenAI response (%s): %d chars, finish=%s", OPENAI_MODEL, len(text), resp.choices[0].finish_reason)
    return text


def _generate_ollama(system: str, messages: list[dict], model: str = "") -> str:
    """Call Ollama local model via HTTP (synchronous)."""
    client = _get_httpx()
    active_model = model or OLLAMA_MODEL
    ollama_messages = [{"role": "system", "content": system}] + messages
    resp = client.post(
        f"{OLLAMA_URL}/api/chat",
        json={"model": active_model, "messages": ollama_messages, "stream": False},
    )
    resp.raise_for_status()
    text = resp.json()["message"]["content"]
    log.info("Ollama response (%s): %d chars", active_model, len(text))
    return text


def _generate_sync(system: str, messages: list[dict], provider: str = "", model: str = "") -> str:
    """Synchronous generate — dispatches to the given or default provider."""
    provider = provider or _resolve_provider()
    log.info("LLM generate: provider=%s, model=%s, %d messages", provider, model, len(messages))
    if provider == "claude":
        return _generate_claude(system, messages)
    elif provider == "openai":
        return _generate_openai(system, messages)
    else:
        return _generate_ollama(system, messages, model=model)


async def generate(system: str, messages: list[dict], provider: str = "", model: str = "") -> str:
    """Generate an LLM response (runs in thread pool).

    Args:
        system: System prompt string.
        messages: Conversation messages [{"role": "user"/"assistant", "content": "..."}].
        provider: Override provider ("claude", "openai", "ollama"). Empty = use default.
        model: Override model name (for Ollama). Empty = use OLLAMA_MODEL env var.

    Returns:
        The assistant's reply text.
    """
    loop = asyncio.get_event_loop()
    fn = functools.partial(_generate_sync, system, messages, provider, model)
    return await loop.run_in_executor(None, fn)


# ── Tool-calling generation ──────────────────────────────────

def _generate_claude_with_tools(system: str, messages: list[dict], tools: list[dict]) -> tuple:
    """Call Claude with tool-use support. Returns (text, tool_calls)."""
    client = _get_anthropic()
    anthropic_tools = [
        {
            "name": t["function"]["name"],
            "description": t["function"]["description"],
            "input_schema": t["function"]["parameters"],
        }
        for t in tools
    ]
    resp = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=300,
        system=system,
        messages=messages,
        tools=anthropic_tools,
    )
    text = ""
    tool_calls = []
    for block in resp.content:
        if block.type == "text":
            text += block.text
        elif block.type == "tool_use":
            tool_calls.append({
                "id": block.id,
                "function": {"name": block.name, "arguments": block.input},
            })
    log.info("Claude response: %d chars, %d tool calls, stop=%s",
             len(text), len(tool_calls), resp.stop_reason)
    return text, tool_calls


def _generate_openai_with_tools(system: str, messages: list[dict], tools: list[dict]) -> tuple:
    """Call OpenAI with tool-use support. Returns (text, tool_calls)."""
    client = _get_openai()
    openai_messages = [{"role": "system", "content": system}] + messages
    resp = client.chat.completions.create(
        model=OPENAI_MODEL,
        max_tokens=300,
        messages=openai_messages,
        tools=tools,
    )
    choice = resp.choices[0]
    text = choice.message.content or ""
    tool_calls = []
    if choice.message.tool_calls:
        for tc in choice.message.tool_calls:
            args = tc.function.arguments
            if isinstance(args, str):
                args = json.loads(args)
            tool_calls.append({
                "id": tc.id,
                "function": {"name": tc.function.name, "arguments": args},
            })
    log.info("OpenAI response (%s): %d chars, %d tool calls",
             OPENAI_MODEL, len(text), len(tool_calls))
    return text, tool_calls


def _generate_ollama_with_tools(system: str, messages: list[dict],
                                tools: list[dict], model: str = "") -> tuple:
    """Call Ollama with tool-use support. Returns (text, tool_calls)."""
    client = _get_httpx()
    active_model = model or OLLAMA_MODEL
    ollama_messages = [{"role": "system", "content": system}] + messages
    body = {"model": active_model, "messages": ollama_messages, "stream": False}
    if tools:
        body["tools"] = tools
    resp = client.post(f"{OLLAMA_URL}/api/chat", json=body)
    resp.raise_for_status()
    msg = resp.json()["message"]
    text = msg.get("content", "")
    raw_tool_calls = msg.get("tool_calls", [])
    tool_calls = [
        {"function": {"name": tc["function"]["name"],
                       "arguments": tc["function"].get("arguments", {})}}
        for tc in raw_tool_calls
    ]
    log.info("Ollama response (%s): %d chars, %d tool calls",
             active_model, len(text), len(tool_calls))
    return text, tool_calls


def _generate_with_tools_sync(system: str, messages: list[dict],
                               tools: list[dict], provider: str = "",
                               model: str = "") -> tuple:
    """Synchronous generate with tools — dispatches to provider."""
    provider = provider or _resolve_provider()
    log.info("LLM generate_with_tools: provider=%s, model=%s, %d tools",
             provider, model, len(tools))
    if provider == "claude":
        return _generate_claude_with_tools(system, messages, tools)
    elif provider == "openai":
        return _generate_openai_with_tools(system, messages, tools)
    else:
        return _generate_ollama_with_tools(system, messages, tools, model=model)


async def generate_with_tools(system: str, messages: list[dict],
                               tools: list[dict], provider: str = "",
                               model: str = "") -> tuple:
    """Generate with tool-calling support (runs in thread pool).

    Returns:
        (text, tool_calls) where tool_calls is a list of:
        [{"id": str (optional), "function": {"name": str, "arguments": dict}}]
    """
    loop = asyncio.get_event_loop()
    fn = functools.partial(
        _generate_with_tools_sync, system, messages, tools, provider, model
    )
    return await loop.run_in_executor(None, fn)


def build_tool_result_messages(provider: str, tool_calls: list[dict],
                                tool_results: dict, original_text: str = "") -> list[dict]:
    """Build provider-specific messages to send tool results back.

    Args:
        provider: "claude", "openai", or "ollama".
        tool_calls: The tool_calls list from generate_with_tools.
        tool_results: Dict mapping tool call index (int) to result string.
        original_text: Any text the model generated alongside tool calls.

    Returns:
        List of messages to append to conversation for the follow-up call.
    """
    messages = []

    if provider == "claude":
        # Claude: assistant content = [text_block?, tool_use_blocks...],
        #         then user content = [tool_result_blocks...]
        assistant_content = []
        if original_text:
            assistant_content.append({"type": "text", "text": original_text})
        for tc in tool_calls:
            assistant_content.append({
                "type": "tool_use",
                "id": tc.get("id", ""),
                "name": tc["function"]["name"],
                "input": tc["function"]["arguments"],
            })
        messages.append({"role": "assistant", "content": assistant_content})
        user_content = [
            {
                "type": "tool_result",
                "tool_use_id": tool_calls[i].get("id", ""),
                "content": result,
            }
            for i, result in tool_results.items()
        ]
        messages.append({"role": "user", "content": user_content})

    elif provider == "openai":
        # OpenAI: assistant message with tool_calls, then tool messages
        openai_tool_calls = [
            {
                "id": tc.get("id", f"call_{i}"),
                "type": "function",
                "function": {
                    "name": tc["function"]["name"],
                    "arguments": json.dumps(tc["function"]["arguments"]),
                },
            }
            for i, tc in enumerate(tool_calls)
        ]
        messages.append({
            "role": "assistant",
            "content": original_text or None,
            "tool_calls": openai_tool_calls,
        })
        for i, result in tool_results.items():
            messages.append({
                "role": "tool",
                "tool_call_id": tool_calls[i].get("id", f"call_{i}"),
                "content": result,
            })

    else:  # ollama
        # Ollama: assistant message with tool_calls, then tool message(s)
        ollama_tool_calls = [
            {"function": {"name": tc["function"]["name"],
                          "arguments": tc["function"]["arguments"]}}
            for tc in tool_calls
        ]
        messages.append({
            "role": "assistant",
            "content": original_text or "",
            "tool_calls": ollama_tool_calls,
        })
        for _i, result in tool_results.items():
            messages.append({"role": "tool", "content": result})

    return messages


def available_providers() -> list[dict]:
    """Return list of available providers with their config status."""
    providers = []
    if ANTHROPIC_API_KEY:
        providers.append({"id": "claude", "name": "Claude Haiku"})
    if OPENAI_API_KEY:
        providers.append({"id": "openai", "name": f"OpenAI ({OPENAI_MODEL})"})
    providers.append({"id": "ollama", "name": f"Ollama ({OLLAMA_MODEL})"})
    return providers


def is_configured() -> bool:
    """Check if any LLM provider is available."""
    provider = _resolve_provider()
    if provider == "claude":
        return bool(ANTHROPIC_API_KEY)
    if provider == "openai":
        return bool(OPENAI_API_KEY)
    # Ollama is assumed available if selected (no easy pre-check)
    return True


def get_provider_name() -> str:
    """Return the name of the active provider."""
    return _resolve_provider()

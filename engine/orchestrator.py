"""Unified orchestrator — single chat loop for all agents.

Merges gateway/server.py inline agent loop (hedging, safety-net search)
with voice_assistant/orchestrator.py (multi-iteration tool calling,
text-tool fallback, think stripping, tool-group history).

Callers wire I/O via callbacks; this module never imports aiohttp,
WebSocket, or TTS.

Provenance: ADR-0001 — orchestrator unification.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Awaitable, Callable, Optional

from engine.llm import (
    generate as llm_generate,
    generate_with_tools as llm_generate_with_tools,
    build_tool_result_messages,
)
from engine.search import (
    search as web_search,
    format_results_for_context,
    is_configured as search_is_configured,
)

log = logging.getLogger("orchestrator")

# ── Type aliases ──────────────────────────────────────────────

DispatchFunc = Callable[[str, dict], Awaitable[str]]
StatusCallback = Callable[[str], Awaitable[None]]
ToolCallCallback = Callable[[str, dict], Awaitable[None]]

# ── Regex patterns ────────────────────────────────────────────

_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)

_TEXT_TOOL_RE = re.compile(
    r"""(?:^|['"`\s])(\w+)\s*\(?\s*(\{[^}]*\})\s*\)?""",
    re.DOTALL,
)

# ── Default constants ─────────────────────────────────────────

DEFAULT_HEDGING_PHRASES: list[str] = [
    "don't have access",
    "don't have real-time",
    "don't have current",
    "don't have the ability",
    "don't have live",
    "do not have access",
    "do not have real-time",
    "do not have current",
    "do not have the ability",
    "can't browse",
    "can't access the internet",
    "can't access the web",
    "can't search",
    "cannot browse",
    "cannot access the internet",
    "cannot access the web",
    "cannot search",
    "not able to browse",
    "not able to access",
    "not able to search",
    "unable to browse",
    "unable to access real",
    "unable to search",
    "my knowledge cutoff",
    "my training data",
    "information is outdated",
    "data is outdated",
    "may be outdated",
    "might be outdated",
    "as an ai",
    "as a language model",
    "as a large language model",
    "lack access",
    "beyond my capabilities",
    "outside my capabilities",
    "not available to me",
    "can't actually browse",
    "can't actually access",
    "can't actually search",
    "cannot actually browse",
    "cannot actually access",
    "cannot actually search",
    "don't actually have access",
    "still under development",
    "not accessible in real-time",
    "not accessible in real time",
    "isn't accessible",
    "is not accessible",
    "can't provide real-time",
    "cannot provide real-time",
    "can't provide you with real-time",
    "i can't answer that",
    "check yahoo finance",
    "check a financial",
    "visit a financial",
    "recommend checking",
]

DEFAULT_TOOL_ALIASES: dict[str, str] = {
    "gc_search": "web_search",
    "search": "web_search",
    "web_search": "web_search",
    "check_calendar": "check_calendar",
    "calendar": "check_calendar",
    "get_calendar": "check_calendar",
    "search_notes": "search_notes",
    "notes": "search_notes",
    "get_notes": "search_notes",
}

def _default_system_prompt() -> str:
    """Build system prompt with current date so the model knows 'today'."""
    from datetime import date
    today = date.today().strftime("%B %d, %Y")
    return (
        f"You are a helpful voice assistant. Today is {today}. "
        "Keep responses concise — one to three sentences. "
        "Speak naturally as in a conversation. "
        "When searching the web, always include the current year in queries "
        "to get fresh results."
    )

DEFAULT_SYSTEM_PROMPT = _default_system_prompt()

SEARCH_CLASSIFIER_PROMPT = (
    "Extract a clean web search query from this user message. "
    "Strip conversational filler and keep only the factual question.\n\n"
    "Reply with ONLY the search query, nothing else.\n\n"
    "Examples:\n"
    "User: 'What is the weather today in Austin?' → weather in Austin today\n"
    "User: 'Yes, look that up, what's the S&P 500?' → S&P 500 current price\n"
    "User: 'Can you tell me who won the Super Bowl?' → who won the Super Bowl"
)


# ── Config dataclass ──────────────────────────────────────────

@dataclass
class OrchestratorConfig:
    """Configuration for the Orchestrator. No pydantic dependency."""

    provider: str = ""                  # "claude"/"openai"/"ollama"/"" (auto)
    model: str = ""                     # model override, "" = env default
    system_prompt: str = ""             # "" = use DEFAULT_SYSTEM_PROMPT
    tools: list[dict] = field(default_factory=list)   # OpenAI-format schemas
    dispatch: Optional[DispatchFunc] = None           # async (name, args) -> str
    max_iterations: int = 5
    max_history: int = 20
    enable_hedging_safety_net: bool = True
    hedging_phrases: list[str] = field(
        default_factory=lambda: list(DEFAULT_HEDGING_PHRASES)
    )
    tool_aliases: dict[str, str] = field(
        default_factory=lambda: dict(DEFAULT_TOOL_ALIASES)
    )
    on_status: Optional[StatusCallback] = None
    on_tool_call: Optional[ToolCallCallback] = None


# ── Orchestrator ──────────────────────────────────────────────

class Orchestrator:
    """Callback-driven chat loop with tool calling, hedging safety net,
    text-tool fallback, think stripping, and tool-group-aware history.
    """

    def __init__(self, config: Optional[OrchestratorConfig] = None) -> None:
        self.config = config or OrchestratorConfig()
        self.messages: list[dict] = []

    # ── Public API ────────────────────────────────────────────

    async def chat(self, user_input: str) -> str:
        """Main entry point: process user input through the tool-calling loop.

        Returns the assistant's final text response.
        """
        self.messages.append({"role": "user", "content": user_input})
        self._trim_history()

        system = self.config.system_prompt or DEFAULT_SYSTEM_PROMPT
        provider = self.config.provider
        model = self.config.model
        tools = self.config.tools if self.config.tools else []

        await self._notify_status("thinking")

        reply = ""
        search_performed = False
        tool_msgs: list[dict] = []  # track for post-tool hedging retry

        try:
            for iteration in range(self.config.max_iterations):
                # On last iteration, omit tools to force text response
                is_last = iteration == self.config.max_iterations - 1
                tools_for_call = [] if is_last else tools

                llm_messages = self._build_llm_messages(system)

                text, tool_calls = await llm_generate_with_tools(
                    system, llm_messages, tools_for_call, provider, model,
                )

                text = self._strip_thinking(text)

                # Fallback: detect tool calls emitted as plain text
                if not tool_calls and text:
                    text_tool_calls = self._parse_text_tool_calls(text)
                    if text_tool_calls:
                        log.info("Detected %d tool call(s) in text output (fallback parser)",
                                 len(text_tool_calls))
                        tool_calls = text_tool_calls
                        text = ""

                if not tool_calls:
                    reply = text
                    break

                # Model wants to call tools — execute each one
                assistant_msg: dict[str, Any] = {"role": "assistant", "content": text}
                assistant_msg["tool_calls"] = tool_calls
                self.messages.append(assistant_msg)

                for i, tc in enumerate(tool_calls):
                    fn = tc.get("function", {})
                    tool_name = fn.get("name", "unknown")
                    tool_args = fn.get("arguments", {})

                    await self._notify_tool_call(tool_name, tool_args)

                    result = await self._dispatch(tool_name, tool_args)
                    search_performed = search_performed or (tool_name == "web_search")

                    tool_msg = {"role": "tool", "content": result}
                    self.messages.append(tool_msg)

                    # Track for provider-specific conversion
                    tool_msgs = build_tool_result_messages(
                        provider, tool_calls, {i: result}, text,
                    )
            else:
                # Exhausted iterations without a text reply
                reply = text if text else "I wasn't able to complete that request."

            # ── Post-tool hedging: model got results but still refused ──
            if search_performed and self._reply_is_hedging(reply):
                log.info("LLM hedged AFTER search results, retrying with directive")
                reply = await self._post_tool_hedging_retry(system, provider, model)

            # ── Safety net: model didn't use tools but hedged ──
            if (not search_performed
                    and self.config.enable_hedging_safety_net
                    and tools
                    and self._reply_is_hedging(reply)):
                log.info("LLM hedged without tools, safety net search")
                safety_reply = await self._safety_net_search(
                    user_input, reply, system, provider, model)
                if safety_reply:
                    reply = safety_reply

        except Exception as e:
            log.error("Orchestrator error: %s", e, exc_info=True)
            raise

        # Record final assistant reply
        if reply:
            self.messages.append({"role": "assistant", "content": reply})

        return reply

    def clear_history(self) -> None:
        """Reset conversation history."""
        self.messages.clear()

    def update_config(self, **kwargs) -> None:
        """Update config fields at runtime (e.g. provider, model, tools)."""
        for key, value in kwargs.items():
            if hasattr(self.config, key):
                setattr(self.config, key, value)

    # ── Message building ──────────────────────────────────────

    def _build_llm_messages(self, system: str) -> list[dict]:
        """Convert internal message history to provider-compatible format.

        Tool groups (assistant with tool_calls + tool results) are converted
        via build_tool_result_messages() for the active provider.
        """
        provider = self.config.provider
        result: list[dict] = []
        i = 0

        while i < len(self.messages):
            msg = self.messages[i]

            if msg.get("tool_calls"):
                # This is an assistant message with tool calls — collect the group
                tool_calls = msg["tool_calls"]
                original_text = msg.get("content", "")

                # Gather subsequent tool-role messages
                tool_results: dict[int, str] = {}
                j = i + 1
                tc_idx = 0
                while j < len(self.messages) and self.messages[j].get("role") == "tool":
                    tool_results[tc_idx] = self.messages[j].get("content", "")
                    tc_idx += 1
                    j += 1

                # Convert the whole group to provider format
                group_msgs = build_tool_result_messages(
                    provider, tool_calls, tool_results, original_text,
                )
                result.extend(group_msgs)
                i = j
            else:
                # Regular user or assistant message
                result.append({"role": msg["role"], "content": msg.get("content", "")})
                i += 1

        return result

    # ── History management ────────────────────────────────────

    def _trim_history(self) -> None:
        """Trim message history to max_history, preserving tool groups.

        A "tool group" is an assistant message with tool_calls followed by
        one or more tool-role messages. These must stay together.
        """
        limit = self.config.max_history
        if len(self.messages) <= limit:
            return

        cut = len(self.messages) - limit
        # Don't cut in the middle of a tool group
        while cut < len(self.messages) and self.messages[cut].get("role") == "tool":
            cut += 1
        # If the message right before cut is an assistant with tool_calls, include it
        if cut > 0 and self.messages[cut - 1].get("tool_calls"):
            cut -= 1
            while cut > 0 and self.messages[cut - 1].get("role") == "tool":
                cut -= 1

        self.messages = self.messages[cut:]

    # ── Content cleanup ───────────────────────────────────────

    @staticmethod
    def _strip_thinking(text: str) -> str:
        """Remove <think>...</think> blocks (Qwen 3 thinking mode)."""
        return _THINK_RE.sub("", text).strip()

    # ── Text-based tool call parsing (fallback) ───────────────

    def _parse_text_tool_calls(self, text: str) -> list[dict]:
        """Detect tool calls embedded in text output.

        Some models (qwen2.5) emit tool calls as text like:
          gc_search {"query": "weather in Austin"}
        This parser catches those and converts them to standard format.
        """
        aliases = self.config.tool_aliases
        results = []
        for match in _TEXT_TOOL_RE.finditer(text):
            raw_name = match.group(1).lower()
            raw_args = match.group(2)

            tool_name = aliases.get(raw_name)
            if not tool_name:
                continue

            try:
                args = json.loads(raw_args)
            except json.JSONDecodeError:
                continue

            results.append({
                "function": {"name": tool_name, "arguments": args}
            })
            log.debug("Parsed text tool call: %s -> %s(%s)", raw_name, tool_name, args)

        return results

    # ── Hedging detection ─────────────────────────────────────

    def _reply_is_hedging(self, reply: str) -> bool:
        """Check if the LLM response contains hedging/refusal phrases."""
        lower = reply.lower()
        return any(phrase in lower for phrase in self.config.hedging_phrases)

    # ── Search query extraction ───────────────────────────────

    async def _extract_search_query(self, text: str) -> str:
        """Extract a clean search query from user text via LLM."""
        provider = self.config.provider
        model = self.config.model
        try:
            reply = await llm_generate(
                SEARCH_CLASSIFIER_PROMPT,
                [{"role": "user", "content": text}],
                provider, model,
            )
            query = reply.strip()
            if len(query) > 5:
                log.info("Query extraction: %r -> %r", text[:50], query[:60])
                return query
        except Exception as e:
            log.warning("Query extraction failed: %s", e)
        return text

    # ── Safety net search (hedging fallback) ──────────────────

    async def _safety_net_search(
        self, user_input: str, _hedged_reply: str,
        system: str, provider: str, model: str,
    ) -> Optional[str]:
        """When the model hedges without calling tools, do a search and retry."""
        if not search_is_configured():
            return None

        search_query = await self._extract_search_query(user_input)

        await self._notify_status("searching")

        try:
            search_result = await web_search(search_query)
            if not search_result:
                return None

            context = format_results_for_context(search_result)
            log.info("Safety net search via %s: %d results",
                     search_result["provider"], len(search_result["results"]))

            # Inject search results as assistant message and re-ask
            llm_messages = self._build_llm_messages(system)
            llm_messages.append({
                "role": "assistant",
                "content": (
                    "I searched the web and found:\n\n"
                    + context
                    + "\nI'll use these results to answer."
                ),
            })

            await self._notify_status("thinking")
            reply = await llm_generate(system, llm_messages, provider, model)
            return reply
        except Exception as e:
            log.warning("Safety net search failed: %s", e)
            return None

    # ── Post-tool hedging retry ───────────────────────────────

    async def _post_tool_hedging_retry(
        self, system: str, provider: str, model: str,
    ) -> str:
        """Retry when model hedges after receiving search results."""
        await self._notify_status("thinking")

        # Add a directive to use the results already in context
        self.messages.append({
            "role": "user",
            "content": (
                "You already searched the web and received results above. "
                "Use those results to answer my question directly. "
                "Do not say you cannot access real-time data — you just did."
            ),
        })

        llm_messages = self._build_llm_messages(system)
        reply = await llm_generate(system, llm_messages, provider, model)
        log.info("Post-tool retry reply: %r", reply[:80])

        # Remove the directive from persistent history, replace with actual reply
        self.messages.pop()  # remove directive
        return reply

    # ── Tool dispatch ─────────────────────────────────────────

    async def _dispatch(self, name: str, args: dict) -> str:
        """Call the configured dispatch function, or return an error."""
        if self.config.dispatch is None:
            return f"Error: no dispatch function configured for tool '{name}'"
        try:
            return await self.config.dispatch(name, args)
        except Exception as e:
            log.warning("Tool dispatch error for '%s': %s", name, e)
            return f"Error executing '{name}': {type(e).__name__}: {e}"

    # ── Callbacks ─────────────────────────────────────────────

    async def _notify_status(self, status: str) -> None:
        """Call on_status callback if configured."""
        if self.config.on_status:
            try:
                await self.config.on_status(status)
            except Exception as e:
                log.warning("on_status callback error: %s", e)

    async def _notify_tool_call(self, name: str, args: dict) -> None:
        """Call on_tool_call callback if configured."""
        if self.config.on_tool_call:
            try:
                await self.config.on_tool_call(name, args)
            except Exception as e:
                log.warning("on_tool_call callback error: %s", e)

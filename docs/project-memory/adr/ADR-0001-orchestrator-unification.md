# ADR-0001: Unify Agent Loops into Single Orchestrator

Status: Accepted
Date: 2026-02-16

## Context

The codebase has two independent implementations of the same concept — "take user
input, call an LLM with tool support, return a response":

### Implementation A: `gateway/server.py` inline agent loop (~120 lines)

Lives inside the `mic_stop` WebSocket handler. Runs when the iPhone user finishes
speaking. Key characteristics:

- **Multi-provider**: Claude, OpenAI, Ollama (switchable at runtime)
- **1 tool**: `web_search` (defined as `SEARCH_TOOL` constant)
- **1 pass + hedging retry**: calls `llm_generate_with_tools()` once, then has two
  fallback paths — "post-tool hedging" (model hedged after receiving results) and
  "safety net" (model didn't call tools at all but hedged)
- **Tight UI coupling**: sends `agent_thinking`, `agent_searching` WS messages,
  speaks "Let me look that up" via TTS mid-loop
- **Missing**: no text-tool-call fallback, no `<think>` block stripping,
  no multi-iteration tool calling, no tool-group-aware history trimming

### Implementation B: `voice_assistant/orchestrator.py` (~200 lines)

Standalone `Orchestrator` class used by the CLI REPL (`voice_assistant/main.py`).
Key characteristics:

- **Ollama-only**: talks directly to Ollama HTTP API
- **3 tools**: `web_search`, `check_calendar`, `search_notes` (plugin registry)
- **Up to 5 tool iterations**: proper loop, last iteration omits tools to force text
- **Text-tool fallback**: `_parse_text_tool_calls()` catches models that emit
  `gc_search {"query": "..."}` as plain text
- **Think stripping**: `_strip_thinking()` removes `<think>...</think>` blocks
- **Tool-group trimming**: `_trim_history()` never splits assistant+tool_calls/
  tool-result message groups
- **Missing**: no UI callbacks, no multi-provider support, no hedging detection

### Why this matters now

Both implementations will diverge further as features are added. Bugs fixed in one
won't be fixed in the other. The server's inline loop is already 120 lines of
deeply-nested async code inside a WebSocket handler — hard to test, hard to extend.

## Decision

Unify both into a single `Orchestrator` class that the server uses through
callback hooks. The architecture becomes:

```
┌─────────────────────────────────────────────────────┐
│  Orchestrator (engine/orchestrator.py)               │
│                                                       │
│  - Multi-provider (Claude/OpenAI/Ollama)             │
│  - Tool registry (web_search + extensible)           │
│  - Up to N tool iterations                           │
│  - Text-tool fallback parsing                        │
│  - Think-block stripping                             │
│  - Hedging detection + safety-net search             │
│  - Tool-group-aware history trimming                 │
│  - Callback hooks:                                    │
│      on_status(phase)        → "thinking","searching" │
│      on_interim_speech(text) → "Let me look that up" │
│      on_tool_call(name,args) → UI feedback            │
│                                                       │
│  async def chat(user_input, **callbacks) -> str       │
└─────────────────────────────────────────────────────┘
          │                           │
          ▼                           ▼
  gateway/server.py            voice_assistant/main.py
  (WebSocket adapter)          (CLI REPL adapter)
  - Wire callbacks to WS       - Wire callbacks to terminal
  - Speak reply via TTS        - Print to console
  - ~30 lines of glue          - ~30 lines of glue
```

### Key design choices:

1. **Move to `engine/orchestrator.py`** — it's core logic, not gateway or voice_assistant
2. **Callback-driven UI** — the orchestrator never imports aiohttp, WebSocket, or TTS.
   Callers provide async callbacks: `on_status`, `on_interim_speech`, `on_tool_call`
3. **Provider-agnostic** — uses `engine/llm.py` for all generation, not direct Ollama
4. **Tool registry** — adopts the voice_assistant plugin pattern but starts with
   just `web_search` (calendar/notes can be added later)
5. **Hedging detection stays** — it's a voice-specific concern but cheap enough to
   keep in the orchestrator as an optional feature

### What gets deleted:

- `gateway/server.py` lines 400-526 (inline agent loop) → replaced by
  `orchestrator.chat()` + callbacks
- `voice_assistant/orchestrator.py` → replaced by `engine/orchestrator.py`
- `voice_assistant/main.py` → updated to use new orchestrator

### What gets preserved:

- `voice_assistant/tools/` registry and plugin pattern
- `voice_assistant/config.py` settings (as optional overrides)
- All test coverage from `tests/test_suite.py`

## Consequences

### Positive
- Single place to fix tool-calling bugs
- Web UI gets: multi-iteration tools, text-tool fallback, think stripping
- CLI REPL gets: multi-provider support, hedging detection
- Server's WS handler drops from ~120 lines of agent logic to ~30 lines of callbacks
- Much easier to test (orchestrator is a pure-logic class, no I/O coupling)
- New tools (weather, calculator, etc.) automatically available in both UIs

### Negative
- Breaking change to `voice_assistant/main.py` imports
- Callback API adds a layer of indirection
- Need to carefully test that UI feedback timing is preserved (the "Let me look
  that up" → search → reply flow must feel the same)
- Risk of regression in the server's WebSocket handler during migration

### Neutral
- `voice_assistant/` directory still exists for CLI-specific code
- Tool registry pattern stays the same
- Test suite tests pure functions that don't move, so most tests survive unchanged

## Evidence

Measured duplication: the two agent loops share ~70% of their logic (generate with
tools → execute tool calls → generate followup). The remaining 30% is adapter code
(WS messages vs. terminal output) that belongs in the caller, not the orchestrator.

Models that benefit from `_parse_text_tool_calls`: Qwen 2.5 3B/7B, which are the
most popular Ollama models in the project's catalog. Without this fallback, tool
calling silently fails in the web UI for ~40% of users.

## Links

Sessions:
- S-2026-02-16-1627-test-suite-orchestrator-plan
- S-2026-02-16-1653-orchestrator-unification

Commits:
- (see S-2026-02-16-1653 session) orchestrator unification implementation

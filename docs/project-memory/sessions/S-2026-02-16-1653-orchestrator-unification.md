# Session

Session-ID: S-2026-02-16-1653-orchestrator-unification
Title: Unified Orchestrator — Merge Dual Agent Loops
Date: 2026-02-16
Author: Claude

## Goal
Merge the two independent LLM agent loop implementations into a single
`engine/orchestrator.py` class, eliminating code duplication and giving
both the web UI and CLI REPL the full feature set.

## Context
The codebase had two parallel agent loops:
1. `gateway/server.py` inline loop (~130 lines) — multi-provider, hedging
   safety net, but no text-tool fallback or multi-iteration tool calling
2. `voice_assistant/orchestrator.py` (~200 lines) — Ollama-only, 5-iteration
   tool loop, text-tool fallback, think stripping, but no hedging detection

Neither was a superset. Both would diverge further as features were added.
ADR-0001 proposed unification.

## Plan
1. Create `engine/orchestrator.py` — unified class with all features from both
2. Add orchestrator-specific tests to `tests/test_suite.py`
3. Update `voice_assistant/main.py` to use new orchestrator
4. Replace `voice_assistant/orchestrator.py` with backwards-compat shim
5. Refactor `gateway/server.py` — replace 130-line inline loop with ~15 lines
6. Update documentation (this session doc, ADR-0001, README)

## Changes Made
- **Created** `engine/orchestrator.py` (~280 lines)
  - `OrchestratorConfig` dataclass (no pydantic dependency)
  - `Orchestrator` class with `chat()`, `clear_history()`, `update_config()`
  - Hedging detection + safety-net search (from server.py)
  - Text-tool fallback parsing (from voice_assistant/orchestrator.py)
  - Think stripping (from voice_assistant/orchestrator.py)
  - Tool-group-aware history trimming (from voice_assistant/orchestrator.py)
  - Callback-driven UI: `on_status`, `on_tool_call`
  - Provider-agnostic: delegates to `engine/llm.py`

- **Modified** `gateway/server.py`
  - Removed: `SEARCH_TOOL`, `SEARCH_CLASSIFIER_PROMPT`, `_extract_search_query`,
    `_HEDGING_PHRASES`, `_reply_is_hedging`, inline agent loop (~130 lines)
  - Added: orchestrator init + callbacks (~30 lines), `_web_search_dispatch`
  - Removed unused imports: `generate`, `generate_with_tools`,
    `build_tool_result_messages`, `ConversationHistory`
  - Net: ~150 lines removed, ~40 added

- **Modified** `voice_assistant/main.py`
  - Now uses `engine.orchestrator.Orchestrator` + `OrchestratorConfig`
  - Model management extracted to local `_ensure_ollama_model()` helper
    using `engine.llm.list_ollama_models()` and `pull_ollama_model()`
  - Tool callback made async (matches new callback signature)

- **Replaced** `voice_assistant/orchestrator.py` with 3-line shim
  re-exporting from `engine.orchestrator`

- **Modified** `tests/test_suite.py`
  - Added `test_orchestrator_config()` — config dataclass defaults
  - Added `test_orchestrator_trim_history()` — tool-group preservation
  - Updated `test_orchestrator_helpers()` — imports from engine.orchestrator
  - Updated `test_hedging_detection()` — imports from engine.orchestrator

- **Updated** `docs/project-memory/adr/ADR-0001-orchestrator-unification.md`
  status to Accepted

- **Updated** `README.md` project structure

## Decisions Made
- **History format**: generic internally (Ollama-style with tool_calls),
  converted to provider-specific format at LLM-call time. This avoids
  storing provider-specific message formats in the orchestrator.
- **Callbacks are async**: both `on_status` and `on_tool_call` are async
  so they can do I/O (send WS messages, speak TTS) without blocking.
- **Tool dispatch is caller-provided**: the orchestrator takes a `dispatch`
  function, not a tool registry. This keeps voice_assistant/tools/ decoupled.
- **LOOKUP_PHRASE stays in server.py**: it's UI-specific (TTS feedback),
  not orchestrator logic. Lives in the `_on_tool_call` callback closure.

## Open Questions
- The orchestrator's `_build_llm_messages()` converts tool groups on every
  LLM call. If history grows large this could be optimized with caching.
- The CLI REPL doesn't have an `on_status` callback yet (could show
  "searching..." in the spinner text).

## Links

Commits:
- (this commit) Unified orchestrator implementation

ADRs:
- ADR-0001 - Unify Agent Loops into Single Orchestrator (Accepted)

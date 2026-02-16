# Session

Session-ID: S-2026-02-16-1627-test-suite-orchestrator-plan
Title: Post-build test suite + orchestrator unification plan
Date: 2026-02-16
Author: Claude + David

## Goal

1. Create a comprehensive post-build test suite covering all layers
2. Document the dual agent-loop architecture (server inline vs. orchestrator)
3. Plan the unification of both into a single orchestrator

## Context

The project has grown to include TTS, STT, WebRTC, LLM tool-calling, web search,
and a voice assistant REPL — but the only test coverage was `scripts/smoke_test.py`
(6 tests covering TTS + ring buffer + STT). Meanwhile, two parallel agent loops
exist: one inline in `gateway/server.py` (lines 400-526) and one in
`voice_assistant/orchestrator.py`. They solve the same problem differently.

### The Two Agent Loops

**`gateway/server.py` (inline, ~120 lines)**
- Runs when iPhone user talks via WebRTC
- Supports Claude, OpenAI, Ollama
- 1 tool: `web_search`
- 1 pass + hedging retry (safety net)
- Interleaves TTS/UI feedback mid-reasoning ("Let me look that up")
- No text-tool-call fallback, no think-block stripping

**`voice_assistant/orchestrator.py` (class-based, ~200 lines)**
- Standalone CLI REPL, Ollama-only
- 3 tools: `web_search`, `check_calendar`, `search_notes`
- Up to 5 tool-call iterations
- `_parse_text_tool_calls()` fallback for non-standard models
- `_strip_thinking()` for Qwen 3 `<think>` blocks
- Tool-group-aware history trimming

## Plan

### Phase 1: Test suite (DONE)
- Created `tests/test_suite.py` — single-file, no pytest, colored output
- 4 categories: unit (~50), integration (~12), service (~9), server (~9)
- `--quick` flag for unit-only runs (<1s)
- Every test wraps in try/except, graceful skip on missing deps

### Phase 2: Hedging improvements + markdown rendering (DONE)
- Added 12 more hedging phrases to safety net
- Added post-tool hedging retry (model hedges AFTER receiving search results)
- Added `_clean_for_speech()` to strip markdown before TTS
- Added safe markdown-to-DOM rendering for agent chat bubbles
- Fixed ws.closed check before sending error on disconnect

### Phase 3: Orchestrator unification (PLANNED — see ADR)
- Merge the two agent loops into a single orchestrator class
- Give the orchestrator callback hooks for UI/TTS events
- Server becomes a thin WebSocket adapter
- Benefits: multi-tool support in web UI, text-tool fallback,
  think stripping, better history trimming, DRY

## Changes Made

### Commit 1: Agent reply quality (hedging, TTS cleanup, markdown)
- `gateway/server.py` — 12 new hedging phrases, post-tool hedging retry, ws.closed guard
- `gateway/webrtc.py` — `_clean_for_speech()` static method, call it in `speak_text()`
- `web/app.js` — `renderMarkdown()` + `renderInline()` for safe DOM-based markdown
- `web/index.html` — cache-bust version bump (v23 → v25)

### Commit 2: Post-build test suite
- `tests/test_suite.py` — 90 test points across 4 categories
- `docs/project-memory/sessions/S-2026-02-16-1627-test-suite-orchestrator-plan.md`

## Decisions Made

1. **Two separate commits** — clean separation between pre-existing feature work
   and the new test suite, so either can be reverted independently.

2. **Skip vs. fail on ImportError** — tests that can't import their module
   (e.g., numpy/aiohttp missing) get SKIP not FAIL. The suite gives exit code 0
   in minimal environments while still running everything it can.

3. **Commit before orchestrator refactor** — the orchestrator unification touches
   core files (server.py, webrtc.py, orchestrator.py). Having a clean commit
   history means we can `git reset --hard` back to this point if needed.

4. **Single-file test runner** — matches smoke_test.py pattern, zero test-framework
   deps, works in any environment with just `python3 tests/test_suite.py`.

## Open Questions

- Should the unified orchestrator support all three providers (Claude/OpenAI/Ollama)
  or stay Ollama-only with the server handling provider switching?
- Should `_clean_for_speech` live on Session or move to a utility module?
- Should the CLI REPL (`voice_assistant/main.py`) be preserved after unification?

## Links

Commits:
- (commit 1) Add agent reply quality: hedging retry, TTS markdown cleanup, chat rendering
- (commit 2) Add post-build test suite (90 tests, 4 categories)

ADRs:
- ADR-0003 (planned) - Orchestrator unification

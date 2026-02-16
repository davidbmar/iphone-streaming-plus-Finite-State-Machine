# Session

Session-ID: S-2026-02-16-0420-web-search-integration
Title: Web Search Integration with Tavily/Brave/DuckDuckGo Fallback
Date: 2026-02-16
Author: Claude

## Goal
Add web search capability to the voice agent so users can ask about weather, news, driving times, and other real-time information — without LLM hallucination.

## Context
The voice agent loop (mic → STT → LLM → TTS → speaker) was complete, but the LLM had no access to real-time information. Users asking factual questions got hallucinated answers or "I don't have access." Adding web search with a two-pass LLM architecture solves this for ALL models (Ollama, Claude, OpenAI) without requiring tool-calling support.

## Plan
1. Create `engine/search.py` with three providers (Tavily, Brave, DuckDuckGo) and fallback chain
2. Modify `gateway/server.py` for two-pass LLM: classifier → search → response
3. Update web frontend with search toggle, ping sound, and "Searching the web..." indicator
4. Update `.env.example` and `requirements.txt`

## Changes Made
- **`engine/search.py`** (NEW) — Three search providers with async httpx client (5s timeout), fallback chain, quota tracking, result formatting for LLM context injection
- **`gateway/server.py`** — Two-pass LLM in mic_stop handler, search classifier helper, `set_search_enabled` WS handler, `/api/quota` HTTP endpoint, enriched `hello_ack`
- **`web/app.js`** — Search toggle DOM ref/state, `playSearchPing()` via Web Audio API, `agent_searching` message handler, modified `agent_thinking` to clean up searching bubble
- **`web/index.html`** — Added search toggle button to top-bar
- **`web/styles.css`** — Searching bubble (pulsing gold), search toggle button (Art Deco style)
- **`.env.example`** — Added `TAVILY_API_KEY`, `BRAVE_API_KEY` with docs
- **`requirements.txt`** — Added `duckduckgo-search>=5.0`

## Decisions Made
- **Two-pass LLM over tool-calling**: Works with all providers (Ollama doesn't support tools). Pass 1 is ~200ms on local models and free. Only burns search quota when needed.
- **System prompt injection**: Search results prepended to system prompt (not user message). Keeps conversation history clean, never mutates `conversation.system`.
- **Web Audio API ping**: Synthesized 880Hz sine tone instead of loading a sound file. Avoids Safari autoplay issues and extra HTTP requests.
- **DDG always available**: `is_configured()` always returns True since DuckDuckGo needs no API key — guarantees search works out of the box with zero config.
- **5-second provider timeout**: Voice agent is latency-sensitive. Slow providers fall through to next.

## Open Questions
- Should we cache search results for repeated similar queries?
- Should the search classifier prompt be tunable?

## Links

Commits:
- (pending commit)

ADRs:
- ADR for two-pass LLM architecture (considered but deferred — decision documented here)

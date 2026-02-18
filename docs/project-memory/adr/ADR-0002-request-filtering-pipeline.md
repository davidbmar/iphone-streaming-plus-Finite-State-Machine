# ADR-0002: Request Filtering Pipeline

Status: Accepted
Date: 2026-02-17

## Context

Voice queries go through STT (Whisper) then straight to the LLM, which takes
11-33 seconds per round trip. Two problems observed in production:

1. **Garbage input** — short mic presses produce noise that Whisper transcribes
   as single words like "You", "The". These burn 5s LLM calls for nothing.
2. **Deterministic queries** — "What time is it in Seattle?" doesn't need an LLM.
   The answer is computable instantly.
3. **Incomplete utterances** — "What is the current?" (user cut off mid-sentence)
   gets sent to the LLM, which guesses instead of asking to repeat.

## Decision

Three-layer filtering pipeline in `_do_agent_reply()` before the LLM:

```
Mic → STT (Whisper) → Layer 1 → Layer 2 → Layer 3 → TTS
                        │          │          │
                     Garbage    Fast-path     LLM
                     filter     (regex)    (with clarification prompt)
```

### Layer 1: Garbage Filter (instant, no LLM)

Location: `gateway/server.py` → `_do_agent_reply()`

Drops input that is almost certainly noise:
- Single-word transcriptions matching known garbage words
  ("you", "the", "um", "uh", "hmm", "a", "i", etc.)
- STT confidence below threshold (no_speech_prob > 0.6 or avg_logprob < -1.0)

Uses faster-whisper's built-in confidence scores — zero extra cost since
they're already computed during transcription.

**Result:** Silently dropped. No LLM call, no TTS, no response.
User sees the transcription on screen but gets no audio reply.

### Layer 2: Fast-Path Intent Matcher (instant, no LLM)

Location: `engine/fast_path.py` → `try_fast_path()`

Regex-based pattern matching for deterministic queries:
- Time queries: "what time is it [in city]?" → computed via timezone lookup
- Date queries: "what day is it?" → computed from system clock
- Timezone lookup: 631-entry table auto-built from IANA database + aliases

Uses `_resolve_timezone()` from `voice_assistant/tools/datetime_tool.py`.

**Result:** Natural language response → TTS. ~10ms total.

### Layer 3: LLM with Clarification Prompt

Location: `engine/orchestrator.py` → system prompt

For input that passes Layers 1 and 2, the LLM processes normally but with
an instruction to ask for clarification on unclear/incomplete input rather
than guessing:

> "If the user's message seems incomplete or unclear (e.g. cut off
> mid-sentence), briefly ask them to repeat it instead of guessing."

**Result:** Either a helpful answer or "Could you repeat that?" → TTS.

## Performance Impact (measured from production logs)

| Query                            | Before (LLM) | After (Pipeline) |
|----------------------------------|---------------|-------------------|
| "You" (garbage)                  | 5s            | 0ms (dropped)     |
| "What time is it?"               | 14s           | 0ms (fast-path)   |
| "What time is it in Seattle?"    | 33s           | 10ms (fast-path)  |
| "What time is it in New Delhi?"  | 26s           | 10ms (fast-path)  |
| "What is the current?"           | 14s (wrong)   | 14s (asks repeat) |

## Consequences

### Positive
- Time queries: 11-33s → <10ms (2,000-3,000x faster)
- Garbage no longer burns LLM/TTS cycles
- Incomplete input gets a helpful "repeat that?" instead of a bad guess
- STT confidence scores are free (already computed by Whisper)

### Negative
- Garbage wordlist needs maintenance (new noise words may appear)
- Fast-path regex patterns only cover time/date — other deterministic queries
  still go to LLM
- Confidence thresholds may need tuning per environment (background noise levels)

### Neutral
- Adding more fast-path patterns (weather, greetings) is straightforward
- The pipeline layers are independent — any can be disabled without affecting others

## Evidence

Production server logs from 2026-02-17 12:46–12:59 UTC-6:
- 8 time queries averaging 22s each via LLM path
- 2 garbage "You" transcriptions wasting 5s each
- 1 incomplete utterance ("What is the current?") producing wrong answer
- Post-fix: all 9 time/date queries verified at 0-10ms via fast-path

## Files

- `gateway/server.py` — Layer 1 (garbage filter) + pipeline orchestration
- `engine/fast_path.py` — Layer 2 (regex intent matcher)
- `engine/stt.py` — STT with confidence scores
- `engine/orchestrator.py` — Layer 3 (system prompt clarification)
- `voice_assistant/tools/datetime_tool.py` — timezone lookup table (631 entries)

## Links

Sessions:
- S-2026-02-17-fast-path-time-queries

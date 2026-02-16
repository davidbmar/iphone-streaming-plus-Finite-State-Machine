#!/usr/bin/env python3
"""Post-build test suite — comprehensive regression tests for all layers.

Follows the smoke_test.py pattern: no pytest, colored PASS/FAIL/SKIP output,
exit code 0/1, --quick for unit-only runs.

Categories:
  1. Unit tests      (~50 tests, no external deps, <1s)
  2. Integration     (~12 tests, need TTS/STT models)
  3. Service tests   (~9 tests, need network/Ollama)
  4. Server tests    (~9 tests, aiohttp test client)

Usage:
    python tests/test_suite.py              # Full suite
    python tests/test_suite.py --quick      # Unit tests only (<1s)
    python tests/test_suite.py --verbose    # Verbose output
"""

import argparse
import asyncio
import json
import os
import struct
import sys
import time

# ── Path setup ────────────────────────────────────────────────
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PROJECT_ROOT)

# ── ANSI colors ──────────────────────────────────────────────
GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
CYAN = "\033[96m"
BOLD = "\033[1m"
RESET = "\033[0m"

# ── Global counters ──────────────────────────────────────────
passed = 0
failed = 0
skipped = 0
verbose = False

SAMPLE_RATE = 48000
FRAME_SAMPLES = 960
BYTES_PER_FRAME = FRAME_SAMPLES * 2


def report(name: str, ok: bool, detail: str = ""):
    """Record and print a single test result."""
    global passed, failed
    if ok:
        tag = f"{GREEN}PASS{RESET}"
        passed += 1
    else:
        tag = f"{RED}FAIL{RESET}"
        failed += 1
    msg = f"  [{tag}] {name}"
    if detail:
        msg += f"  ({detail})"
    print(msg)


def skip(name: str, reason: str = ""):
    """Record and print a skipped test."""
    global skipped
    skipped += 1
    msg = f"  [{YELLOW}SKIP{RESET}] {name}"
    if reason:
        msg += f"  ({reason})"
    print(msg)


def section(title: str):
    """Print a section header."""
    print(f"\n{CYAN}{BOLD}--- {title} ---{RESET}")


def run_async(coro):
    """Run an async coroutine synchronously."""
    return asyncio.get_event_loop().run_until_complete(coro)


# =====================================================================
# CATEGORY 1: UNIT TESTS  (~50 tests, no external services)
# =====================================================================


# ── 1.1 AudioQueue ───────────────────────────────────────────

def test_audio_queue():
    section("AudioQueue")
    try:
        from gateway.audio.audio_queue import AudioQueue

        q = AudioQueue()

        # Enqueue / read FIFO order
        q.enqueue(b"\x01\x02\x03\x04")
        q.enqueue(b"\x05\x06\x07\x08")
        report("enqueue accepts bytes", True)

        out = q.read(4)
        report("read returns first chunk (FIFO)", out == b"\x01\x02\x03\x04")

        out2 = q.read(4)
        report("read returns second chunk", out2 == b"\x05\x06\x07\x08")

        # Zero-pad when short
        q.enqueue(b"\xAA\xBB")
        out3 = q.read(6)
        report("read zero-pads when short", out3 == b"\xAA\xBB" + b"\x00" * 4)

        # Available property
        q.enqueue(b"\x01" * 10)
        report("available reflects enqueued bytes", q.available == 10)

        # Clear
        q.clear()
        report("clear empties queue", q.available == 0)

    except Exception as e:
        report("AudioQueue tests", False, str(e))


# ── 1.2 PCMRingBuffer ───────────────────────────────────────

def test_pcm_ring_buffer():
    section("PCMRingBuffer")
    try:
        from gateway.audio.pcm_ring_buffer import PCMRingBuffer

        buf = PCMRingBuffer(capacity=4096)

        # Write and read
        data = b"\x01\x02" * 100  # 200 bytes
        written = buf.write(data)
        report("write returns byte count", written == 200, f"wrote {written}")
        report("available matches written", buf.available == 200)

        readback = buf.read(200)
        report("read returns correct data", readback == data)
        report("buffer empty after full read", buf.available == 0)

        # Zero-pad when short
        buf.write(b"\xAA" * 10)
        readback = buf.read(20)
        report("read zero-pads when short", readback == b"\xAA" * 10 + b"\x00" * 10)

        # Overflow: write more than capacity
        buf2 = PCMRingBuffer(capacity=100)
        buf2.write(b"\xFF" * 150)
        report("overflow keeps capacity bytes", buf2.available == 100)

        # Clear
        buf2.clear()
        report("clear empties buffer", buf2.available == 0)

    except Exception as e:
        report("PCMRingBuffer tests", False, str(e))


# ── 1.3 ConversationHistory ──────────────────────────────────

def test_conversation_history():
    section("ConversationHistory")
    try:
        from engine.conversation import ConversationHistory, MAX_TURNS

        ch = ConversationHistory(system="Test system prompt")

        # System prompt stored
        report("system prompt stored", ch.system == "Test system prompt")

        # Add turns
        ch.add_turn("user", "Hello")
        ch.add_turn("assistant", "Hi there")
        msgs = ch.get_messages()
        report("add_turn creates messages", len(msgs) == 2)
        report("messages have correct structure",
               msgs[0] == {"role": "user", "content": "Hello"})

        # MAX_TURNS trimming
        for i in range(MAX_TURNS + 5):
            ch.add_turn("user", f"msg-{i}")
        report("MAX_TURNS trims to limit",
               len(ch.get_messages()) == MAX_TURNS,
               f"got {len(ch.get_messages())}, max={MAX_TURNS}")

        # Clear
        ch.clear()
        report("clear empties turns", len(ch.get_messages()) == 0)

    except Exception as e:
        report("ConversationHistory tests", False, str(e))


# ── 1.4 _clean_for_speech ───────────────────────────────────

def test_clean_for_speech():
    section("_clean_for_speech (markdown stripping)")
    try:
        from gateway.webrtc import Session
    except ImportError as e:
        for name in ["strips markdown headers", "strips bold markers",
                     "strips italic markers", "strips bullet points",
                     "strips bare URLs", "appends link note when URL present",
                     "converts markdown links to text", "strips backticks from code"]:
            skip(name, f"gateway.webrtc deps: {e}")
        return

    try:
        clean = Session._clean_for_speech

        # Headers
        report("strips markdown headers",
               clean("## Hello World") == "Hello World")

        # Bold / italic
        report("strips bold markers",
               clean("This is **bold** text") == "This is bold text")
        report("strips italic markers",
               clean("This is *italic* text") == "This is italic text")

        # Bullet points
        report("strips bullet points",
               clean("- Item one\n- Item two") == "Item one. Item two")

        # URLs — should be stripped and note appended
        result = clean("Visit https://example.com for more")
        report("strips bare URLs", "https://" not in result)
        report("appends link note when URL present",
               "See the links on screen" in result)

        # Markdown links
        result = clean("Check [this link](https://example.com) now")
        report("converts markdown links to text", "this link" in result)

        # Inline code
        report("strips backticks from code",
               clean("Run `pip install`") == "Run pip install")

    except Exception as e:
        report("_clean_for_speech tests", False, str(e))


# ── 1.5 _split_sentences ────────────────────────────────────

def test_split_sentences():
    section("_split_sentences")
    try:
        from gateway.webrtc import Session
    except ImportError as e:
        for name in ["splits on period", "splits on exclamation",
                     "splits on question mark", "handles single sentence"]:
            skip(name, f"gateway.webrtc deps: {e}")
        return

    try:
        split = Session._split_sentences

        report("splits on period",
               split("Hello. World.") == ["Hello.", "World."])
        report("splits on exclamation",
               split("Wow! Amazing!") == ["Wow!", "Amazing!"])
        report("splits on question mark",
               split("Really? Yes.") == ["Really?", "Yes."])
        report("handles single sentence",
               split("Just one sentence.") == ["Just one sentence."])

    except Exception as e:
        report("_split_sentences tests", False, str(e))


# ── 1.6 Hedging Detection ───────────────────────────────────

def test_hedging_detection():
    section("Hedging Detection (_reply_is_hedging)")
    try:
        from gateway.server import _reply_is_hedging
    except ImportError as e:
        for name in ["detects 'my knowledge cutoff'", "detects 'as an ai'",
                     "detects 'don't have access'", "non-hedging passes through",
                     "case insensitive detection"]:
            skip(name, f"gateway.server deps: {e}")
        return

    try:
        # Known hedging phrases
        report("detects 'my knowledge cutoff'",
               _reply_is_hedging("Sorry, my knowledge cutoff is 2024."))
        report("detects 'as an ai'",
               _reply_is_hedging("As an AI, I cannot browse the web."))
        report("detects 'don't have access'",
               _reply_is_hedging("I don't have access to real-time data."))

        # Non-hedging
        report("non-hedging passes through",
               not _reply_is_hedging("The weather in Austin is 75 degrees."))

        # Case insensitivity (function lowercases input)
        report("case insensitive detection",
               _reply_is_hedging("MY KNOWLEDGE CUTOFF is April 2024."))

    except Exception as e:
        report("hedging detection tests", False, str(e))


# ── 1.7 format_results_for_context ──────────────────────────

def test_format_results():
    section("format_results_for_context")
    try:
        from engine.search import format_results_for_context

        # Normal data
        data = {
            "provider": "test",
            "query": "test query",
            "results": [
                {"title": "Result 1", "url": "https://a.com", "snippet": "Snippet 1"},
                {"title": "Result 2", "url": "https://b.com", "snippet": "Snippet 2"},
            ],
        }
        out = format_results_for_context(data)
        report("formats results with query header",
               'Web search results for "test query"' in out)
        report("includes numbered results",
               "1. Result 1 (https://a.com)" in out)

        # Empty / None
        report("returns empty for None input",
               format_results_for_context(None) == "")
        report("returns empty for no results",
               format_results_for_context({"results": []}) == "")

    except Exception as e:
        report("format_results tests", False, str(e))


# ── 1.8 build_tool_result_messages ──────────────────────────

def test_build_tool_result_messages():
    section("build_tool_result_messages")
    try:
        from engine.llm import build_tool_result_messages

        tool_calls = [{
            "id": "tc_123",
            "function": {"name": "web_search", "arguments": {"query": "test"}},
        }]
        tool_results = {0: "Search result text"}

        # Claude format
        claude_msgs = build_tool_result_messages("claude", tool_calls, tool_results)
        report("Claude: returns 2 messages (assistant + user)",
               len(claude_msgs) == 2)
        report("Claude: assistant has tool_use content",
               any(b.get("type") == "tool_use" for b in claude_msgs[0]["content"]))

        # OpenAI format
        openai_msgs = build_tool_result_messages("openai", tool_calls, tool_results)
        report("OpenAI: assistant has tool_calls field",
               "tool_calls" in openai_msgs[0])
        report("OpenAI: tool message has tool_call_id",
               openai_msgs[1].get("role") == "tool")

        # Ollama format
        ollama_msgs = build_tool_result_messages("ollama", tool_calls, tool_results)
        report("Ollama: assistant has tool_calls field",
               "tool_calls" in ollama_msgs[0])
        report("Ollama: tool message present",
               ollama_msgs[1].get("role") == "tool")

    except Exception as e:
        report("build_tool_result_messages tests", False, str(e))


# ── 1.9 ice_servers_to_rtc ──────────────────────────────────

def test_ice_servers_to_rtc():
    section("ice_servers_to_rtc")
    try:
        from gateway.webrtc import ice_servers_to_rtc
    except ImportError as e:
        for name in ["converts server with 'urls' key",
                     "converts server with 'url' key", "handles empty list"]:
            skip(name, f"gateway.webrtc deps: {e}")
        return

    try:
        # "urls" key (array form)
        servers = [{"urls": ["stun:stun.l.google.com:19302"]}]
        result = ice_servers_to_rtc(servers)
        report("converts server with 'urls' key", len(result) == 1)

        # "url" key (singular form — Twilio style)
        servers2 = [{"url": "turn:relay.example.com:443", "username": "u", "credential": "p"}]
        result2 = ice_servers_to_rtc(servers2)
        report("converts server with 'url' key", len(result2) == 1)

        # Empty list
        result3 = ice_servers_to_rtc([])
        report("handles empty list", result3 == [])

    except Exception as e:
        report("ice_servers_to_rtc tests", False, str(e))


# ── 1.10 Orchestrator helpers ────────────────────────────────

def test_orchestrator_helpers():
    section("Orchestrator helpers (_strip_thinking, _parse_text_tool_calls)")
    try:
        from voice_assistant.orchestrator import Orchestrator

        # _strip_thinking
        report("strips <think> blocks",
               Orchestrator._strip_thinking("<think>internal</think>Hello") == "Hello")
        report("handles no think blocks",
               Orchestrator._strip_thinking("Just text") == "Just text")
        report("strips multiline think blocks",
               Orchestrator._strip_thinking(
                   "<think>\nline1\nline2\n</think>Result") == "Result")

        # _parse_text_tool_calls
        text = 'gc_search {"query": "weather in Austin"}'
        calls = Orchestrator._parse_text_tool_calls(text)
        report("parses text tool call",
               len(calls) == 1 and calls[0]["function"]["name"] == "web_search",
               f"got {len(calls)} calls")

        # Unknown tool name should not match
        calls2 = Orchestrator._parse_text_tool_calls('unknown_fn {"x": 1}')
        report("ignores unknown tool names", len(calls2) == 0)

        # Alias: "search" → "web_search"
        calls3 = Orchestrator._parse_text_tool_calls('search {"query": "test"}')
        report("resolves tool aliases",
               len(calls3) == 1 and calls3[0]["function"]["name"] == "web_search")

    except ImportError as e:
        skip("Orchestrator helpers (pydantic-settings not installed)", str(e))
    except Exception as e:
        report("Orchestrator helpers", False, str(e))


# ── 1.11 _clean_html ────────────────────────────────────────

def test_clean_html():
    section("_clean_html (voice_assistant)")
    try:
        from voice_assistant.tools.web_search import _clean_html

        report("strips HTML tags",
               _clean_html("<b>bold</b> text") == "bold text")
        report("strips HTML entities",
               _clean_html("hello &amp; world &#x27;") == "hello  world")
        report("handles clean text",
               _clean_html("no html here") == "no html here")

    except ImportError as e:
        skip("_clean_html (voice_assistant deps missing)", str(e))
    except Exception as e:
        report("_clean_html tests", False, str(e))


# ── 1.12 QueuedGenerator ────────────────────────────────────

def test_queued_generator():
    section("QueuedGenerator")
    try:
        from gateway.webrtc import QueuedGenerator
    except ImportError as e:
        for name in ["next_chunk returns AudioChunk", "chunk is 20ms (1920 bytes)",
                     "sample_rate is 48000", "channels is 1",
                     "chunk data matches input", "exhausted buffer returns silence"]:
            skip(name, f"gateway.webrtc deps: {e}")
        return

    try:
        from gateway.audio.audio_queue import AudioQueue
        from engine.types import AudioChunk

        q = AudioQueue()

        # Write 3 frames of constant data
        test_pcm = b"\x42\x00" * (FRAME_SAMPLES * 3)
        q.enqueue(test_pcm)

        gen = QueuedGenerator(q)

        chunk = gen.next_chunk()
        report("next_chunk returns AudioChunk", isinstance(chunk, AudioChunk))
        report("chunk is 20ms (1920 bytes)",
               len(chunk.samples) == BYTES_PER_FRAME,
               f"got {len(chunk.samples)} bytes")
        report("sample_rate is 48000", chunk.sample_rate == 48000)
        report("channels is 1", chunk.channels == 1)

        # Verify data integrity
        expected = b"\x42\x00" * FRAME_SAMPLES
        report("chunk data matches input", chunk.samples == expected)

        # Read remaining, then exhaust
        gen.next_chunk()
        gen.next_chunk()
        chunk4 = gen.next_chunk()
        report("exhausted buffer returns silence",
               chunk4.samples == b"\x00" * BYTES_PER_FRAME)

    except Exception as e:
        report("QueuedGenerator tests", False, str(e))


# ── 1.13 LLM Provider Detection ─────────────────────────────

def test_llm_provider_detection():
    section("LLM provider detection")
    try:
        from engine.llm import is_configured, available_providers

        # is_configured returns bool
        result = is_configured()
        report("is_configured returns bool", isinstance(result, bool))

        # available_providers returns list
        providers = available_providers()
        report("available_providers returns list", isinstance(providers, list))

        # Ollama always present
        ollama_present = any(p.get("id") == "ollama" for p in providers)
        report("Ollama always in provider list", ollama_present)

    except Exception as e:
        report("LLM provider detection tests", False, str(e))


# ── 1.14 Search is_configured ───────────────────────────────

def test_search_configured():
    section("Search is_configured")
    try:
        from engine.search import is_configured

        # DDG is always available, so is_configured() returns True
        report("search is_configured always True (DDG)", is_configured() is True)

    except Exception as e:
        report("search is_configured", False, str(e))


# ── 1.15 Engine types ───────────────────────────────────────

def test_engine_types():
    section("Engine types (VoiceInfo, AudioChunk)")
    try:
        from engine.types import VoiceInfo, AudioChunk

        v = VoiceInfo(id="test", name="Test Voice", description="A test voice")
        report("VoiceInfo fields", v.id == "test" and v.name == "Test Voice")

        c = AudioChunk(samples=b"\x00" * 1920, sample_rate=48000, channels=1)
        report("AudioChunk fields",
               len(c.samples) == 1920 and c.sample_rate == 48000 and c.channels == 1)

        # VoiceInfo is frozen
        try:
            v.id = "changed"
            report("VoiceInfo is frozen (immutable)", False, "mutation succeeded")
        except AttributeError:
            report("VoiceInfo is frozen (immutable)", True)

    except Exception as e:
        report("engine types tests", False, str(e))


# ── 1.16 Adapter sine voices ────────────────────────────────

def test_adapter_voices():
    section("Adapter sine voices")
    try:
        from engine.adapter import list_voices, create_generator, VOICES

        voices = list_voices()
        report("list_voices returns list", isinstance(voices, list))
        report("has sine voices", len(voices) >= 3,
               f"got {len(voices)} voices")

        gen = create_generator("sine-440")
        chunk = gen.next_chunk()
        report("sine generator produces AudioChunk",
               len(chunk.samples) == BYTES_PER_FRAME)

    except Exception as e:
        report("adapter voices tests", False, str(e))


# =====================================================================
# CATEGORY 2: INTEGRATION TESTS  (need local TTS/STT models)
# =====================================================================

def test_tts_synthesize():
    """Integration: Piper TTS produces valid 48kHz PCM."""
    section("TTS synthesize (integration)")
    try:
        from engine.tts import synthesize

        pcm = synthesize("Hello, this is a test.")
        report("synthesize returns bytes", isinstance(pcm, bytes))
        report("output is non-empty", len(pcm) > 0, f"{len(pcm)} bytes")
        report("output is even length (int16)", len(pcm) % 2 == 0)

        num_samples = len(pcm) // 2
        samples = struct.unpack(f"<{num_samples}h", pcm)
        max_val = max(abs(s) for s in samples)
        report("samples within int16 range", max_val <= 32767, f"max={max_val}")

        duration = num_samples / SAMPLE_RATE
        report("duration reasonable (0.5-10s)", 0.5 < duration < 10.0,
               f"{duration:.2f}s")

        return pcm
    except ImportError as e:
        skip("TTS synthesize (piper-tts not installed)", str(e))
        return None
    except Exception as e:
        report("TTS synthesize", False, str(e))
        return None


def test_voice_listing():
    """Integration: list_voices returns structured data."""
    section("TTS voice listing (integration)")
    try:
        from engine.tts import list_voices

        voices = list_voices()
        report("list_voices returns list", isinstance(voices, list))
        report("voices list is non-empty", len(voices) > 0, f"{len(voices)} voices")

        if voices:
            v = voices[0]
            report("voice has id field", "id" in v)
            report("voice has name field", "name" in v)
            report("voice has downloaded field", "downloaded" in v)

    except ImportError as e:
        skip("voice listing (piper-tts not installed)", str(e))
    except Exception as e:
        report("voice listing", False, str(e))


def test_stt_transcribe(pcm: bytes):
    """Integration: STT round-trip."""
    section("STT transcribe (integration)")
    if pcm is None:
        skip("STT transcribe (no TTS output to test with)")
        skip("STT returns string")
        return
    try:
        from engine.stt import transcribe

        text = transcribe(pcm, sample_rate=SAMPLE_RATE)
        report("transcribe returns string", isinstance(text, str))
        report("transcription is non-empty", len(text) > 0, repr(text[:80]))

    except ImportError as e:
        skip("STT transcribe (faster-whisper not installed)", str(e))
    except Exception as e:
        report("STT transcribe", False, str(e))


def test_stt_empty():
    """Integration: STT with empty input returns empty string."""
    section("STT empty input (integration)")
    try:
        from engine.stt import transcribe

        result = transcribe(b"", sample_rate=SAMPLE_RATE)
        report("empty input returns empty string", result == "", repr(result))

    except ImportError as e:
        skip("STT empty input (faster-whisper not installed)", str(e))
    except Exception as e:
        report("STT empty input", False, str(e))


def test_tts_stt_round_trip(pcm: bytes):
    """Integration: TTS -> STT keyword match."""
    section("TTS -> STT round trip (integration)")
    if pcm is None:
        skip("round trip (no TTS output)")
        return
    try:
        from engine.stt import transcribe

        text = transcribe(pcm, sample_rate=SAMPLE_RATE)
        # The TTS input was "Hello, this is a test." — check for keywords
        text_lower = text.lower()
        has_keyword = any(w in text_lower for w in ("hello", "test", "this"))
        report("round trip contains expected keyword", has_keyword,
               repr(text[:80]))

    except ImportError as e:
        skip("round trip (faster-whisper not installed)", str(e))
    except Exception as e:
        report("round trip", False, str(e))


# =====================================================================
# CATEGORY 3: SERVICE TESTS  (need network / Ollama)
# =====================================================================

def test_ollama_connectivity():
    """Service: check Ollama model listing."""
    section("Ollama connectivity (service)")
    try:
        from engine.llm import list_ollama_models

        models = run_async(list_ollama_models())
        if models:
            report("list_ollama_models returns list", isinstance(models, list))
            report("models have name field", "name" in models[0])
        else:
            skip("list_ollama_models (Ollama offline or no models)", "empty list")
            skip("models have name field")

    except Exception as e:
        skip("Ollama connectivity", str(e))


def test_web_search():
    """Service: DuckDuckGo search returns results."""
    section("Web search (service)")
    try:
        from engine.search import search

        result = run_async(search("capital of France"))
        if result:
            report("search returns dict", isinstance(result, dict))
            report("search has results list",
                   isinstance(result.get("results"), list) and len(result["results"]) > 0,
                   f"{len(result.get('results', []))} results")
        else:
            skip("web search (all providers failed)")
            skip("search has results")

    except Exception as e:
        skip("web search", str(e))


def test_search_quota():
    """Service: get_quota_status returns provider list."""
    section("Search quota (service)")
    try:
        from engine.search import get_quota_status

        status = run_async(get_quota_status())
        report("get_quota_status returns dict", isinstance(status, dict))
        report("status has providers list",
               isinstance(status.get("providers"), list) and len(status["providers"]) > 0,
               f"{len(status.get('providers', []))} providers")

    except Exception as e:
        skip("search quota", str(e))


# =====================================================================
# CATEGORY 4: SERVER TESTS  (aiohttp test client)
# =====================================================================

def test_server_health():
    """Server: GET /health returns 200 with status ok."""
    section("Server /health (server)")
    try:
        from aiohttp import web
        from aiohttp.test_utils import TestClient, TestServer

        from gateway.server import create_app

        async def _test():
            app = create_app()
            async with TestClient(TestServer(app)) as client:
                resp = await client.get("/health")
                report("GET /health status 200", resp.status == 200,
                       f"got {resp.status}")
                body = await resp.json()
                report("health response has status=ok",
                       body.get("status") == "ok", str(body))

        run_async(_test())

    except ImportError as e:
        skip("server /health (aiohttp not installed)", str(e))
    except Exception as e:
        report("server /health", False, str(e))


def test_server_index():
    """Server: GET / returns 200 with HTML containing 'Voice'."""
    section("Server index page (server)")
    try:
        from aiohttp import web
        from aiohttp.test_utils import TestClient, TestServer

        from gateway.server import create_app

        async def _test():
            app = create_app()
            async with TestClient(TestServer(app)) as client:
                resp = await client.get("/")
                report("GET / status 200", resp.status == 200,
                       f"got {resp.status}")
                text = await resp.text()
                report("index contains 'Voice'", "Voice" in text or "voice" in text,
                       f"{len(text)} chars")

        run_async(_test())

    except ImportError as e:
        skip("server index (aiohttp not installed)", str(e))
    except Exception as e:
        report("server index", False, str(e))


def test_ws_hello():
    """Server: WebSocket hello with valid token returns hello_ack."""
    section("WebSocket hello (server)")
    try:
        from aiohttp import web
        from aiohttp.test_utils import TestClient, TestServer

        from gateway.server import create_app, AUTH_TOKEN

        async def _test():
            app = create_app()
            async with TestClient(TestServer(app)) as client:
                ws = await client.ws_connect("/ws")
                await ws.send_json({"type": "hello", "token": AUTH_TOKEN})

                resp = await asyncio.wait_for(ws.receive_json(), timeout=10.0)
                report("hello returns hello_ack",
                       resp.get("type") == "hello_ack",
                       f"got type={resp.get('type')}")
                report("hello_ack has voices",
                       isinstance(resp.get("voices"), list))

                await ws.close()

        run_async(_test())

    except ImportError as e:
        skip("WS hello (aiohttp not installed)", str(e))
    except Exception as e:
        report("WS hello", False, str(e))


def test_ws_bad_token():
    """Server: WebSocket hello with wrong token returns error."""
    section("WebSocket bad token (server)")
    try:
        from aiohttp import web
        from aiohttp.test_utils import TestClient, TestServer

        from gateway.server import create_app

        async def _test():
            app = create_app()
            async with TestClient(TestServer(app)) as client:
                ws = await client.ws_connect("/ws")
                await ws.send_json({"type": "hello", "token": "wrong-token"})

                resp = await asyncio.wait_for(ws.receive(), timeout=5.0)
                # Should get error message then close
                if resp.type.name == "TEXT":
                    data = json.loads(resp.data)
                    report("bad token returns error type",
                           data.get("type") == "error",
                           f"got {data.get('type')}")
                    report("error mentions bad token",
                           "token" in data.get("message", "").lower()
                           or "bad" in data.get("message", "").lower(),
                           data.get("message", ""))
                else:
                    # Connection was closed immediately
                    report("bad token closes connection", True, f"msg type={resp.type.name}")
                    skip("error message content (connection closed immediately)")

                await ws.close()

        run_async(_test())

    except ImportError as e:
        skip("WS bad token (aiohttp not installed)", str(e))
    except Exception as e:
        report("WS bad token", False, str(e))


def test_ws_ping_pong():
    """Server: WebSocket ping message returns pong."""
    section("WebSocket ping/pong (server)")
    try:
        from aiohttp import web
        from aiohttp.test_utils import TestClient, TestServer

        from gateway.server import create_app, AUTH_TOKEN

        async def _test():
            app = create_app()
            async with TestClient(TestServer(app)) as client:
                ws = await client.ws_connect("/ws")

                # Authenticate first
                await ws.send_json({"type": "hello", "token": AUTH_TOKEN})
                await asyncio.wait_for(ws.receive_json(), timeout=10.0)

                # Send ping
                await ws.send_json({"type": "ping"})
                resp = await asyncio.wait_for(ws.receive_json(), timeout=5.0)
                report("ping returns pong",
                       resp.get("type") == "pong",
                       f"got type={resp.get('type')}")

                await ws.close()

        run_async(_test())

    except ImportError as e:
        skip("WS ping/pong (aiohttp not installed)", str(e))
    except Exception as e:
        report("WS ping/pong", False, str(e))


# =====================================================================
# MAIN RUNNER
# =====================================================================

def main():
    global verbose

    parser = argparse.ArgumentParser(description="Post-build test suite")
    parser.add_argument("--quick", action="store_true",
                        help="Unit tests only (no models, no network)")
    parser.add_argument("--verbose", action="store_true",
                        help="Verbose output")
    args = parser.parse_args()
    verbose = args.verbose

    # Ensure event loop exists
    try:
        asyncio.get_event_loop()
    except RuntimeError:
        asyncio.set_event_loop(asyncio.new_event_loop())

    start = time.time()

    print(f"\n{BOLD}{'=' * 56}")
    print(f"  Post-Build Test Suite")
    print(f"  Mode: {'--quick (unit only)' if args.quick else 'full'}")
    print(f"{'=' * 56}{RESET}")

    # ── Category 1: Unit tests (always run) ──────────────────
    print(f"\n{BOLD}  CATEGORY 1: Unit Tests{RESET}")
    test_audio_queue()
    test_pcm_ring_buffer()
    test_conversation_history()
    test_clean_for_speech()
    test_split_sentences()
    test_hedging_detection()
    test_format_results()
    test_build_tool_result_messages()
    test_ice_servers_to_rtc()
    test_orchestrator_helpers()
    test_clean_html()
    test_queued_generator()
    test_llm_provider_detection()
    test_search_configured()
    test_engine_types()
    test_adapter_voices()

    if args.quick:
        elapsed = time.time() - start
        _print_summary(elapsed, quick=True)
        return

    # ── Category 2: Integration tests (need TTS/STT models) ─
    print(f"\n{BOLD}  CATEGORY 2: Integration Tests{RESET}")
    pcm = test_tts_synthesize()
    test_voice_listing()
    test_stt_transcribe(pcm)
    test_stt_empty()
    test_tts_stt_round_trip(pcm)

    # ── Category 3: Service tests (need network/Ollama) ──────
    print(f"\n{BOLD}  CATEGORY 3: Service Tests{RESET}")
    test_ollama_connectivity()
    test_web_search()
    test_search_quota()

    # ── Category 4: Server tests (aiohttp test client) ───────
    print(f"\n{BOLD}  CATEGORY 4: Server Tests{RESET}")
    test_server_health()
    test_server_index()
    test_ws_hello()
    test_ws_bad_token()
    test_ws_ping_pong()

    elapsed = time.time() - start
    _print_summary(elapsed)


def _print_summary(elapsed: float, quick: bool = False):
    """Print final summary and exit."""
    total = passed + failed + skipped
    print(f"\n{BOLD}{'=' * 56}")
    print(f"  Results: {GREEN}{passed} passed{RESET}{BOLD}, ", end="")
    if failed:
        print(f"{RED}{failed} failed{RESET}{BOLD}, ", end="")
    else:
        print(f"0 failed, ", end="")
    print(f"{YELLOW}{skipped} skipped{RESET}{BOLD}  ({total} total)")
    print(f"  Time: {elapsed:.1f}s", end="")
    if quick:
        print(f"  (--quick: skipped categories 2-4)")
    else:
        print()
    print(f"{'=' * 56}{RESET}")

    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()

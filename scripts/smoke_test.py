#!/usr/bin/env python3
"""Headless smoke test for the TTS + STT audio pipeline.

Tests each layer without needing a browser or WebRTC connection:
  1. engine/tts.synthesize()  → validates PCM output
  2. PCMRingBuffer            → write/read correctness
  3. BufferedGenerator        → 20ms chunk framing
  4. WAV output               → saves to logs/smoke_test.wav
  5. engine/stt.transcribe()  → STT round-trip (TTS → STT)

Usage:
    python3 scripts/smoke_test.py
"""

import os
import struct
import sys
import wave

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

SAMPLE_RATE = 48000
FRAME_SAMPLES = 960   # 20ms at 48kHz
BYTES_PER_FRAME = FRAME_SAMPLES * 2  # int16 = 2 bytes

passed = 0
failed = 0


def report(name: str, ok: bool, detail: str = ""):
    global passed, failed
    tag = "PASS" if ok else "FAIL"
    msg = f"  [{tag}] {name}"
    if detail:
        msg += f"  ({detail})"
    print(msg)
    if ok:
        passed += 1
    else:
        failed += 1


def test_tts_synthesize():
    """Test 1: Piper TTS produces valid 48kHz PCM."""
    print("\n--- Test 1: TTS synthesize ---")
    try:
        from engine.tts import synthesize

        pcm = synthesize("Hello, this is a smoke test.")
        report("synthesize returns bytes", isinstance(pcm, bytes))
        report("output is non-empty", len(pcm) > 0, f"{len(pcm)} bytes")
        report("output is even length (int16 pairs)", len(pcm) % 2 == 0)

        # Check samples are valid int16 range
        num_samples = len(pcm) // 2
        samples = struct.unpack(f"<{num_samples}h", pcm)
        max_val = max(abs(s) for s in samples)
        report("samples within int16 range", max_val <= 32767, f"max={max_val}")

        duration = num_samples / SAMPLE_RATE
        report("duration is reasonable (0.5-10s)", 0.5 < duration < 10.0, f"{duration:.2f}s")

        return pcm
    except Exception as e:
        report("synthesize executes without error", False, str(e))
        return None


def test_ring_buffer():
    """Test 2: PCMRingBuffer write/read correctness."""
    print("\n--- Test 2: PCMRingBuffer ---")
    try:
        from gateway.audio.pcm_ring_buffer import PCMRingBuffer

        buf = PCMRingBuffer(capacity=4096)

        # Write some data
        test_data = b"\x01\x02" * 100  # 200 bytes
        written = buf.write(test_data)
        report("write returns byte count", written == 200, f"wrote {written}")
        report("available matches written", buf.available == 200, f"avail={buf.available}")

        # Read it back
        readback = buf.read(200)
        report("read returns correct length", len(readback) == 200)
        report("read data matches written", readback == test_data)
        report("buffer empty after full read", buf.available == 0)

        # Read more than available → zero-padded
        buf.write(b"\xAA" * 10)
        readback = buf.read(20)
        report("read zero-pads when short", readback == b"\xAA" * 10 + b"\x00" * 10)

        # Overflow: write more than capacity
        buf2 = PCMRingBuffer(capacity=100)
        buf2.write(b"\xFF" * 150)  # Overflows by 50
        report("overflow keeps latest data", buf2.available == 100)

        # Clear
        buf2.clear()
        report("clear empties buffer", buf2.available == 0)

    except Exception as e:
        report("PCMRingBuffer tests complete", False, str(e))


def test_buffered_generator():
    """Test 3: BufferedGenerator produces correct 20ms chunks."""
    print("\n--- Test 3: BufferedGenerator ---")
    try:
        from gateway.audio.pcm_ring_buffer import PCMRingBuffer
        from gateway.webrtc import BufferedGenerator
        from engine.types import AudioChunk

        buf = PCMRingBuffer(capacity=SAMPLE_RATE * 2 * 2)  # 2 seconds

        # Write 3 frames worth of audio
        test_pcm = b"\x42\x00" * (FRAME_SAMPLES * 3)  # 3 frames of constant 0x0042
        buf.write(test_pcm)

        gen = BufferedGenerator(buf)

        chunk = gen.next_chunk()
        report("next_chunk returns AudioChunk", isinstance(chunk, AudioChunk))
        report("chunk is 20ms (1920 bytes)", len(chunk.samples) == BYTES_PER_FRAME,
               f"got {len(chunk.samples)} bytes")
        report("sample_rate is 48000", chunk.sample_rate == 48000)
        report("channels is 1", chunk.channels == 1)

        # Verify data integrity
        expected = b"\x42\x00" * FRAME_SAMPLES
        report("chunk data matches input", chunk.samples == expected)

        # Read remaining frames
        chunk2 = gen.next_chunk()
        chunk3 = gen.next_chunk()
        report("second chunk correct size", len(chunk2.samples) == BYTES_PER_FRAME)
        report("third chunk correct size", len(chunk3.samples) == BYTES_PER_FRAME)

        # Fourth chunk should be silence (buffer exhausted)
        chunk4 = gen.next_chunk()
        report("exhausted buffer returns silence",
               chunk4.samples == b"\x00" * BYTES_PER_FRAME)

    except Exception as e:
        report("BufferedGenerator tests complete", False, str(e))


def test_wav_output(pcm: bytes):
    """Test 4: Save PCM to WAV file."""
    print("\n--- Test 4: WAV output ---")
    try:
        log_dir = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "logs"
        )
        os.makedirs(log_dir, exist_ok=True)
        wav_path = os.path.join(log_dir, "smoke_test.wav")

        with wave.open(wav_path, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(SAMPLE_RATE)
            wf.writeframes(pcm)

        size = os.path.getsize(wav_path)
        report("WAV file created", os.path.exists(wav_path), wav_path)
        report("WAV file non-empty", size > 44, f"{size} bytes")  # 44 = WAV header

        # Verify WAV is readable
        with wave.open(wav_path, "rb") as wf:
            report("WAV channels = 1", wf.getnchannels() == 1)
            report("WAV sample width = 2", wf.getsampwidth() == 2)
            report("WAV frame rate = 48000", wf.getframerate() == SAMPLE_RATE)

    except Exception as e:
        report("WAV output", False, str(e))


def test_stt_transcribe(pcm: bytes):
    """Test 5: STT round-trip — synthesize text then transcribe it back."""
    print("\n--- Test 5: STT transcribe (round-trip) ---")
    try:
        from engine.stt import transcribe

        text, no_speech, logprob = transcribe(pcm, sample_rate=SAMPLE_RATE)
        report("transcribe returns string", isinstance(text, str))
        report("transcription is non-empty", len(text) > 0, repr(text[:80]))

    except Exception as e:
        report("STT transcribe executes without error", False, str(e))


def test_stt_empty():
    """Test 5b: STT with empty input returns empty string."""
    print("\n--- Test 5b: STT empty input ---")
    try:
        from engine.stt import transcribe

        text, _, _ = transcribe(b"", sample_rate=SAMPLE_RATE)
        report("empty input returns empty string", text == "", repr(text))

    except Exception as e:
        report("STT empty input", False, str(e))


def main():
    global passed, failed
    print("=" * 50)
    print("  Smoke Test: TTS + STT Audio Pipeline")
    print("=" * 50)

    # Test 1: TTS
    pcm = test_tts_synthesize()

    # Test 2: Ring buffer (independent of TTS)
    test_ring_buffer()

    # Test 3: Buffered generator (independent of TTS)
    test_buffered_generator()

    # Test 4: WAV output (needs TTS output)
    if pcm:
        test_wav_output(pcm)
    else:
        print("\n--- Test 4: WAV output ---")
        report("WAV output (skipped — no TTS output)", False, "TTS failed")

    # Test 5: STT round-trip (needs TTS output)
    if pcm:
        test_stt_transcribe(pcm)
    else:
        print("\n--- Test 5: STT transcribe ---")
        report("STT round-trip (skipped — no TTS output)", False, "TTS failed")

    # Test 5b: STT empty input (independent)
    test_stt_empty()

    # Summary
    total = passed + failed
    print("\n" + "=" * 50)
    print(f"  Results: {passed}/{total} passed, {failed} failed")
    print("=" * 50)

    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()

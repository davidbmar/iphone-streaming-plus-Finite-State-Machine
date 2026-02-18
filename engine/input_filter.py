"""Input quality filter — decides if STT output is worth sending to the LLM.

Combines multiple signals to classify transcriptions as VALID, GARBAGE, or
LOW_QUALITY. Saves 10-30s per rejected query by avoiding useless LLM calls.

Signals used (all free — computed during STT):
  - no_speech_prob: Whisper's confidence that the segment is NOT speech
  - avg_logprob: Whisper's average token log-probability (confidence)
  - word count: very short utterances are usually noise
  - audio duration: recordings under ~0.8s are almost always accidental
  - known patterns: common noise transcriptions ("you", "um", "beep", etc.)
"""

import re
import logging
from enum import Enum

log = logging.getLogger("input_filter")


class InputQuality(Enum):
    VALID = "valid"           # Send to fast-path / LLM
    GARBAGE = "garbage"       # Drop silently
    LOW_QUALITY = "low"       # Drop silently (borderline, but not worth LLM cost)


# Single words that Whisper commonly produces from noise / short mic presses.
# NOTE: Do NOT include greetings (hi, hello, hey) or farewells (bye, thanks)
# — those are real conversational signals that deserve LLM responses.
_GARBAGE_WORDS = {
    # Filler / non-speech
    "you", "the", "a", "i", "um", "uh", "hmm", "oh", "ah", "eh",
    # Common Whisper hallucinations on silence/noise
    "beep", "boop", "okay", "ok", "yeah", "yes", "no", "so",
    "well", "right", "like", "just", "but", "and", "or", "if", "it",
    # Noise artifacts
    "something", "nothing", "uh-huh", "mm-hmm", "mhm", "huh",
}

# Patterns that are Whisper hallucinations (repeated punctuation, music notes, etc.)
_HALLUCINATION_PATTERNS = [
    re.compile(r'^[\s\.\,\!\?\-…]+$'),          # Only punctuation: ". . . ."
    re.compile(r'^(\w+\s*)\1{2,}$', re.I),      # Repeated word: "the the the"
    re.compile(r'^\(.*\)$'),                     # Parenthetical: "(upbeat music)"
    re.compile(r'^♪', re.I),                     # Music notes
]


def classify(
    text: str,
    no_speech_prob: float = 0.0,
    avg_logprob: float = 0.0,
    audio_duration_s: float = 0.0,
) -> InputQuality:
    """Classify STT output quality.

    Args:
        text: The transcribed text from Whisper.
        no_speech_prob: Whisper's no-speech probability (0.0-1.0).
        avg_logprob: Whisper's average log probability (negative, closer to 0 = better).
        audio_duration_s: Duration of the audio recording in seconds.

    Returns:
        InputQuality enum value.
    """
    clean = text.strip()

    # Empty
    if not clean:
        return InputQuality.GARBAGE

    # Very short recording — almost always an accidental tap
    if audio_duration_s > 0 and audio_duration_s < 0.6:
        log.info("Filter: too short (%.1fs): %r", audio_duration_s, clean)
        return InputQuality.GARBAGE

    # High no-speech probability — Whisper thinks it's not speech
    if no_speech_prob > 0.6:
        log.info("Filter: no_speech=%.2f: %r", no_speech_prob, clean)
        return InputQuality.GARBAGE

    # Hallucination patterns (". . . .", "(music)", etc.)
    for pattern in _HALLUCINATION_PATTERNS:
        if pattern.match(clean):
            log.info("Filter: hallucination pattern: %r", clean)
            return InputQuality.GARBAGE

    words = clean.rstrip("?.!,").split()
    word_count = len(words)

    # Single-word garbage
    if word_count == 1 and words[0].lower().strip(".-") in _GARBAGE_WORDS:
        log.info("Filter: garbage word: %r", clean)
        return InputQuality.GARBAGE

    # Low confidence + short — likely noise misheard as words
    if avg_logprob < -1.0 and word_count <= 3:
        log.info("Filter: low confidence (logprob=%.2f, %d words): %r",
                 avg_logprob, word_count, clean)
        return InputQuality.LOW_QUALITY

    # Two-word garbage (both words are garbage)
    if word_count == 2:
        w1, w2 = [w.lower().strip("?.!,-") for w in words]
        if w1 in _GARBAGE_WORDS and w2 in _GARBAGE_WORDS:
            log.info("Filter: two garbage words: %r", clean)
            return InputQuality.GARBAGE

    return InputQuality.VALID

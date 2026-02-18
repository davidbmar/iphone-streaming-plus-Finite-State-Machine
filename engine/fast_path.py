"""Fast-path intent matching — intercepts simple queries before the LLM.

For a voice assistant, some queries have deterministic answers that don't
need a 14-second LLM round trip. This module pattern-matches STT output
and returns an instant response, or None to fall through to the LLM.

Current fast paths:
  - Time queries: "what time is it [in city]?" → computed instantly
  - Date queries: "what day is it?" → computed instantly
"""

import re
import logging
from datetime import datetime
from typing import Optional
from zoneinfo import ZoneInfo

from voice_assistant.tools.datetime_tool import _resolve_timezone

log = logging.getLogger("fast_path")

# Patterns that indicate a time/date query
_TIME_PATTERNS = [
    # "what time is it [in X]?" / "what's the time [in X]?"
    re.compile(
        r"what(?:'s| is) the (?:current )?time"
        r"(?:\s+(?:right now|now|currently))?"
        r"(?:\s+in\s+(.+?))?[\?\.\!]?\s*$",
        re.IGNORECASE,
    ),
    re.compile(
        r"what time is it"
        r"(?:\s+(?:right now|now|currently))?"
        r"(?:\s+in\s+(.+?))?[\?\.\!]?\s*$",
        re.IGNORECASE,
    ),
    # "what time is it in Austin, Texas now?"
    re.compile(
        r"what time is it\s+in\s+(.+?)(?:\s+(?:right now|now|currently))?[\?\.\!]?\s*$",
        re.IGNORECASE,
    ),
    # "tell me the time [in X]"
    re.compile(
        r"(?:tell me|give me|get me) the (?:current )?time"
        r"(?:\s+in\s+(.+?))?[\?\.\!]?\s*$",
        re.IGNORECASE,
    ),
]

_DATE_PATTERNS = [
    # "what day is it?" / "what's today's date?" / "what is today?"
    re.compile(r"what(?:'s| is) (?:today(?:'s date)?|the date)[\?\.\!]?\s*$", re.IGNORECASE),
    re.compile(r"what day is it(?: today)?[\?\.\!]?\s*$", re.IGNORECASE),
    re.compile(r"what(?:'s| is) today(?:'s date)?[\?\.\!]?\s*$", re.IGNORECASE),
]


def _clean_location(loc: str) -> str:
    """Strip trailing filler words and state/country suffixes for city lookup."""
    # "Austin, Texas" → "Austin"
    loc = loc.strip().rstrip("?.!")
    # Remove "right now", "now", "currently" from end
    loc = re.sub(r"\s+(?:right now|now|currently)\s*$", "", loc, flags=re.IGNORECASE)
    # Try the full string first (e.g. "Mexico City"), then just the city part
    return loc.strip()


def _format_time_response(now: datetime, location: str = "") -> str:
    """Format a natural spoken time response."""
    time_str = now.strftime("%-I:%M %p")
    day_str = now.strftime("%A, %B %-d, %Y")
    tz_str = now.tzname()

    if location:
        return f"It's {time_str} {tz_str} in {location} — {day_str}."
    else:
        return f"It's {time_str} {tz_str} — {day_str}."


def _format_date_response(now: datetime) -> str:
    """Format a natural spoken date response."""
    return f"Today is {now.strftime('%A, %B %-d, %Y')}."


def try_fast_path(text: str, client_tz: str = "") -> Optional[str]:
    """Try to answer a query without the LLM. Returns response or None.

    Args:
        text: The STT transcription.
        client_tz: The client's IANA timezone (from browser hello message).

    Returns:
        A natural language response string, or None if no fast path matched.
    """
    text_clean = text.strip()
    if not text_clean:
        return None

    # ── Time queries ──────────────────────────────────────────
    for pattern in _TIME_PATTERNS:
        m = pattern.match(text_clean)
        if m:
            location_raw = m.group(1) if m.lastindex and m.group(1) else ""
            location = _clean_location(location_raw) if location_raw else ""

            if location:
                # Try to resolve the city/timezone
                tz = _resolve_timezone(location)
                if not tz:
                    # Try just the first word (e.g. "Austin" from "Austin, Texas")
                    city_part = location.split(",")[0].strip()
                    tz = _resolve_timezone(city_part)
                if tz:
                    now = datetime.now(tz)
                    resp = _format_time_response(now, location)
                    log.info("Fast path (time/%s): %s", location, resp)
                    return resp
                else:
                    # Unknown city — fall through to LLM
                    log.debug("Fast path: unknown location %r, falling through", location)
                    return None
            else:
                # No location — use client timezone or server local
                if client_tz:
                    try:
                        tz = ZoneInfo(client_tz)
                        now = datetime.now(tz)
                    except Exception:
                        now = datetime.now().astimezone()
                else:
                    now = datetime.now().astimezone()
                resp = _format_time_response(now)
                log.info("Fast path (time/local): %s", resp)
                return resp

    # ── Date queries ──────────────────────────────────────────
    for pattern in _DATE_PATTERNS:
        if pattern.match(text_clean):
            if client_tz:
                try:
                    now = datetime.now(ZoneInfo(client_tz))
                except Exception:
                    now = datetime.now().astimezone()
            else:
                now = datetime.now().astimezone()
            resp = _format_date_response(now)
            log.info("Fast path (date): %s", resp)
            return resp

    return None

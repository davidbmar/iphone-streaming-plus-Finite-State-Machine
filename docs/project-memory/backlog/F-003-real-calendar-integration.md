# F-003: Real Calendar Integration

**Type:** Feature
**Priority:** Medium
**Status:** Not started
**Replaces:** Mock in `voice_assistant/tools/calendar.py`

## Summary

Replace the hardcoded fake calendar data with a real calendar API integration.
The mock currently returns the same 4 events regardless of date. A real
integration would let the voice assistant answer "What's on my schedule today?"
with actual data.

## Current State (Mock)

`voice_assistant/tools/calendar.py` returns hardcoded events:
- 9:00 AM: Team standup (Zoom)
- 11:30 AM: Lunch with Alex at Torchy's Tacos
- 2:00 PM: Dentist appointment
- 5:00 PM: Yoga class

The mock is labeled `[MOCK DATA]` in output so users know it's not real.

## Implementation Options

| Approach | Pros | Cons |
|----------|------|------|
| **Apple Calendar (EventKit via PyObjC)** | Native macOS, no API keys | Mac-only, PyObjC dependency, permission prompts |
| **Google Calendar API** | Cross-platform, well-documented | Needs OAuth2 setup, API key, network dependency |
| **CalDAV (generic)** | Works with any CalDAV server (iCloud, Google, Nextcloud) | More complex protocol, auth varies by provider |
| **Local .ics file parsing** | Simple, offline, no auth | User must export/sync calendar file manually |

## What to Implement

1. Replace `execute()` in `voice_assistant/tools/calendar.py`
2. Add any needed config to `voice_assistant/config.py` (API keys, calendar ID)
3. Handle errors gracefully (return error string, not raise)
4. Keep the `BaseTool` interface — name, description, parameters_schema, execute()

## Acceptance Criteria

- "What's on my calendar today?" returns real events
- "What's my schedule for Friday?" returns events for that date
- Works in both web UI and CLI REPL (unified tool path)
- Graceful fallback if calendar not configured ("Calendar not configured. Set up...")

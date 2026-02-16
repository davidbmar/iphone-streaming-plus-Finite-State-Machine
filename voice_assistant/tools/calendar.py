"""Calendar tool — MOCK (returns hardcoded fake events).

Proves multi-tool routing works. Replace with real calendar
API integration (Apple Calendar, Google Calendar, etc.).

See backlog: F-003-real-calendar-integration.md
"""

from datetime import datetime
from typing import Any

from .base import BaseTool


class CalendarTool(BaseTool):
    @property
    def name(self) -> str:
        return "check_calendar"

    @property
    def description(self) -> str:
        return "Check your calendar for upcoming events and appointments."

    @property
    def parameters_schema(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "date": {
                    "type": "string",
                    "description": "Date to check in YYYY-MM-DD format. Defaults to today.",
                },
            },
            "required": [],
        }

    async def execute(self, **kwargs: Any) -> str:
        # MOCK: Replace with real calendar API (F-003)
        date = kwargs.get("date", datetime.now().strftime("%Y-%m-%d"))
        return (
            f"[MOCK DATA] Calendar for {date}:\n"
            f"- 9:00 AM: Team standup (Zoom)\n"
            f"- 11:30 AM: Lunch with Alex at Torchy's Tacos\n"
            f"- 2:00 PM: Dentist appointment\n"
            f"- 5:00 PM: Yoga class"
        )

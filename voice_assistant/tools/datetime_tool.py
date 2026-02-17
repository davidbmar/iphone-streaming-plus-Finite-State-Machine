"""Date/time tool — returns current date, time, and timezone.

Useful for time-sensitive queries so the LLM knows the current
date/year and can include it in search queries for fresh results.
"""

from datetime import datetime
from typing import Any

from .base import BaseTool


class DateTimeTool(BaseTool):
    @property
    def name(self) -> str:
        return "get_current_datetime"

    @property
    def description(self) -> str:
        return "Get the current date, time, day of week, and timezone."

    @property
    def parameters_schema(self) -> dict:
        return {
            "type": "object",
            "properties": {},
            "required": [],
        }

    async def execute(self, **kwargs: Any) -> str:
        now = datetime.now()
        return (
            f"Current date: {now.strftime('%Y-%m-%d')}\n"
            f"Current time: {now.strftime('%I:%M %p')}\n"
            f"Day of week: {now.strftime('%A')}\n"
            f"Year: {now.year}\n"
            f"Timezone: {now.astimezone().tzname()}"
        )

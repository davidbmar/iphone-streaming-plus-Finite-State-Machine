"""Date/time tool — returns current date, time, and timezone.

Supports timezone lookups via:
  - IANA names: "America/Los_Angeles", "Asia/Tokyo"
  - City names: auto-extracted from 518 IANA entries + manual aliases
  - US states: "Texas" → America/Chicago, "California" → America/Los_Angeles
  - Countries: "Japan" → Asia/Tokyo, "Germany" → Europe/Berlin
  - Abbreviations: "NYC", "SF", "LA"

The lookup table is built once at import time from Python's stdlib
zoneinfo database — no network calls, no external dependencies.
"""

from datetime import datetime
from typing import Any, Optional
from zoneinfo import ZoneInfo, available_timezones

from .base import BaseTool


def _build_timezone_lookup() -> dict:
    """Build a comprehensive city/region → IANA timezone lookup table.

    Sources:
      1. Auto-extracted city names from all 518 IANA Region/City entries
      2. Manual aliases for common names, abbreviations, states, countries
    """
    lookup = {}

    # ── Auto-extract from IANA database ───────────────────────
    for tz_name in available_timezones():
        if "/" not in tz_name or tz_name.startswith("Etc/"):
            continue
        # "America/New_York" → "new york"
        # "America/Argentina/Buenos_Aires" → "buenos aires"
        city = tz_name.rsplit("/", 1)[-1]
        city_clean = city.replace("_", " ").lower()
        lookup[city_clean] = tz_name

    # ── US states → representative timezone ───────────────────
    us_states = {
        # Eastern
        "new york state": "America/New_York",
        "connecticut": "America/New_York",
        "delaware": "America/New_York",
        "florida": "America/New_York",
        "georgia": "America/New_York",
        "maine": "America/New_York",
        "maryland": "America/New_York",
        "massachusetts": "America/New_York",
        "michigan": "America/Detroit",
        "new hampshire": "America/New_York",
        "new jersey": "America/New_York",
        "north carolina": "America/New_York",
        "ohio": "America/New_York",
        "pennsylvania": "America/New_York",
        "rhode island": "America/New_York",
        "south carolina": "America/New_York",
        "vermont": "America/New_York",
        "virginia": "America/New_York",
        "washington dc": "America/New_York",
        "dc": "America/New_York",
        "west virginia": "America/New_York",
        # Central
        "alabama": "America/Chicago",
        "arkansas": "America/Chicago",
        "illinois": "America/Chicago",
        "iowa": "America/Chicago",
        "kansas": "America/Chicago",
        "kentucky": "America/New_York",
        "louisiana": "America/Chicago",
        "minnesota": "America/Chicago",
        "mississippi": "America/Chicago",
        "missouri": "America/Chicago",
        "nebraska": "America/Chicago",
        "north dakota": "America/Chicago",
        "oklahoma": "America/Chicago",
        "south dakota": "America/Chicago",
        "tennessee": "America/Chicago",
        "texas": "America/Chicago",
        "wisconsin": "America/Chicago",
        # Mountain
        "arizona": "America/Phoenix",
        "colorado": "America/Denver",
        "idaho": "America/Boise",
        "montana": "America/Denver",
        "new mexico": "America/Denver",
        "utah": "America/Denver",
        "wyoming": "America/Denver",
        # Pacific
        "california": "America/Los_Angeles",
        "nevada": "America/Los_Angeles",
        "oregon": "America/Los_Angeles",
        "washington": "America/Los_Angeles",
        "washington state": "America/Los_Angeles",
        # Non-contiguous
        "alaska": "America/Anchorage",
        "hawaii": "Pacific/Honolulu",
    }
    lookup.update(us_states)

    # ── Countries → capital timezone ──────────────────────────
    countries = {
        "japan": "Asia/Tokyo",
        "china": "Asia/Shanghai",
        "india": "Asia/Kolkata",
        "germany": "Europe/Berlin",
        "france": "Europe/Paris",
        "italy": "Europe/Rome",
        "spain": "Europe/Madrid",
        "uk": "Europe/London",
        "united kingdom": "Europe/London",
        "england": "Europe/London",
        "scotland": "Europe/London",
        "ireland": "Europe/Dublin",
        "australia": "Australia/Sydney",
        "brazil": "America/Sao_Paulo",
        "mexico": "America/Mexico_City",
        "canada": "America/Toronto",
        "south korea": "Asia/Seoul",
        "korea": "Asia/Seoul",
        "russia": "Europe/Moscow",
        "turkey": "Europe/Istanbul",
        "egypt": "Africa/Cairo",
        "south africa": "Africa/Johannesburg",
        "nigeria": "Africa/Lagos",
        "kenya": "Africa/Nairobi",
        "thailand": "Asia/Bangkok",
        "vietnam": "Asia/Ho_Chi_Minh",
        "indonesia": "Asia/Jakarta",
        "philippines": "Asia/Manila",
        "malaysia": "Asia/Kuala_Lumpur",
        "pakistan": "Asia/Karachi",
        "saudi arabia": "Asia/Riyadh",
        "israel": "Asia/Jerusalem",
        "uae": "Asia/Dubai",
        "united arab emirates": "Asia/Dubai",
        "argentina": "America/Argentina/Buenos_Aires",
        "colombia": "America/Bogota",
        "chile": "America/Santiago",
        "peru": "America/Lima",
        "new zealand": "Pacific/Auckland",
        "portugal": "Europe/Lisbon",
        "netherlands": "Europe/Amsterdam",
        "belgium": "Europe/Brussels",
        "switzerland": "Europe/Zurich",
        "austria": "Europe/Vienna",
        "sweden": "Europe/Stockholm",
        "norway": "Europe/Oslo",
        "denmark": "Europe/Copenhagen",
        "finland": "Europe/Helsinki",
        "poland": "Europe/Warsaw",
        "czech republic": "Europe/Prague",
        "greece": "Europe/Athens",
        "taiwan": "Asia/Taipei",
    }
    lookup.update(countries)

    # ── Abbreviations and common aliases ──────────────────────
    aliases = {
        "nyc": "America/New_York",
        "ny": "America/New_York",
        "la": "America/Los_Angeles",
        "sf": "America/Los_Angeles",
        "san fran": "America/Los_Angeles",
        "seattle": "America/Los_Angeles",
        "portland": "America/Los_Angeles",
        "vegas": "America/Los_Angeles",
        "las vegas": "America/Los_Angeles",
        "dallas": "America/Chicago",
        "austin": "America/Chicago",
        "houston": "America/Chicago",
        "san antonio": "America/Chicago",
        "atlanta": "America/New_York",
        "miami": "America/New_York",
        "boston": "America/New_York",
        "philly": "America/New_York",
        "philadelphia": "America/New_York",
        "detroit": "America/Detroit",
        "minneapolis": "America/Chicago",
        "st louis": "America/Chicago",
        "st. louis": "America/Chicago",
        "new delhi": "Asia/Kolkata",
        "delhi": "Asia/Kolkata",
        "mumbai": "Asia/Kolkata",
        "bombay": "Asia/Kolkata",
        "calcutta": "Asia/Kolkata",
        "bangalore": "Asia/Kolkata",
        "chennai": "Asia/Kolkata",
        "hyderabad": "Asia/Kolkata",
        "beijing": "Asia/Shanghai",
        "peking": "Asia/Shanghai",
        "guangzhou": "Asia/Shanghai",
        "shenzhen": "Asia/Shanghai",
        "hong kong": "Asia/Hong_Kong",
        "hk": "Asia/Hong_Kong",
        "mexico city": "America/Mexico_City",
        "sao paulo": "America/Sao_Paulo",
        "rio": "America/Sao_Paulo",
        "rio de janeiro": "America/Sao_Paulo",
        "buenos aires": "America/Argentina/Buenos_Aires",
    }
    lookup.update(aliases)

    return lookup


# Built once at import time — ~700 entries, all from stdlib
_TIMEZONE_LOOKUP = _build_timezone_lookup()


def _resolve_timezone(tz_input: str) -> Optional[ZoneInfo]:
    """Resolve a timezone string — accepts IANA names, cities, states, countries."""
    if not tz_input:
        return None
    clean = tz_input.strip()
    # Try direct IANA name first (e.g. "America/Chicago")
    if clean in available_timezones():
        return ZoneInfo(clean)
    # Try lookup table (case-insensitive)
    key = clean.lower()
    iana = _TIMEZONE_LOOKUP.get(key)
    if iana:
        return ZoneInfo(iana)
    # Try with state/country suffix stripped: "Austin, Texas" → "austin"
    if "," in key:
        city_part = key.split(",")[0].strip()
        iana = _TIMEZONE_LOOKUP.get(city_part)
        if iana:
            return ZoneInfo(iana)
    return None


class DateTimeTool(BaseTool):
    @property
    def name(self) -> str:
        return "get_current_datetime"

    @property
    def description(self) -> str:
        return (
            "Get the current date, time, day of week, and timezone. "
            "Optionally pass a timezone (IANA name like 'America/Los_Angeles' "
            "or city name like 'Seattle') to get time in that region."
        )

    @property
    def parameters_schema(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "timezone": {
                    "type": "string",
                    "description": (
                        "IANA timezone name (e.g. 'America/Los_Angeles', 'Europe/London', "
                        "'Asia/Tokyo') or city name (e.g. 'Seattle', 'London', 'Tokyo'). "
                        "Omit for the user's local time."
                    ),
                },
            },
            "required": [],
        }

    async def execute(self, **kwargs: Any) -> str:
        tz_input = kwargs.get("timezone", "")
        tz = _resolve_timezone(tz_input) if tz_input else None

        if tz:
            now = datetime.now(tz)
            tz_label = tz_input
        else:
            now = datetime.now().astimezone()
            tz_label = "local"

        return (
            f"Current date: {now.strftime('%Y-%m-%d')}\n"
            f"Current time: {now.strftime('%I:%M %p')}\n"
            f"Day of week: {now.strftime('%A')}\n"
            f"Year: {now.year}\n"
            f"Timezone: {now.tzname()} ({tz_label})"
        )

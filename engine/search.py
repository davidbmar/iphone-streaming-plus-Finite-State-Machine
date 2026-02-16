"""Web search — Tavily -> Brave -> DuckDuckGo fallback chain."""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Optional

log = logging.getLogger("search")

TAVILY_API_KEY = os.getenv("TAVILY_API_KEY", "")
BRAVE_API_KEY = os.getenv("BRAVE_API_KEY", "")

MAX_RESULTS = 4
SNIPPET_MAX_LEN = 200
PROVIDER_TIMEOUT = 5.0  # seconds per provider — voice agent is latency-sensitive

# Quota cache
_tavily_quota_cache: dict = {}  # {"remaining": int, "ts": float}
_brave_remaining: Optional[int] = None  # cached from response headers

# Lazy-loaded async httpx client (shared, separate from llm.py's client)
_httpx_client = None


def _get_httpx():
    global _httpx_client
    if _httpx_client is None:
        import httpx
        _httpx_client = httpx.AsyncClient(timeout=PROVIDER_TIMEOUT)
        log.info("Search httpx client initialized (timeout=%.1fs)", PROVIDER_TIMEOUT)
    return _httpx_client


# ── Tavily ────────────────────────────────────────────────────

async def _search_tavily(query: str, api_key: str) -> dict | None:
    """Search via Tavily API. Returns formatted result dict or None."""
    try:
        client = _get_httpx()
        resp = await client.post(
            "https://api.tavily.com/search",
            json={
                "query": query,
                "max_results": MAX_RESULTS,
                "include_answer": False,
            },
            headers={"X-API-Key": api_key, "Content-Type": "application/json"},
        )
        resp.raise_for_status()
        data = resp.json()
        results = []
        for r in data.get("results", [])[:MAX_RESULTS]:
            results.append({
                "title": r.get("title", ""),
                "url": r.get("url", ""),
                "snippet": (r.get("content", "") or "")[:SNIPPET_MAX_LEN],
            })
        if results:
            log.info("Tavily: %d results for %r", len(results), query[:60])
            return {"provider": "tavily", "query": query, "results": results}
    except Exception as e:
        log.warning("Tavily search failed: %s", e)
    return None


async def _check_tavily_quota(api_key: str) -> dict:
    """Check Tavily usage quota. Cached for 5 minutes."""
    now = time.time()
    if _tavily_quota_cache.get("ts", 0) > now - 300:
        return _tavily_quota_cache

    try:
        client = _get_httpx()
        resp = await client.get(
            "https://api.tavily.com/usage",
            headers={"X-API-Key": api_key},
        )
        resp.raise_for_status()
        data = resp.json()
        quota = {
            "used": data.get("total_searches", 0),
            "limit": data.get("monthly_limit", 1000),
            "remaining": data.get("monthly_limit", 1000) - data.get("total_searches", 0),
            "ts": now,
        }
        _tavily_quota_cache.update(quota)
        return quota
    except Exception as e:
        log.warning("Tavily quota check failed: %s", e)
        return {"used": -1, "limit": -1, "remaining": -1, "ts": now}


# ── Brave ─────────────────────────────────────────────────────

async def _search_brave(query: str, api_key: str) -> dict | None:
    """Search via Brave Search API. Returns formatted result dict or None."""
    global _brave_remaining
    try:
        client = _get_httpx()
        resp = await client.get(
            "https://api.search.brave.com/res/v1/web/search",
            params={"q": query, "count": MAX_RESULTS},
            headers={"X-Subscription-Token": api_key, "Accept": "application/json"},
        )
        resp.raise_for_status()

        # Cache rate limit info from headers
        rl = resp.headers.get("x-ratelimit-remaining")
        if rl is not None:
            try:
                _brave_remaining = int(rl)
            except ValueError:
                pass

        data = resp.json()
        results = []
        for r in data.get("web", {}).get("results", [])[:MAX_RESULTS]:
            results.append({
                "title": r.get("title", ""),
                "url": r.get("url", ""),
                "snippet": (r.get("description", "") or "")[:SNIPPET_MAX_LEN],
            })
        if results:
            log.info("Brave: %d results for %r", len(results), query[:60])
            return {"provider": "brave", "query": query, "results": results}
    except Exception as e:
        log.warning("Brave search failed: %s", e)
    return None


# ── DuckDuckGo ────────────────────────────────────────────────

async def _search_duckduckgo(query: str) -> dict | None:
    """Search via duckduckgo-search library (sync, run in executor)."""
    def _sync_search():
        try:
            from duckduckgo_search import DDGS
            with DDGS() as ddgs:
                raw = list(ddgs.text(query, max_results=MAX_RESULTS))
            results = []
            for r in raw[:MAX_RESULTS]:
                results.append({
                    "title": r.get("title", ""),
                    "url": r.get("href", ""),
                    "snippet": (r.get("body", "") or "")[:SNIPPET_MAX_LEN],
                })
            return results
        except Exception as e:
            log.warning("DuckDuckGo search failed: %s", e)
            return []

    loop = asyncio.get_event_loop()
    results = await loop.run_in_executor(None, _sync_search)
    if results:
        log.info("DuckDuckGo: %d results for %r", len(results), query[:60])
        return {"provider": "duckduckgo", "query": query, "results": results}
    return None


# ── Fallback chain ────────────────────────────────────────────

async def search(query: str) -> dict | None:
    """Search with fallback: Tavily -> Brave -> DuckDuckGo.

    Returns: {"provider": str, "query": str, "results": [{"title", "url", "snippet"}]}
    or None if all providers fail.
    """
    result = None

    if TAVILY_API_KEY:
        result = await _search_tavily(query, TAVILY_API_KEY)

    if not result and BRAVE_API_KEY:
        result = await _search_brave(query, BRAVE_API_KEY)

    if not result:
        result = await _search_duckduckgo(query)

    return result


# ── Result formatting ─────────────────────────────────────────

def format_results_for_context(search_data: dict) -> str:
    """Format search results for injection into LLM system prompt.

    Returns a block like:
        Web search results for "weather in Austin":
        1. Title (url)
           Snippet text...
    """
    if not search_data or not search_data.get("results"):
        return ""

    query = search_data.get("query", "")
    lines = [f'Web search results for "{query}":']
    for i, r in enumerate(search_data["results"], 1):
        title = r.get("title", "No title")
        url = r.get("url", "")
        snippet = r.get("snippet", "")
        lines.append(f"{i}. {title} ({url})")
        if snippet:
            lines.append(f"   {snippet}")
    lines.append("")  # trailing newline
    return "\n".join(lines)


# ── Quota status ──────────────────────────────────────────────

async def get_quota_status() -> dict:
    """Return quota info for all configured providers."""
    status = {"providers": []}

    if TAVILY_API_KEY:
        quota = await _check_tavily_quota(TAVILY_API_KEY)
        status["providers"].append({
            "name": "tavily",
            "configured": True,
            "remaining": quota.get("remaining", -1),
            "limit": quota.get("limit", -1),
        })

    if BRAVE_API_KEY:
        status["providers"].append({
            "name": "brave",
            "configured": True,
            "remaining": _brave_remaining if _brave_remaining is not None else -1,
            "limit": -1,  # Brave doesn't expose total in headers
        })

    # DDG is always available
    status["providers"].append({
        "name": "duckduckgo",
        "configured": True,
        "remaining": "unlimited",
        "limit": "unlimited",
    })

    return status


def is_configured() -> bool:
    """Return True if any search provider is available (DDG always is)."""
    return True

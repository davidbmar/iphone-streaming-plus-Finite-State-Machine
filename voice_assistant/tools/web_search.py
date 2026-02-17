"""Web search tool — Serper -> Tavily -> Brave -> DuckDuckGo fallback chain.

Uses native tool-calling: the model decides to call web_search,
the orchestrator executes it, and the result goes back as a tool-role
message that the model treats as authoritative state.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any

import httpx

from ..config import settings
from .base import BaseTool

# Strip HTML tags from search snippets
_HTML_TAG_RE = re.compile(r"<[^>]+>")
_HTML_ENTITY_RE = re.compile(r"&#x[0-9a-fA-F]+;|&[a-z]+;")

log = logging.getLogger("tools.web_search")

MAX_RESULTS = 8
SNIPPET_MAX_LEN = 500


def _clean_html(text: str) -> str:
    """Remove HTML tags and decode common entities."""
    text = _HTML_TAG_RE.sub("", text)
    text = _HTML_ENTITY_RE.sub("", text)
    return text.strip()


class WebSearchTool(BaseTool):
    @property
    def name(self) -> str:
        return "web_search"

    @property
    def description(self) -> str:
        return (
            "Search the web for current information. Use for weather, news, "
            "prices, recent events, or anything requiring up-to-date data."
        )

    @property
    def parameters_schema(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The search query",
                },
            },
            "required": ["query"],
        }

    async def execute(self, **kwargs: Any) -> str:
        query = kwargs.get("query", "")
        if not query:
            return "Error: no search query provided."

        # Fallback chain: Serper -> Tavily -> Brave -> DuckDuckGo
        result = None
        if settings.serper_api_key:
            result = await self._search_serper(query)
        if result is None and settings.tavily_api_key:
            result = await self._search_tavily(query)
        if result is None and settings.brave_api_key:
            result = await self._search_brave(query)
        if result is None:
            result = await self._search_duckduckgo(query)

        if result is None:
            return f"Web search failed for '{query}'. All search providers returned no results."

        return result

    # ── Serper (Google SERP) ─────────────────────────────────

    async def _search_serper(self, query: str) -> str | None:
        """Search via Serper.dev — returns Google results with knowledge graph
        and answer box data that other providers miss."""
        try:
            async with httpx.AsyncClient(timeout=settings.search_timeout) as client:
                resp = await client.post(
                    "https://google.serper.dev/search",
                    json={"q": query, "num": MAX_RESULTS},
                    headers={
                        "X-API-KEY": settings.serper_api_key,
                        "Content-Type": "application/json",
                    },
                )
                resp.raise_for_status()
                data = resp.json()

            lines = [f"Web search results for '{query}':"]

            # Answer box — Google's featured snippet (often has the direct answer)
            answer_box = data.get("answerBox", {})
            if answer_box:
                ab_title = answer_box.get("title", "")
                ab_answer = answer_box.get("answer", "")
                ab_snippet = _clean_html(answer_box.get("snippet", ""))
                ab_list = answer_box.get("list", [])
                if ab_title:
                    lines.append(f"Featured: {ab_title}")
                if ab_answer:
                    lines.append(f"  {ab_answer}")
                if ab_snippet:
                    lines.append(f"  {ab_snippet[:SNIPPET_MAX_LEN]}")
                for item in ab_list[:10]:
                    lines.append(f"  - {_clean_html(str(item))}")

            # Knowledge graph — structured entity data
            kg = data.get("knowledgeGraph", {})
            if kg:
                kg_title = kg.get("title", "")
                kg_type = kg.get("type", "")
                kg_desc = _clean_html(kg.get("description", ""))
                if kg_title:
                    lines.append(f"Knowledge Graph: {kg_title}" +
                                 (f" ({kg_type})" if kg_type else ""))
                if kg_desc:
                    lines.append(f"  {kg_desc[:SNIPPET_MAX_LEN]}")
                for key, val in kg.get("attributes", {}).items():
                    lines.append(f"  {key}: {val}")

            # Organic results
            results = data.get("organic", [])[:MAX_RESULTS]
            if not results and not answer_box and not kg:
                return None

            for i, r in enumerate(results, 1):
                title = _clean_html(r.get("title", "No title"))
                url = r.get("link", "")
                snippet = _clean_html(r.get("snippet", "") or "")[:SNIPPET_MAX_LEN]
                lines.append(f"{i}. {title} ({url})")
                if snippet:
                    lines.append(f"   {snippet}")

            log.info("Serper: %d results for '%s'", len(results), query[:60])
            return "\n".join(lines)
        except Exception as e:
            log.warning("Serper search failed: %s", e)
            return None

    # ── Tavily ────────────────────────────────────────────────

    async def _search_tavily(self, query: str) -> str | None:
        try:
            async with httpx.AsyncClient(timeout=settings.search_timeout) as client:
                resp = await client.post(
                    "https://api.tavily.com/search",
                    json={
                        "query": query,
                        "max_results": MAX_RESULTS,
                        "include_answer": True,
                    },
                    headers={
                        "X-API-Key": settings.tavily_api_key,
                        "Content-Type": "application/json",
                    },
                )
                resp.raise_for_status()
                data = resp.json()

            lines = [f"Web search results for '{query}':"]

            # Tavily can return a direct answer — very useful for factual queries
            answer = data.get("answer")
            if answer:
                lines.append(f"Direct answer: {answer}")
                lines.append("")

            results = data.get("results", [])[:MAX_RESULTS]
            if not results and not answer:
                return None

            for i, r in enumerate(results, 1):
                title = _clean_html(r.get("title", "No title"))
                url = r.get("url", "")
                snippet = _clean_html(r.get("content", "") or "")[:SNIPPET_MAX_LEN]
                lines.append(f"{i}. {title} ({url})")
                if snippet:
                    lines.append(f"   {snippet}")

            log.info("Tavily: %d results for '%s'", len(results), query[:60])
            return "\n".join(lines)
        except Exception as e:
            log.warning("Tavily search failed: %s", e)
            return None

    # ── Brave ─────────────────────────────────────────────────

    async def _search_brave(self, query: str) -> str | None:
        try:
            async with httpx.AsyncClient(timeout=settings.search_timeout) as client:
                resp = await client.get(
                    "https://api.search.brave.com/res/v1/web/search",
                    params={"q": query, "count": MAX_RESULTS},
                    headers={
                        "X-Subscription-Token": settings.brave_api_key,
                        "Accept": "application/json",
                    },
                )
                resp.raise_for_status()
                data = resp.json()

            lines = [f"Web search results for '{query}':"]

            # Brave infobox — structured facts (e.g. market cap, population)
            infobox = data.get("infobox", {})
            if infobox:
                title = infobox.get("title", "")
                desc = _clean_html(infobox.get("description", ""))
                if title:
                    lines.append(f"Infobox: {title}")
                if desc:
                    lines.append(f"  {desc[:SNIPPET_MAX_LEN]}")
                for fact in infobox.get("facts", [])[:8]:
                    lines.append(f"  {fact.get('label', '')}: {_clean_html(fact.get('value', ''))}")

            results = data.get("web", {}).get("results", [])[:MAX_RESULTS]
            if not results and not infobox:
                return None

            for i, r in enumerate(results, 1):
                title = _clean_html(r.get("title", "No title"))
                url = r.get("url", "")
                desc = _clean_html(r.get("description", "") or "")[:SNIPPET_MAX_LEN]
                lines.append(f"{i}. {title} ({url})")
                if desc:
                    lines.append(f"   {desc}")
                for extra in (r.get("extra_snippets") or [])[:2]:
                    lines.append(f"   {_clean_html(extra)[:SNIPPET_MAX_LEN]}")

            log.info("Brave: %d results for '%s'", len(results), query[:60])
            return "\n".join(lines)
        except Exception as e:
            log.warning("Brave search failed: %s", e)
            return None

    # ── DuckDuckGo ────────────────────────────────────────────

    async def _search_duckduckgo(self, query: str) -> str | None:
        def _sync():
            try:
                from duckduckgo_search import DDGS
                with DDGS() as ddgs:
                    return list(ddgs.text(query, max_results=MAX_RESULTS))
            except Exception as e:
                log.warning("DuckDuckGo search failed: %s", e)
                return []

        raw = await asyncio.get_event_loop().run_in_executor(None, _sync)
        if not raw:
            return None

        lines = [f"Web search results for '{query}':"]
        for i, r in enumerate(raw[:MAX_RESULTS], 1):
            title = _clean_html(r.get("title", "No title"))
            url = r.get("href", r.get("url", ""))
            snippet = _clean_html(r.get("body", "") or "")[:SNIPPET_MAX_LEN]
            lines.append(f"{i}. {title} ({url})")
            if snippet:
                lines.append(f"   {snippet}")

        log.info("DuckDuckGo: %d results for '%s'", len(raw), query[:60])
        return "\n".join(lines)

"""RAG tool — queries personal knowledge base for project-related information.

Connects to the RAG service (FastAPI + LanceDB) which has indexed documents
from GitHub repos. The LLM calls this when a question is about the user's
projects, code, or documentation rather than general web knowledge.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from ..config import settings
from .base import BaseTool

log = logging.getLogger("tools.rag")

RAG_TIMEOUT = 2.0
TOP_K = 5
GITHUB_OWNER = "davidbmar"


class RAGTool(BaseTool):
    @property
    def name(self) -> str:
        return "search_knowledge_base"

    @property
    def description(self) -> str:
        return (
            "Search personal knowledge base (GitHub repos, documents) for "
            "relevant information about your projects, code, and documentation."
        )

    @property
    def parameters_schema(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The search query about projects or code",
                },
            },
            "required": ["query"],
        }

    async def execute(self, **kwargs: Any) -> str:
        query = kwargs.get("query", "")
        if not query:
            return "Error: no search query provided."

        try:
            async with httpx.AsyncClient(timeout=RAG_TIMEOUT) as client:
                resp = await client.post(
                    f"{settings.rag_url}/query",
                    json={"query": query, "top_k": TOP_K},
                )
                resp.raise_for_status()
                data = resp.json()
        except httpx.ConnectError:
            log.warning("RAG service not reachable at %s", settings.rag_url)
            return "Knowledge base is currently unavailable (service not running)."
        except httpx.TimeoutException:
            log.warning("RAG query timed out after %.1fs", RAG_TIMEOUT)
            return "Knowledge base query timed out."
        except Exception as e:
            log.warning("RAG query failed: %s", e)
            return f"Knowledge base query failed: {e}"

        results = data.get("results", [])
        if not results:
            return f"No results found in knowledge base for '{query}'."

        # Deduplicate by repo name — show each repo once with best score
        seen_repos: dict[str, dict] = {}
        for r in results:
            filename = r.get("filename", "")
            repo_name = filename.split("/")[0] if "/" in filename else filename
            if repo_name and repo_name not in seen_repos:
                seen_repos[repo_name] = r

        lines = [f"Knowledge base results for '{query}':"]
        for i, (repo_name, r) in enumerate(seen_repos.items(), 1):
            score = r.get("score", 0.0)
            text = r.get("text", "").strip()
            github_url = f"https://github.com/{GITHUB_OWNER}/{repo_name}"
            # Truncate long chunks to keep LLM context manageable
            if len(text) > 500:
                text = text[:500] + "..."
            lines.append(f"{i}. {repo_name} (score: {score:.2f})")
            lines.append(f"   GitHub: {github_url}")
            lines.append(f"   {text}")

        log.info("RAG: %d results for '%s'", len(results), query[:60])
        return "\n".join(lines)

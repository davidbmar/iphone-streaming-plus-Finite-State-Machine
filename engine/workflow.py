"""Hybrid FSM + LLM workflow engine.

WorkflowRunner wraps the Orchestrator (composition, not replacement).
For complex queries matching a workflow template, an FSM drives the steps
and the LLM reasons at each step. Simple queries fall through to
Orchestrator.chat() unchanged.

Templates are keyword-routed (sub-millisecond regex, no LLM call).
Each workflow step gets a focused one-shot LLM call; intermediate
reasoning doesn't pollute conversation history.

Provenance: S-2026-02-16-1802-hybrid-fsm-workflow
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Awaitable, Callable, Optional

from engine.llm import (
    generate as llm_generate,
    generate_with_tools as llm_generate_with_tools,
    last_diagnostics as llm_last_diagnostics,
)
from engine.orchestrator import Orchestrator, OrchestratorConfig

log = logging.getLogger("workflow")

# ── Timeout constants (seconds) ──────────────────────────
LLM_TIMEOUT_SECS = 120.0
SEARCH_TIMEOUT_SECS = 5.0

# ── Type aliases ──────────────────────────────────────────

WorkflowCallback = Callable[..., Awaitable[None]]


# ── Dataclasses ───────────────────────────────────────────

@dataclass
class WorkflowStep:
    """A single state in the workflow FSM."""
    id: str                     # e.g. "decompose", "search_each"
    name: str                   # Human-readable: "Decomposing query"
    step_type: str              # "llm" | "loop" | "direct"
    prompt_template: str = ""   # Template with {{placeholders}}
    tool_name: str = ""         # For "direct" type: tool to call
    next_step: str = ""         # Next state ID, "" = exit
    max_retries: int = 0        # Self-loop retries on failure
    narration: str = ""         # Brief agent narration, e.g. "Looking up..."


@dataclass
class WorkflowDef:
    """A complete workflow definition (FSM)."""
    id: str                     # e.g. "research_compare"
    name: str                   # "Research & Compare"
    description: str            # Brief description
    trigger_keywords: list[str] = field(default_factory=list)
    trigger_pattern: Optional[re.Pattern] = field(default=None, repr=False)
    steps: list[WorkflowStep] = field(default_factory=list)
    min_query_words: int = 6    # Skip routing for short queries


@dataclass
class WorkflowContext:
    """Mutable state carried through a workflow execution."""
    workflow_id: str = ""
    user_query: str = ""
    step_results: dict[str, Any] = field(default_factory=dict)
    search_queries: list[str] = field(default_factory=list)
    search_results: list[str] = field(default_factory=list)
    final_answer: str = ""


# ── Search result truncation for decompose prompts ────────

def _truncate_search_for_decompose(text: str, max_snippet: int = 150, max_total: int = 2500) -> str:
    """Shorten search result snippets to keep decompose prompts small.

    Keeps numbered title lines (e.g. '1. Title (url)') intact since entity
    names appear there. Truncates indented snippet lines to *max_snippet* chars.
    Caps total output at *max_total* chars.
    """
    lines = text.split("\n")
    out = []
    for line in lines:
        if line.startswith("   ") and len(line) > max_snippet:
            out.append(line[:max_snippet] + "...")
        else:
            out.append(line)
    result = "\n".join(out)
    if len(result) > max_total:
        result = result[:max_total] + "\n[...truncated]"
    return result


# ── Template rendering ────────────────────────────────────

def _render_template(template: str, ctx: WorkflowContext) -> str:
    """Simple {{key}} replacement from context fields."""
    # Short version of user query for narration (first 50 chars)
    short_q = ctx.user_query[:50] + ("..." if len(ctx.user_query) > 50 else "")
    today = date.today()
    replacements = {
        "user_query": ctx.user_query,
        "user_query_short": short_q,
        "current_date": today.strftime("%B %d, %Y"),
        "current_year": str(today.year),
        "search_queries": "\n".join(f"- {q}" for q in ctx.search_queries),
        "search_results": "\n\n".join(ctx.search_results),
        "decompose_result": ctx.step_results.get("decompose", ""),
        "claims": ctx.step_results.get("extract_claim", ""),
        "evidence": ctx.step_results.get("search_evidence", ""),
        "counter_evidence": ctx.step_results.get("search_counter", ""),
        "initial_search": ctx.step_results.get("initial_search", ""),
        "initial_lookup": _truncate_search_for_decompose(
            ctx.step_results.get("initial_lookup", "")
        ),
        "gap_analysis": ctx.step_results.get("evaluate_gaps", ""),
        "targeted_results": ctx.step_results.get("targeted_search", ""),
    }
    result = template
    for key, value in replacements.items():
        result = result.replace("{{" + key + "}}", str(value))
    return result


# ── JSON parsing helper ───────────────────────────────────

def _maybe_parse_json(text: str) -> Any:
    """Parse JSON from LLM output, handling code-fenced blocks.

    Models often wrap JSON in ```json ... ``` — strip that first.
    Returns parsed object or the original string if not JSON.
    """
    stripped = text.strip()

    # Strip code fences
    if stripped.startswith("```"):
        lines = stripped.split("\n")
        # Remove first line (```json) and last line (```)
        if len(lines) >= 3 and lines[-1].strip() == "```":
            stripped = "\n".join(lines[1:-1]).strip()

    try:
        return json.loads(stripped)
    except (json.JSONDecodeError, ValueError):
        return text


# ── Workflow templates ────────────────────────────────────

def _build_templates() -> dict[str, WorkflowDef]:
    """Build the three workflow templates with precompiled regex."""

    templates = {}

    # 1. Research & Compare
    rc = WorkflowDef(
        id="research_compare",
        name="Research & Compare",
        description="Establish ranking, decompose into per-entity lookups, synthesize",
        trigger_keywords=[
            "compare", "comparison", "versus", "vs",
            "top \\d+",
            "top (three|four|five|six|seven|eight|nine|ten)",
            "each", "both",
            "market cap", "difference between",
            "which is better", "pros and cons",
            "biggest", "largest", "highest",
        ],
        steps=[
            WorkflowStep(
                id="initial_lookup",
                name="Establishing ranking",
                step_type="llm",
                prompt_template=(
                    "Today is {{current_date}}.\n"
                    "The user asked: {{user_query}}\n\n"
                    "Generate a web search query to find the CURRENT, AUTHORITATIVE "
                    "ranking with company/entity names listed. The query MUST include "
                    "the year {{current_year}} so results are fresh.\n\n"
                    "Good: 'top 5 S&P 500 companies by market cap list {{current_year}}'\n"
                    "Bad:  'S&P 500 stocks'\n\n"
                    "Return ONLY the search query string, nothing else."
                ),
                tool_name="web_search",
                next_step="decompose",
                narration="Searching for current ranking...",
            ),
            WorkflowStep(
                id="decompose",
                name="Decomposing query",
                step_type="llm",
                prompt_template=(
                    "Today is {{current_date}}.\n"
                    "The user asked: {{user_query}}\n\n"
                    "Here are current search results:\n"
                    "---BEGIN SEARCH RESULTS---\n{{initial_lookup}}\n---END SEARCH RESULTS---\n\n"
                    "TASK: Identify the entities the user is asking about and create "
                    "one search query per entity to look up current data.\n\n"
                    "RULES:\n"
                    "- FIRST check the search results for entity names\n"
                    "- If the search results don't list specific entity names, use your "
                    "knowledge to identify the most likely current entities and we will "
                    "verify with search\n"
                    "- If the user asked for 'top N', return EXACTLY N entities\n"
                    "- Include ticker symbols when known\n"
                    "- Include '{{current_year}}' in each query\n\n"
                    "Return ONLY a JSON array of search queries. Example format:\n"
                    "[\"Apple AAPL market cap {{current_year}}\", "
                    "\"NVIDIA NVDA market cap {{current_year}}\", "
                    "\"Microsoft MSFT market cap {{current_year}}\"]\n\n"
                    "JSON array:"
                ),
                next_step="search_each",
                narration="Decomposing into individual lookups...",
            ),
            WorkflowStep(
                id="search_each",
                name="Searching each entity",
                step_type="loop",
                tool_name="web_search",
                next_step="synthesize",
                narration="Looking up each entity...",
            ),
            WorkflowStep(
                id="synthesize",
                name="Synthesizing",
                step_type="llm",
                prompt_template=(
                    "Today is {{current_date}}.\n"
                    "The user asked: {{user_query}}\n\n"
                    "Here are per-entity search results:\n{{search_results}}\n\n"
                    "RULES:\n"
                    "- Present the entities in RANKED ORDER (largest to smallest, "
                    "best to worst, etc. — matching the user's question)\n"
                    "- ONLY cite numbers that appear in the search results above\n"
                    "- If your training knowledge contradicts the search results, "
                    "TRUST THE SEARCH RESULTS — they are more recent\n"
                    "- Include specific numbers/facts from the results\n"
                    "- Keep it conversational — this will be spoken aloud by a voice "
                    "assistant (2-4 sentences)"
                ),
                next_step="",
                narration="Putting it all together...",
            ),
        ],
    )
    templates["research_compare"] = rc

    # 2. Deep Research
    dr = WorkflowDef(
        id="deep_research",
        name="Deep Research",
        description="Initial search, evaluate gaps, targeted follow-up, synthesize",
        trigger_keywords=[
            "tell me about", "research", "explain in detail",
            "what's happening with", "deep dive",
            "comprehensive", "thorough",
        ],
        min_query_words=5,
        steps=[
            WorkflowStep(
                id="initial_search",
                name="Initial search",
                step_type="llm",
                prompt_template=(
                    "Today is {{current_date}}.\n"
                    "The user asked: {{user_query}}\n\n"
                    "Generate a focused web search query to find the most relevant, "
                    "current information. Include '{{current_year}}' in the query.\n\n"
                    "Return ONLY the search query string, nothing else."
                ),
                tool_name="web_search",
                next_step="evaluate_gaps",
                narration="Searching for {{user_query_short}}...",
            ),
            WorkflowStep(
                id="evaluate_gaps",
                name="Evaluating gaps",
                step_type="llm",
                prompt_template=(
                    "Today is {{current_date}}.\n"
                    "The user asked: {{user_query}}\n\n"
                    "Initial search results:\n{{initial_search}}\n\n"
                    "What key information is still missing to fully answer this "
                    "question? Generate 1-2 follow-up search queries as a JSON "
                    "array to fill the gaps. Include '{{current_year}}' in queries.\n\n"
                    "Return ONLY the JSON array of search query strings."
                ),
                next_step="targeted_search",
                narration="Evaluating what else we need...",
            ),
            WorkflowStep(
                id="targeted_search",
                name="Targeted search",
                step_type="loop",
                tool_name="web_search",
                next_step="synthesize",
                narration="Running follow-up searches...",
            ),
            WorkflowStep(
                id="synthesize",
                name="Synthesizing",
                step_type="llm",
                prompt_template=(
                    "Today is {{current_date}}.\n"
                    "The user asked: {{user_query}}\n\n"
                    "Initial findings:\n{{initial_search}}\n\n"
                    "Follow-up findings:\n{{search_results}}\n\n"
                    "RULES:\n"
                    "- ONLY cite facts/numbers from the search results above\n"
                    "- If your training knowledge contradicts the search results, "
                    "TRUST THE SEARCH RESULTS\n"
                    "- Include specific facts, dates, and numbers\n"
                    "- Keep it conversational for a voice assistant (3-5 sentences)"
                ),
                next_step="",
                narration="Putting it all together...",
            ),
        ],
    )
    templates["deep_research"] = dr

    # 3. Fact Check
    fc = WorkflowDef(
        id="fact_check",
        name="Fact Check",
        description="Extract claim, search evidence, search counter-evidence, verdict",
        trigger_keywords=[
            "is it true", "fact check", "verify",
            "debunk", "is that correct", "true that",
            "really true", "actually true",
        ],
        steps=[
            WorkflowStep(
                id="extract_claim",
                name="Extracting claim",
                step_type="llm",
                prompt_template=(
                    "Today is {{current_date}}.\n"
                    "The user asked: {{user_query}}\n\n"
                    "Extract the core factual claim being questioned. "
                    "Then generate TWO search queries:\n"
                    "1. A query to find evidence SUPPORTING the claim (include '{{current_year}}')\n"
                    "2. A query to find evidence AGAINST the claim (include '{{current_year}}')\n\n"
                    "Return JSON: {\"claim\": \"...\", \"support_query\": \"...\", "
                    "\"counter_query\": \"...\"}"
                ),
                next_step="search_evidence",
                narration="Extracting the claim to check...",
            ),
            WorkflowStep(
                id="search_evidence",
                name="Searching for evidence",
                step_type="direct",
                tool_name="web_search",
                next_step="search_counter",
                narration="Searching for supporting evidence...",
            ),
            WorkflowStep(
                id="search_counter",
                name="Searching counter-evidence",
                step_type="direct",
                tool_name="web_search",
                next_step="verdict",
                narration="Searching for counter-evidence...",
            ),
            WorkflowStep(
                id="verdict",
                name="Rendering verdict",
                step_type="llm",
                prompt_template=(
                    "Today is {{current_date}}.\n"
                    "The user asked: {{user_query}}\n\n"
                    "Claim: {{claims}}\n\n"
                    "Supporting evidence:\n{{evidence}}\n\n"
                    "Counter-evidence:\n{{counter_evidence}}\n\n"
                    "RULES:\n"
                    "- Base your verdict ONLY on the evidence above\n"
                    "- Do NOT rely on training knowledge for factual claims\n"
                    "- Render a fair verdict: true, false, partly true, or unverified\n"
                    "- Cite specific evidence from the search results\n"
                    "- Keep it conversational for a voice assistant (2-4 sentences)"
                ),
                next_step="",
                narration="Rendering verdict...",
            ),
        ],
    )
    templates["fact_check"] = fc

    # Precompile trigger patterns
    for wf in templates.values():
        if wf.trigger_keywords:
            pattern_parts = [
                r"\b" + kw + r"\b" if not any(c in kw for c in r"\+*?[]()") else kw
                for kw in wf.trigger_keywords
            ]
            wf.trigger_pattern = re.compile(
                "|".join(pattern_parts), re.IGNORECASE
            )

    return templates


WORKFLOW_TEMPLATES: dict[str, WorkflowDef] = _build_templates()


# ── Keyword router ────────────────────────────────────────

def _route_by_keywords(user_input: str) -> Optional[str]:
    """Match user input against workflow trigger patterns.

    Returns workflow_id or None. Short queries (< min_query_words)
    skip routing entirely → direct chat.
    """
    word_count = len(user_input.split())

    for wf_id, wf in WORKFLOW_TEMPLATES.items():
        if word_count < wf.min_query_words:
            continue
        if wf.trigger_pattern and wf.trigger_pattern.search(user_input):
            log.info("Workflow routed: %r → %s", user_input[:60], wf_id)
            return wf_id

    return None


# ── Client serialization ─────────────────────────────────

def get_workflow_def_for_client(workflow_id: str) -> Optional[dict]:
    """Serialize a workflow definition for the frontend debugger."""
    wf = WORKFLOW_TEMPLATES.get(workflow_id)
    if not wf:
        return None
    return {
        "workflow_id": wf.id,
        "name": wf.name,
        "description": wf.description,
        "states": [
            {
                "id": s.id,
                "name": s.name,
                "type": s.step_type,
                "has_tool": bool(s.tool_name),
                "tool_name": s.tool_name,
                "prompt_template": s.prompt_template[:200] if s.prompt_template else "",
                "next_step": s.next_step,
                "narration": s.narration,
            }
            for s in wf.steps
        ],
    }


# ── WorkflowRunner ────────────────────────────────────────

class WorkflowRunner:
    """FSM-driven workflow engine wrapping Orchestrator.

    Same public API as Orchestrator: chat(), clear_history(), update_config().
    Routes complex queries through workflow templates; simple queries fall
    through to Orchestrator.chat().
    """

    def __init__(self, config: Optional[OrchestratorConfig] = None) -> None:
        self.orchestrator = Orchestrator(config=config)
        self.config = self.orchestrator.config

        # Workflow-specific callbacks
        self.on_workflow_start: Optional[WorkflowCallback] = None
        self.on_workflow_state: Optional[WorkflowCallback] = None
        self.on_workflow_exit: Optional[WorkflowCallback] = None
        self.on_narration: Optional[WorkflowCallback] = None
        self.on_activity: Optional[WorkflowCallback] = None
        self.on_debug: Optional[WorkflowCallback] = None

    # ── Public API (mirrors Orchestrator) ─────────────────

    async def chat(self, user_input: str) -> str:
        """Main entry point. Routes to workflow or falls through to orchestrator."""
        workflow_id = _route_by_keywords(user_input)

        if workflow_id:
            return await self._execute_workflow(workflow_id, user_input)
        else:
            return await self.orchestrator.chat(user_input)

    def clear_history(self) -> None:
        """Reset conversation history."""
        self.orchestrator.clear_history()

    def update_config(self, **kwargs) -> None:
        """Update config fields at runtime."""
        self.orchestrator.update_config(**kwargs)

    @property
    def messages(self) -> list[dict]:
        """Access orchestrator messages for compatibility."""
        return self.orchestrator.messages

    # ── Workflow execution ────────────────────────────────

    async def _execute_workflow(
        self, workflow_id: str, user_input: str
    ) -> str:
        """Execute a complete workflow FSM."""
        wf = WORKFLOW_TEMPLATES[workflow_id]
        ctx = WorkflowContext(workflow_id=workflow_id, user_query=user_input)

        log.info("Starting workflow: %s for query: %r", wf.name, user_input[:60])

        # Notify UI
        await self._notify_workflow_start(workflow_id, wf)

        try:
            for step_idx, step in enumerate(wf.steps):
                await self._notify_workflow_state(
                    step.id, "active",
                    step=step_idx + 1, total=len(wf.steps),
                    step_name=step.name,
                )

                await self._execute_step(step, ctx)

                await self._notify_workflow_state(step.id, "visited")

            # Final answer is from the last LLM step
            reply = ctx.final_answer or "I completed the research but couldn't form a response."

        except Exception as e:
            log.error("Workflow %s failed: %s", workflow_id, e, exc_info=True)
            reply = f"I ran into an issue during research: {e}"

        await self._notify_workflow_exit(workflow_id)

        # Append to orchestrator history (only the final user/assistant pair)
        self.orchestrator.messages.append({"role": "user", "content": user_input})
        self.orchestrator.messages.append({"role": "assistant", "content": reply})

        return reply

    async def _execute_step(
        self, step: WorkflowStep, ctx: WorkflowContext,
    ) -> None:
        """Execute a single workflow step based on its type."""

        # Send narration to UI before executing the step
        if step.narration:
            narration_text = _render_template(step.narration, ctx)
            await self._notify_narration(narration_text)

        if step.step_type == "llm":
            await self._execute_llm_step(step, ctx)

        elif step.step_type == "loop":
            await self._execute_loop_step(step, ctx)

        elif step.step_type == "direct":
            await self._execute_direct_step(step, ctx)

    async def _execute_llm_step(
        self, step: WorkflowStep, ctx: WorkflowContext,
    ) -> None:
        """Execute an LLM reasoning step with a focused prompt."""
        prompt = _render_template(step.prompt_template, ctx)
        system = "You are a research assistant. Follow instructions precisely."
        provider = self.config.provider
        model = self.config.model

        log.info("LLM step '%s': prompt=%d chars", step.id, len(prompt))

        model_label = model or "LLM"
        await self._notify_activity(f"Querying {model_label}...", LLM_TIMEOUT_SECS)

        # Disable thinking for workflow steps — they're focused prompts
        # (search query generation, JSON extraction, synthesis) where
        # Qwen3's extended reasoning wastes tokens and time.
        text = await llm_generate(
            system,
            [{"role": "user", "content": prompt}],
            provider, model,
            think=False,
        )

        # Send LLM diagnostics to UI
        if self.on_debug and llm_last_diagnostics:
            diag = dict(llm_last_diagnostics)
            diag["step"] = step.id
            diag["prompt_chars"] = len(prompt)
            await self.on_debug(diag)

        # Strip thinking tags (Qwen 3)
        text = Orchestrator._strip_thinking(text)

        # Store raw result
        ctx.step_results[step.id] = text

        # Parse structured output if needed
        parsed = _maybe_parse_json(text)

        # Handle specific step behaviors
        if step.id == "decompose":
            # Expect a JSON array of search queries
            if isinstance(parsed, list):
                ctx.search_queries = [str(q) for q in parsed]
            else:
                # Fallback: split by newlines, strip bullets
                lines = text.strip().split("\n")
                ctx.search_queries = [
                    re.sub(r"^[\d.\-*]+\s*", "", line).strip()
                    for line in lines if line.strip()
                ][:5]  # Cap at 5 queries
            log.info("Decomposed into %d queries: %s",
                     len(ctx.search_queries), ctx.search_queries)

        elif step.id == "evaluate_gaps":
            # Expect a JSON array of follow-up queries
            if isinstance(parsed, list):
                ctx.search_queries = [str(q) for q in parsed]
            else:
                lines = text.strip().split("\n")
                ctx.search_queries = [
                    re.sub(r"^[\d.\-*]+\s*", "", line).strip()
                    for line in lines if line.strip()
                ][:3]

        elif step.id == "extract_claim":
            # Expect JSON with claim, support_query, counter_query
            if isinstance(parsed, dict):
                ctx.step_results["extract_claim"] = parsed.get("claim", text)
                ctx.search_queries = [
                    parsed.get("support_query", ""),
                    parsed.get("counter_query", ""),
                ]
                ctx.search_queries = [q for q in ctx.search_queries if q]
            else:
                # Fallback: use the full text as claim, user query as search
                ctx.search_queries = [ctx.user_query]

        elif step.id in ("initial_search", "initial_lookup"):
            # This step generates a search query, then searches
            search_query = text.strip().strip('"').strip("'")
            log.info("Initial search query: %r", search_query)
            await self._notify_activity(f"Searching: {search_query[:60]}", SEARCH_TIMEOUT_SECS)
            if step.tool_name and self.config.dispatch:
                result = await self.config.dispatch(
                    step.tool_name, {"query": search_query}
                )
                ctx.step_results[step.id] = result
                log.info("Initial search results: %d chars", len(result or ""))
                log.debug("Initial search content:\n%s", (result or "")[:2000])
            else:
                ctx.step_results[step.id] = "(search not available)"

        elif step.id in ("synthesize", "verdict"):
            ctx.final_answer = text
            log.info("Final answer (%d chars): %s", len(text), text[:200])

    async def _execute_loop_step(
        self, step: WorkflowStep, ctx: WorkflowContext,
    ) -> None:
        """Execute a loop step — dispatch tool for each search query."""
        queries = ctx.search_queries
        if not queries:
            log.warning("Loop step '%s' has no queries to process", step.id)
            return

        # Notify UI with children
        await self._notify_loop_update(step.id, queries, -1)

        results = []
        for i, query in enumerate(queries):
            # Rate-limit delay between searches to avoid 429 Too Many Requests
            if i > 0:
                await asyncio.sleep(1.5)

            await self._notify_workflow_state(
                step.id, "active",
                detail=f"Searching {i + 1}/{len(queries)}: {query[:50]}",
            )
            await self._notify_loop_update(step.id, queries, i)
            await self._notify_activity(f"Searching {i+1}/{len(queries)}: {query[:50]}", SEARCH_TIMEOUT_SECS)

            if self.config.dispatch and step.tool_name:
                try:
                    result = await self.config.dispatch(
                        step.tool_name, {"query": query}
                    )
                    results.append(f"[Query: {query}]\n{result}")
                except Exception as e:
                    log.warning("Loop search failed for %r: %s", query, e)
                    results.append(f"[Query: {query}]\nSearch failed: {e}")
            else:
                results.append(f"[Query: {query}]\n(search not available)")

        ctx.search_results = results

    async def _execute_direct_step(
        self, step: WorkflowStep, ctx: WorkflowContext,
    ) -> None:
        """Execute a direct tool dispatch step (no LLM involved)."""
        if not self.config.dispatch or not step.tool_name:
            ctx.step_results[step.id] = "(tool not available)"
            return

        # For fact_check: use the appropriate query from search_queries
        query = ""
        if step.id == "search_evidence" and ctx.search_queries:
            query = ctx.search_queries[0]
        elif step.id == "search_counter" and len(ctx.search_queries) > 1:
            query = ctx.search_queries[1]
        else:
            query = ctx.user_query

        await self._notify_activity(f"Executing {step.tool_name}...", SEARCH_TIMEOUT_SECS)

        try:
            result = await self.config.dispatch(
                step.tool_name, {"query": query}
            )
            ctx.step_results[step.id] = result
        except Exception as e:
            log.warning("Direct step '%s' failed: %s", step.id, e)
            ctx.step_results[step.id] = f"Search failed: {e}"

    # ── Workflow callbacks ────────────────────────────────

    async def _notify_workflow_start(
        self, workflow_id: str, wf: WorkflowDef,
    ) -> None:
        if self.on_workflow_start:
            try:
                await self.on_workflow_start(workflow_id, wf)
            except Exception as e:
                log.warning("on_workflow_start callback error: %s", e)

    async def _notify_workflow_state(
        self, state_id: str, status: str, **kwargs,
    ) -> None:
        if self.on_workflow_state:
            try:
                await self.on_workflow_state(state_id, status, **kwargs)
            except Exception as e:
                log.warning("on_workflow_state callback error: %s", e)

    async def _notify_loop_update(
        self, state_id: str, children: list[str], active_index: int,
    ) -> None:
        if self.on_workflow_state:
            try:
                await self.on_workflow_state(
                    state_id, "loop_update",
                    children=children,
                    active_index=active_index,
                )
            except Exception as e:
                log.warning("on_workflow_state loop_update error: %s", e)

    async def _notify_activity(self, activity: str, timeout_secs: float = 0) -> None:
        if self.on_activity:
            try:
                await self.on_activity(activity, timeout_secs)
            except Exception as e:
                log.warning("on_activity callback error: %s", e)

    async def _notify_narration(self, text: str) -> None:
        if self.on_narration:
            try:
                await self.on_narration(text)
            except Exception as e:
                log.warning("on_narration callback error: %s", e)

    async def _notify_workflow_exit(self, workflow_id: str) -> None:
        if self.on_workflow_exit:
            try:
                await self.on_workflow_exit(workflow_id)
            except Exception as e:
                log.warning("on_workflow_exit callback error: %s", e)

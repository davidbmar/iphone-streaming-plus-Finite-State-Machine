# S-2026-02-16-1946-workflow-v2-debugger-narration

## Title
Workflow v2 — Better Decompose, Agent Narration, Upgraded Visual Debugger

## Goal
Fix three problems: (1) research_compare used stale LLM knowledge for decomposition, (2) visual debugger needed upgrade to speaker-workflow-system style, (3) agent should narrate steps as chat bubbles.

## Context
- Continues from S-2026-02-16-1802-hybrid-fsm-workflow (v1 workflow system)
- Plan file: `~/.claude/plans/glittery-humming-valiant.md`

## Changes Made

### engine/workflow.py
- Added `narration` field to `WorkflowStep` dataclass
- Added `initial_lookup` step to `research_compare` template (4 steps instead of 3)
  - Searches web FIRST so decompose step has real data instead of stale training knowledge
- Added narration strings to all 3 templates (research_compare, deep_research, fact_check)
- Added `on_narration` callback to WorkflowRunner
- Added `_notify_narration()` method called at start of each step
- Exposed `narration` and `tool_name` in `get_workflow_def_for_client()`

### engine/llm.py
- Changed default Ollama model from `qwen2.5:14b` to `qwen3:8b`

### gateway/server.py
- Wired `on_narration` callback → sends `workflow_narration` WS message
- Updated default model selection: explicitly prefers `qwen3:8b` if installed

### web/workflow-map.js (REWRITE)
- Speaker-workflow-system style: uppercase node IDs, hint text, type badges
- Arrow elements with `▼` heads instead of v1 connectors
- Loop children with branch arms and indicators

### web/workflow-code.js (REWRITE)
- Four-color syntax highlighting: purple keywords, green strings, orange intents, blue state refs
- `say:` lines showing narration text, `tool:` lines showing tool names
- Active state gets teal left-border

### web/styles.css
- Replaced all workflow CSS with teal palette (#00e5cc), dark terminal panels
- Rounded-rect 6px nodes, max-width 200px, code font stack
- Narration bubble styles (.msg-narration)

### web/app.js
- Replaced `showStepProgress()` with `showNarrationBubble()`
- Added `workflow_narration` case in handleMessage
- Narration cleanup on agent_reply

### web/index.html
- Bumped cache versions: styles v27, workflow-map v2, workflow-code v2, app v27

### tests/test_suite.py
- Updated for 4-step research_compare, narration field, client serialization
- 97 passed, 0 failed

### tests/test_ui_workflow_v2.py (NEW)
- Playwright headless Chromium test suite for v2 UI
- Tests: page load, cache busting, JS modules, debug panels, WS connect + default model, debug toggle, workflow map v2 nodes, code view syntax highlighting, state highlighting, loop children, narration bubble, CSS teal theme variables

## Decisions
- Narration is visual-only (chat bubble), no TTS — avoids double-speaking with tool_call callback
- `initial_lookup` step uses LLM to generate a search query, then web_search tool, before decomposition
- Desktop-only debug panels; mobile shows narration text without panels

## Issues Found
- **CRITICAL**: Session started editing files in `iphone-webrtc-TURN-speaker-streaming-machost-iphonebrowser` but server was running from `iphone-streaming-plus-Finite-State-Machine`. All 10 files copied to correct directory at end of session.
- Server caches `index.html` at startup via `build_index_html()` → must restart after HTML changes

## Pending / Next Steps
- Restart server and verify v2 UI renders correctly
- Run `python3 tests/test_ui_workflow_v2.py` against fresh server
- Run `python3 tests/test_suite.py --quick` in correct directory
- Test actual workflow execution: "compare top S&P 500 companies by market cap"

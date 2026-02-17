# Session

Session-ID: S-2026-02-16-1802-hybrid-fsm-workflow
Title: Hybrid FSM + LLM Workflow System with Visual Debugger
Date: 2026-02-16
Author: Claude

## Goal
Implement a hybrid FSM + LLM workflow system where FSMs drive multi-step research and the LLM reasons at each step. Add a three-panel visual debugger (workflow map, code view, voice panel) so you can watch state-by-state execution.

## Context
Small models (Qwen 3 8B) only do 1 search and stop in the existing 5-iteration tool-calling loop. They don't decompose complex queries into multi-step research. A deterministic FSM driving the steps + LLM reasoning at each step solves this.

## Plan
1. Create engine/workflow.py — WorkflowRunner wraps Orchestrator (composition)
2. Add workflow unit tests
3. Create web/workflow-map.js — DOM graph renderer
4. Create web/workflow-code.js — pseudocode view
5. Update web/styles.css — three-panel CSS grid
6. Update web/index.html — debug panels structure
7. Update web/app.js — handle workflow WS messages
8. Update gateway/server.py — WorkflowRunner + rich WS callbacks
9. Update voice_assistant/main.py — WorkflowRunner integration

## Changes Made
(updated after work)

## Decisions Made
- WorkflowRunner wraps Orchestrator (composition, not replacement)
- Keyword routing is regex-first (sub-millisecond, no LLM call)
- loop_search bypasses LLM — dispatches tools directly
- Rich WS messages for visual debugger (workflow_start/state/exit)
- Three-column CSS grid on desktop, mobile toggle for debug panels

## Open Questions
(none yet)

## Links

Commits:
- (pending)

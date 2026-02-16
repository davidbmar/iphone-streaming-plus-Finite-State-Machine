# F-005: Move Tool Registry to engine/tools/

**Type:** Feature (refactor)
**Priority:** Low — do when adding a second real tool
**Status:** Not started
**Blocked by:** F-003 or F-004 (do this when a real tool lands)

## Summary

Move `voice_assistant/tools/` to `engine/tools/` so the tool registry lives
in the shared engine layer. Currently `gateway/server.py` imports from
`voice_assistant/tools/`, which creates a backwards dependency
(gateway → voice_assistant). This works but the dependency direction is
arguably wrong.

## Current State

```
gateway/server.py  ──imports──►  voice_assistant/tools/get_all_schemas()
                                 voice_assistant/tool_router/dispatch_tool_call()

voice_assistant/main.py  ──imports──►  voice_assistant/tools/ (natural)
```

## Target State

```
gateway/server.py  ──imports──►  engine/tools/get_all_schemas()
                                 engine/tools/dispatch_tool_call()

voice_assistant/main.py  ──imports──►  engine/tools/ (also natural)
voice_assistant/tools/  →  backwards-compat shim or deleted
```

## Why Wait

- Only one real tool exists (web_search). The mock tools (calendar, notes)
  don't justify a file move yet.
- When F-003 or F-004 lands with real API integrations, the tools become
  core infrastructure worth moving to engine/.
- Moving now is churn without benefit.

## What to Do When Ready

1. `mv voice_assistant/tools/ engine/tools/`
2. `mv voice_assistant/tool_router.py engine/tool_router.py`
3. Update imports in: `gateway/server.py`, `voice_assistant/main.py`,
   `engine/orchestrator.py`, `tests/test_suite.py`
4. Leave a shim at `voice_assistant/tools/__init__.py` if external code
   imports from the old location
5. Move `voice_assistant/tools/base.py` → `engine/tools/base.py`

# F-004: Real Notes Search

**Type:** Feature
**Priority:** Medium
**Status:** Not started
**Replaces:** Mock in `voice_assistant/tools/notes.py`

## Summary

Replace the hardcoded fake notes with a real notes search backend. The mock
currently returns 3 hardcoded notes (shopping list, pasta recipe, project ideas)
matched by simple keyword lookup. A real implementation would search actual
user notes.

## Current State (Mock)

`voice_assistant/tools/notes.py` searches a dict of 3 fake entries with
simple keyword matching. Output is labeled `[MOCK DATA]`.

## Implementation Options

| Approach | Pros | Cons |
|----------|------|------|
| **RAG over local markdown files** | Offline, works with Obsidian/plain files, no API | Needs embedding model, vector store setup |
| **Apple Notes (via AppleScript/JXA)** | Native macOS, no API keys | Mac-only, AppleScript is fragile, limited search |
| **Obsidian vault + full-text search** | Simple grep-based, no ML needed | Only works with Obsidian, needs vault path config |
| **SQLite FTS5 over indexed files** | Fast, offline, cross-platform | Needs indexing step, schema design |

## Recommended: RAG over Local Files

1. User configures a `NOTES_DIR` path (e.g., `~/Documents/Notes` or Obsidian vault)
2. On startup, index all `.md`/`.txt` files using a small embedding model
3. `search_notes(query)` does semantic search over the index
4. Return top-k matching note excerpts with file paths

## What to Implement

1. Replace `execute()` in `voice_assistant/tools/notes.py`
2. Add config: `NOTES_DIR`, optional `NOTES_EMBEDDING_MODEL`
3. Index building (could be lazy on first search, or on startup)
4. Keep the `BaseTool` interface

## Acceptance Criteria

- "Find my shopping list" returns actual notes matching "shopping"
- "What did I write about X?" returns relevant note excerpts
- Works in both web UI and CLI REPL
- Graceful fallback if notes dir not configured

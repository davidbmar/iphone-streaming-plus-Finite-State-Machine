# CLAUDE.md — WebRTC Speaker Streaming

## Project Overview

Mac-hosted Python server streams TTS audio to iPhone Safari via WebRTC.
Stack: Python (aiohttp, aiortc, Piper TTS) → Opus → Safari WebRTC.

## Quick Start

```bash
pip install -r requirements.txt
cp .env.example .env          # Add TWILIO_* creds if needed
python -m gateway.server      # http://localhost:8080
```

## Architecture

```
engine/orchestrator.py → Unified chat loop (tools, hedging, callbacks)
engine/llm.py          → Multi-provider LLM wrapper (Claude/OpenAI/Ollama)
engine/tts.py          → Piper TTS (text → 48kHz PCM)
gateway/audio/         → PCMRingBuffer + WebRTCAudioSource
gateway/webrtc.py      → aiortc PeerConnection lifecycle
gateway/server.py      → aiohttp WS signaling + static files
gateway/turn.py        → Twilio TURN credentials
web/                   → Browser client (vanilla JS)
```

## Key Constraints

- Audio must be 48kHz mono int16 PCM (Opus codec requirement)
- TTS runs in thread pool (CPU-bound ONNX inference)
- Ring buffer bridges threaded TTS → async WebRTC consumer
- Safari requires user gesture before audio playback
- TURN relay needed for cellular/NAT traversal

## Testing

```bash
python3 scripts/smoke_test.py      # Headless TTS pipeline test
bash scripts/test_local.sh         # Local browser test
bash scripts/test_lan.sh           # iPhone on Wi-Fi
bash scripts/test_cellular.sh      # iPhone on AT&T (cloudflared)
```

---

## Project Memory System

Every coding session and decision must be traceable and searchable.
Requires: bash only (no jq needed).

### Rule 1: Session ID Format

```
S-YYYY-MM-DD-HHMM-<slug>
```
- HHMM is **UTC** (use `date -u +%Y-%m-%d-%H%M`)
- Example: `S-2026-02-14-1430-tts-webrtc-pipeline`

### Rule 2: Commit Message Format

```
Human-readable subject line

Session: S-YYYY-MM-DD-HHMM-slug
```

### Rule 3: Session Documentation

1. Copy `docs/project-memory/sessions/_template.md`
2. Name with Session ID: `S-2026-02-14-1430-my-feature.md`
3. Fill: Title, Goal, Context, Plan
4. Update after work: Changes Made, Decisions, Links

### Rule 4: When to Create an ADR

- Choosing between technical approaches
- Establishing patterns for the codebase
- Decisions with long-term consequences

### Rule 5: Backlog (Bugs & Features)

Track work items in `docs/project-memory/backlog/`:
- **Bugs** use `B-NNN` prefix (e.g., `B-001-audio-dropout.md`)
- **Features** use `F-NNN` prefix (e.g., `F-003-real-calendar-integration.md`)
- Each item gets its own markdown file with Summary, Status, Priority
- Update `docs/project-memory/backlog/README.md` table when adding/changing items
- Link backlog items from code comments when relevant (e.g., `# MOCK: see F-003`)

### Rule 6: Searching Project Memory

```bash
git log --all --grep="S-YYYY-MM-DD"              # Commits by session
grep -r "keyword" docs/project-memory/sessions/   # Sessions by keyword
grep -r "topic" docs/project-memory/adr/           # ADRs by topic
grep -r "keyword" docs/project-memory/backlog/     # Backlog by keyword
```

### Rule 7: Workflow

1. Start work → Generate Session ID (UTC timestamp)
2. Create session doc from template
3. Make changes → commit with Session ID in body
4. Update session doc with outcomes
5. Create ADR if needed
6. Pre-commit hook auto-rebuilds search index

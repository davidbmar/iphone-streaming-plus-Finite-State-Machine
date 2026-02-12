#!/usr/bin/env bash
#
# build-index.sh — Generate search indices from session .md files.
# Produces: .index/metadata.json, keywords.json, sessions.txt, last-updated.txt
# Compatible with bash 3 (macOS default).
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESSIONS_DIR="$REPO_ROOT/docs/project-memory/sessions"
INDEX_DIR="$REPO_ROOT/docs/project-memory/.index"
TMPFILE=$(mktemp)
trap 'rm -f "$TMPFILE"' EXIT

mkdir -p "$INDEX_DIR"

# ── metadata.json: per-session structured data ──────────────────────
echo "[" > "$INDEX_DIR/metadata.json"
first=true
for f in "$SESSIONS_DIR"/S-*.md; do
  [ -f "$f" ] || continue

  session_id=$(grep -m1 '^Session-ID:' "$f" | sed 's/^Session-ID:[[:space:]]*//' || echo "")
  title=$(grep -m1 '^Title:' "$f" | sed 's/^Title:[[:space:]]*//' || echo "")
  date=$(grep -m1 '^Date:' "$f" | sed 's/^Date:[[:space:]]*//' || echo "")

  [ -z "$session_id" ] && continue

  if [ "$first" = true ]; then
    first=false
  else
    echo "," >> "$INDEX_DIR/metadata.json"
  fi

  # Escape quotes for JSON safety
  safe_title=$(echo "$title" | sed 's/"/\\"/g')

  cat >> "$INDEX_DIR/metadata.json" <<ENTRY
  {
    "sessionId": "$session_id",
    "title": "$safe_title",
    "date": "$date",
    "file": "$(basename "$f")"
  }
ENTRY
done
echo "]" >> "$INDEX_DIR/metadata.json"

# ── keywords.json: inverted keyword → session index ─────────────────
# Build keyword→session pairs into a temp file, then aggregate with awk.
> "$TMPFILE"
for f in "$SESSIONS_DIR"/S-*.md; do
  [ -f "$f" ] || continue
  session_id=$(grep -m1 '^Session-ID:' "$f" | sed 's/^Session-ID:[[:space:]]*//' || echo "")
  [ -z "$session_id" ] && continue

  # Extract keywords: headings, bold text, and key terms
  grep -E '(^##|^\*\*|\bRAG\b|\bFSM\b|\bTTS\b|\bSTT\b|\bLLM\b|\bbias\b|\bpipeline\b|\bprompt\b)' "$f" \
    | sed 's/[#*_`]//g' \
    | tr '[:upper:]' '[:lower:]' \
    | tr -cs '[:alnum:]-' '\n' \
    | sort -u \
    | grep -E '.{3,}' \
    | while read -r kw; do
        echo "$kw $session_id"
      done >> "$TMPFILE" || true
done

# Aggregate: group session IDs per keyword
sort "$TMPFILE" | awk '
BEGIN { print "{"; first=1 }
{
  kw=$1; sid=$2
  if (kw != prev_kw && prev_kw != "") {
    if (!first) printf ",\n"
    first=0
    printf "  \"%s\": [%s]", prev_kw, sids
    sids=""
  }
  if (sids != "") sids = sids ", "
  sids = sids "\"" sid "\""
  prev_kw = kw
}
END {
  if (prev_kw != "") {
    if (!first) printf ",\n"
    printf "  \"%s\": [%s]\n", prev_kw, sids
  }
  print "}"
}
' > "$INDEX_DIR/keywords.json"

# ── sessions.txt: plaintext for grep ────────────────────────────────
> "$INDEX_DIR/sessions.txt"
for f in "$SESSIONS_DIR"/S-*.md; do
  [ -f "$f" ] || continue
  session_id=$(grep -m1 '^Session-ID:' "$f" | sed 's/^Session-ID:[[:space:]]*//' || echo "")
  title=$(grep -m1 '^Title:' "$f" | sed 's/^Title:[[:space:]]*//' || echo "")
  date=$(grep -m1 '^Date:' "$f" | sed 's/^Date:[[:space:]]*//' || echo "")
  echo "$session_id | $date | $title" >> "$INDEX_DIR/sessions.txt"
done

# ── last-updated.txt ────────────────────────────────────────────────
date -u '+%Y-%m-%dT%H:%M:%SZ' > "$INDEX_DIR/last-updated.txt"

echo "Index rebuilt: $(wc -l < "$INDEX_DIR/sessions.txt" | tr -d ' ') sessions indexed"

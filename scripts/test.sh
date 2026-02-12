#!/usr/bin/env bash
#
# test.sh — Verify session tracing framework works.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== Testing build-index.sh ==="
bash "$REPO_ROOT/scripts/build-index.sh"

echo ""
echo "=== Checking outputs ==="
for f in metadata.json keywords.json sessions.txt last-updated.txt; do
  path="$REPO_ROOT/docs/project-memory/.index/$f"
  if [ -f "$path" ]; then
    echo "OK: $f ($(wc -c < "$path") bytes)"
  else
    echo "FAIL: $f missing"
    exit 1
  fi
done

echo ""
echo "=== sessions.txt ==="
cat "$REPO_ROOT/docs/project-memory/.index/sessions.txt"

echo ""
echo "All tests passed."

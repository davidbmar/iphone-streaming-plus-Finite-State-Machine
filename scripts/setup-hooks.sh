#!/usr/bin/env bash
#
# setup-hooks.sh — Install git pre-commit hook that auto-rebuilds session index.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK_PATH="$REPO_ROOT/.git/hooks/pre-commit"

# Don't overwrite an existing hook — append instead
if [ -f "$HOOK_PATH" ]; then
  # Check if our hook is already installed
  if grep -q 'build-index.sh' "$HOOK_PATH"; then
    echo "Hook already installed."
    exit 0
  fi

  echo "" >> "$HOOK_PATH"
  echo "# ── Session index auto-rebuild ──" >> "$HOOK_PATH"
  echo 'bash "$(git rev-parse --show-toplevel)/scripts/build-index.sh" 2>/dev/null || true' >> "$HOOK_PATH"
  echo 'git add docs/project-memory/.index/ 2>/dev/null || true' >> "$HOOK_PATH"
  echo "Appended session index hook to existing pre-commit."
else
  cat > "$HOOK_PATH" <<'HOOK'
#!/usr/bin/env bash
# Auto-rebuild session index on commit
bash "$(git rev-parse --show-toplevel)/scripts/build-index.sh" 2>/dev/null || true
git add docs/project-memory/.index/ 2>/dev/null || true
HOOK
  chmod +x "$HOOK_PATH"
  echo "Installed pre-commit hook."
fi

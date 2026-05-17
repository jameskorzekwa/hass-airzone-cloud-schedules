#!/usr/bin/env bash
# PostToolUse hook: deterministically verify Python/card edits in this repo.
# Reads the Claude Code hook JSON on stdin, extracts the edited file path, and:
#   - Python under custom_components/ or tests/  -> py_compile + ruff
#   - airzone-schedules-card.js                  -> node --check + both copies in sync
# Exit 2 surfaces stderr back to the model as actionable feedback.
set -u

ROOT="$(cd "$(dirname "$0")/../.." 2>/dev/null && pwd)"
[ -z "$ROOT" ] && exit 0

f="$(python3 -c 'import sys,json
try:
    d=json.load(sys.stdin)
except Exception:
    print(""); sys.exit(0)
ti=d.get("tool_input",{}) or {}
print(ti.get("file_path") or ti.get("path") or "")' 2>/dev/null)"
[ -z "$f" ] && exit 0
[ -f "$f" ] || exit 0

case "$f" in
  */custom_components/*.py|*/tests/*.py)
    if ! out="$(python3 -m py_compile "$f" 2>&1)"; then
      printf 'py_compile failed for %s:\n%s\n' "$f" "$out" >&2
      exit 2
    fi
    if ! out="$(cd "$ROOT" && python3 -m ruff check "$f" 2>&1)"; then
      printf 'ruff reported issues in %s:\n%s\n' "$f" "$out" >&2
      exit 2
    fi
    ;;
  *airzone-schedules-card.js)
    if ! out="$(node --check "$f" 2>&1)"; then
      printf 'node --check failed for %s:\n%s\n' "$f" "$out" >&2
      exit 2
    fi
    a="$ROOT/airzone-schedules-card.js"
    b="$ROOT/custom_components/airzone_cloud/airzone-schedules-card.js"
    if [ -f "$a" ] && [ -f "$b" ] && ! diff -q "$a" "$b" >/dev/null 2>&1; then
      printf 'Card copies OUT OF SYNC. Make these byte-identical:\n  %s\n  %s\n' "$a" "$b" >&2
      exit 2
    fi
    ;;
esac
exit 0

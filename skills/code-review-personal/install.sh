#!/bin/bash
# Link this skill into ~/.agents/skills, where pi (and other Agent Skills hosts) find it.
# Claude Code is covered by bin/sync-skills.sh, which links into ~/.claude/skills.
# Usage: ./install.sh

set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_NAME="$(basename "$SKILL_DIR")"
TARGET_DIR="$HOME/.agents/skills"
TARGET="$TARGET_DIR/$SKILL_NAME"

mkdir -p "$TARGET_DIR"

if [ -L "$TARGET" ] && [ "$(readlink "$TARGET")" = "$SKILL_DIR" ]; then
  echo "✓ $SKILL_NAME (already linked in $TARGET_DIR)"
elif [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
  echo "✗ $TARGET already exists and points elsewhere; remove it first." >&2
  exit 1
else
  ln -s "$SKILL_DIR" "$TARGET"
  echo "✅ $SKILL_NAME (linked in $TARGET_DIR)"
fi

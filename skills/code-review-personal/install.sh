#!/bin/bash
# Link this skill into ~/.agents/skills, where pi (and other Agent Skills hosts) find it.
# Claude Code is covered by bin/sync-skills.sh, which links into ~/.claude/skills.
# Usage: ./install.sh

set -euo pipefail

# -P: the physical path, so running this through the ~/.agents/skills symlink still
# matches the link target recorded by the first install. Earlier versions recorded
# the logical path, which differs if the checkout path contains a symlink.
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SKILL_DIR_LOGICAL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_NAME="$(basename "$SKILL_DIR")"
TARGET_DIR="$HOME/.agents/skills"
TARGET="$TARGET_DIR/$SKILL_NAME"

mkdir -p "$TARGET_DIR"

if [ -L "$TARGET" ] && { [ "$(readlink "$TARGET")" = "$SKILL_DIR" ] || [ "$(readlink "$TARGET")" = "$SKILL_DIR_LOGICAL" ]; }; then
  echo "✓ $SKILL_NAME (already linked in $TARGET_DIR)"
elif [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
  echo "✗ $TARGET already exists and points elsewhere; remove it first." >&2
  exit 1
else
  ln -s "$SKILL_DIR" "$TARGET"
  echo "✅ $SKILL_NAME (linked in $TARGET_DIR)"
fi

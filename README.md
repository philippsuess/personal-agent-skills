# Personal Agent Skills

A collection of reusable Claude Code CLI skills for automating recurring engineering workflows.

## Overview

This repository contains independent skills that can be invoked via the Claude Code CLI. Each skill automates a specific workflow and follows a consistent structure.

## Structure

```
personal-agent-skills/
├── README.md
├── bin/
│   └── sync-skills.sh          # Sync skills to Claude Code
└── skills/
    └── <skill-name>/
        ├── SKILL.md            # Native Claude Code skill: YAML frontmatter + instructions
        ├── skill.json          # Optional extra metadata (not read by Claude Code)
        └── README.md           # Human-readable documentation
```

Each skill uses the native `SKILL.md` format, so once synced it is available as
`/<skill-name>` in **any** directory (skills live in your user-level
`~/.claude/skills/`), not just inside this repo.

## Available Skills

- **daily-pr-review-sentry-cocoa-sdk**: Overview of easy-to-approve PRs for the Sentry Cocoa SDK
- **stacked-pr-merge-main**: Safely merge main into feature branch created from another merged branch, preferring current branch on conflicts
- **multi-clone**: Clone a GitHub repository multiple times into numbered folders for parallel agent work
- **flaky-ci-watcher**: Watch your open PRs (all by default, or one by number in the current repo), auto re-run flaky CI failures, and alert in the terminal when a failure looks real or stays flaky

## Setup

Sync all skills to Claude Code (one-time setup):

```bash
./bin/sync-skills.sh
```

This creates symlinks in `~/.claude/skills/` for all skills in this repo. Run it again when you add new skills.

## Usage

See **[USAGE.md](USAGE.md)** for detailed instructions.

**Quick Start:**

```bash
# Start Claude Code
claude

# Use a skill directly (after running sync-skills.sh)
> /stacked-pr-merge-main
> /daily-pr-review-sentry-cocoa-sdk
```

**Alternative:** Execute by file path or copy-paste the `SKILL.md` content.

Refer to individual skill READMEs for specific usage instructions.

## Design Principles

- **Read-only by default**: Skills should be informational unless explicitly designed for modification
- **Safety first**: No destructive operations without clear confirmation
- **Clarity over cleverness**: Simple, understandable logic
- **Reusable**: Skills should work across different contexts where applicable

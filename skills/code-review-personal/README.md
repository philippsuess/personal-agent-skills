# code-review-personal

Multi-model review loop for a pull request, focused on correctness bugs.

Several models (via the `pi` CLI) review the same PR diff in parallel. The agent you invoke the skill from (pi, Claude Code, Codex) acts as the review master: it merges duplicate findings, triages them by LOGAF level (L = nitpick, M = worth doing, H = must fix), fixes what is safe, asks you about the rest, and commits one fix commit per round. It repeats for up to 5 rounds, then shows a summary, deletes its temp files and pushes. It only asks first if the PR isn't yours.

Round 1 reviews the whole PR diff. Later rounds are verify rounds: the models only check the previous round's fix commit, confirming each fixed issue is really fixed and that the fixes didn't add new problems. That keeps later rounds fast, at the cost of not re-finding issues round 1 missed.

## Usage

```
/code-review-personal 123 [--brief notes.md] [--models a,b,c]          # Claude Code
/skill:code-review-personal 123 [--brief notes.md] [--models a,b,c]    # pi
```

- **H** findings are always asked about. **L** findings are never asked about.
- Fixes are verified with the build, test and lint commands from the repo's `AGENTS.md`, compared against a baseline taken before any change.
- Diffs over 200 KB (lockfiles not counted) are refused.
- The investigators only get read-only tools (`read`, `grep`, `find`, `ls`), but pi doesn't sandbox `read`: a model can read files outside the repository. The prompt tells them not to; nothing enforces it.

## Requirements

- `pi` with an OpenRouter key. Default models: `openrouter/z-ai/glm-5.3-flash`, `openrouter/openai/gpt-6-luna:medium` (`:medium` is pi's thinking-level suffix), `openrouter/anthropic/claude-haiku-5.5`.
- `gh` (logged in), `git`, Node ≥ 20.

## Temp files

Everything the review writes lives in `temp-pr-review/` in the repository root. The skill adds `temp-pr-review/` to the clone's local `.git/info/exclude` (no tracked file changes), never stages it, and deletes it at the end. Only one review can run per checkout at a time.

## Install

- Claude Code: `./bin/sync-skills.sh` from the repo root.
- pi: `./skills/code-review-personal/install.sh` (links into `~/.agents/skills`).

## Files

- `SKILL.md`: the review loop and its rules, followed by the host agent.
- `investigator.md`: the prompt each investigator model gets in round 1 (full review).
- `investigator-verify.md`: the prompt for later rounds (verify the previous round's fixes).
- `investigate.mjs`: runs the models in parallel in the background (`run`, `wait`, `stop`).
- `test/`: tests with a stubbed `pi`. Run `node --test` in this folder.

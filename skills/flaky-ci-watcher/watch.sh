#!/usr/bin/env bash
#
# flaky-ci-watcher background watcher (one-shot wake model).
#
# Cheap poller for the flaky-ci-watcher skill. Every POLL_INTERVAL seconds it
# checks the PRs in scope. As soon as it sees something ACTIONABLE it prints a
# single loop sentinel line and EXITS — so the agent harness, which re-invokes
# the agent when a tracked background task exits, wakes the skill to do real
# work. While checks are merely pending it stays silent and keeps polling, so a
# tight 10s cadence costs almost nothing.
#
# Scope:
#   * DEFAULT (no --repo/--pr) — all your open PRs across all repos, drafts
#     included: `gh search prs --author=@me --state=open`.
#   * TARGETED (--repo <owner/repo> --pr <num>) — just that one PR. The skill
#     resolves the repo from the cwd and verifies you authored the PR before
#     arming the watcher this way.
#
# Actionable = any watched PR has a failing check (-> classify/re-run), OR every
# watched PR has fully settled with no pending checks (-> final pass).
#
# Run it via the harness's BACKGROUND mode (run_in_background), NOT nohup/&/
# disown — a detached process is invisible to the harness and can never wake the
# agent. On exit, handle one pass, then re-arm a fresh watcher.
#
# Usage:   bash watch.sh [poll_interval_seconds] [--repo <owner/repo> --pr <num>]
# Env:     POLL_INTERVAL  seconds between polls (default 10; positional arg overrides)
# Output:  one line `AGENT_LOOP_WAKE_flakyci {"prompt": "..."}` then exit 0.

set -uo pipefail

# Capture any env-provided interval before we parse positional args.
POLL_INTERVAL_ENV="${POLL_INTERVAL:-}"
POLL_INTERVAL_ARG=""
TARGET_REPO=""
TARGET_PR=""

# Parse args: a bare number is the poll interval; --repo/--pr set targeted mode.
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) TARGET_REPO="${2:-}"; shift 2 ;;
    --pr)   TARGET_PR="${2:-}"; shift 2 ;;
    *)      POLL_INTERVAL_ARG="$1"; shift ;;
  esac
done

# Precedence: positional arg > env var > default 10.
POLL_INTERVAL="${POLL_INTERVAL_ARG:-${POLL_INTERVAL_ENV:-10}}"
SENTINEL="AGENT_LOOP_WAKE_flakyci"

# The prompt echoed on wake tells the agent which mode to resume in.
if [ -n "$TARGET_REPO" ] && [ -n "$TARGET_PR" ]; then
  WAKE_PROMPT="/flaky-ci-watcher $TARGET_PR"
else
  WAKE_PROMPT="/flaky-ci-watcher"
fi

while true; do
  # Sleep first so a just-triggered re-run has time to flip to "pending"
  # before we poll — otherwise a fresh arming could re-fire on a stale failure.
  sleep "$POLL_INTERVAL"

  if [ -n "$TARGET_REPO" ] && [ -n "$TARGET_PR" ]; then
    prs="$TARGET_REPO $TARGET_PR"
  else
    prs=$(gh search prs --author=@me --state=open \
          --json number,repository --limit 50 \
          --jq '.[] | "\(.repository.nameWithOwner) \(.number)"' 2>/dev/null || true)
  fi

  fails=0
  pending=0
  any=0
  while read -r repo num; do
    [ -z "$repo" ] && continue
    any=1
    checks=$(gh pr checks "$num" --repo "$repo" --json bucket,state 2>/dev/null) || continue
    echo "$checks" | jq -e '.[] | select(.bucket=="pending")' >/dev/null 2>&1 && pending=1
    echo "$checks" | jq -e '.[] | select(.bucket=="fail" or .state=="failure" or .state=="error")' >/dev/null 2>&1 && fails=1
  done <<< "$prs"

  if [ "$fails" -eq 1 ]; then
    echo "$SENTINEL {\"prompt\": \"$WAKE_PROMPT\"}"                  # a check failed -> wake to classify/re-run
    exit 0
  elif [ "$any" -eq 1 ] && [ "$pending" -eq 0 ]; then
    echo "$SENTINEL {\"prompt\": \"$WAKE_PROMPT (final pass - all CI settled)\"}"
    exit 0                                                          # everything green/done -> final pass
  fi
  # else: still pending, or no open PRs yet -> keep polling silently.
done

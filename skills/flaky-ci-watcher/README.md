# Flaky CI Watcher

Monitors your **own open PRs** whose CI is still running. Automatically re-runs
failures that look **flaky**, and **stops and alerts you in the terminal** when a
failure looks **real** (caused by your changes) or when a flaky-looking job keeps
failing after the re-run cap.

This skill only watches and re-runs. It never approves, merges, comments, or
pushes code.

## Two modes

- **Default (`/flaky-ci-watcher`)** — watches **all** your open PRs across
  **every** repo, **drafts included**.
- **Targeted (`/flaky-ci-watcher <pr-number>`)** — watches a **single** PR by
  number in the repo of your **current directory**. Only your own PRs are
  accepted; it refuses a PR you didn't author.

## What it does, per pass

1. Builds the candidate set: **default** → all your open PRs across all repos
   (`gh search prs --author=@me --state=open`); **targeted** → the one PR number
   you passed, in the current repo, after checking you authored it.
2. Keeps the ones with **pending/in-progress** or **failing** checks.
3. For each failed check, pulls the failed log and classifies it:
   - **Real** (compile/lint/test error in a file you changed, or the same step
     fails deterministically across re-runs) → stops, alerts you.
   - **Flaky** (timeouts, network/infra errors, runner crashes, failures in tests
     unrelated to your changes) → re-runs the failed jobs.
4. Re-runs flaky failures up to **2 times** per workflow. After that it stops and
   pings you that it's persistently flaky.
5. Prints a compact pass summary.

State (re-run counts, what's already been reported) is kept in
`${FLAKY_CI_WATCHER_HOME:-$HOME/.claude/flaky-ci-watcher}/state.json` so re-runs
are capped and you aren't alerted twice. Pushing a new commit to a PR resets its
counters.

## Requirements

- [`gh`](https://cli.github.com/) authenticated (`gh auth login`) with access to
  your repos and permission to re-run Actions jobs.
- `jq`.

## Usage

It's a monitor, so run it on a loop. From a Claude Code session:

```
/loop 5m /flaky-ci-watcher
```

Or run a single pass on demand:

```
/flaky-ci-watcher
```

To watch **one specific PR** in the repo you're currently in, pass its number:

```
/flaky-ci-watcher 1234
```

Targeted mode resolves the repo from your working directory and only accepts a
PR you authored — it refuses (and does nothing) if the PR belongs to someone
else.

This skill uses the native Claude Code `SKILL.md` format, so `/flaky-ci-watcher`
works in **any** directory (it lives in your user-level `~/.claude/skills/`),
not just inside this repo. For targeted mode, run it from inside the repo whose
PR you want to watch.

Keep the session open while it loops — alerts print in the terminal. For
unattended/background runs on a schedule, see the `schedule` skill instead.

## Configuration

Defaults live in `SKILL.md` / `skill.json`:

| Setting | Default |
|---|---|
| Scope (default mode) | all your open PRs, all repos, drafts included |
| Scope (targeted mode) | one PR by number in the current repo (yours only) |
| Re-run cap | 2 per workflow per commit |
| Notify channel | terminal |
| State file | `${FLAKY_CI_WATCHER_HOME:-$HOME/.claude/flaky-ci-watcher}/state.json` |

To watch just one PR, pass its number (`/flaky-ci-watcher 1234`) from inside
that repo. To scope default mode to a single repo, narrow the `gh search prs`
query in `SKILL.md` (e.g. add `--repo getsentry/sentry-cocoa`).

## Example output

```
🔴 Real failure — getsentry/sentry-cocoa#1234: Add new transport layer
   Workflow: Unit Tests · https://github.com/getsentry/sentry-cocoa/pull/1234
   Why real: SentryTransportTests.testSendEnvelope failed — touches Transport.swift which this PR changed.
   Action: stopped re-running. This looks caused by your changes, not flaky.

🟡 Flaky test — getsentry/sentry-cocoa#1240: Bump dependency
   Workflow: UI Tests · https://github.com/getsentry/sentry-cocoa/pull/1240
   Re-ran 2× and it keeps failing intermittently: simulator boot timeout ("Unable to boot device").
   Action: stopped re-running. "Hey, this looks like another flaky test."

CI watch pass @ 14:05: 3 open PRs with active/failed CI · 1 jobs re-run · 2 alerts
- getsentry/sentry-cocoa#1234: 🔴 real
- getsentry/sentry-cocoa#1240: 🟡 flaky
- getsentry/sentry-cocoa#1251: pending
```

## Safety

- **Never:** approve, merge, enable auto-merge, comment, or push code.
- **Only write action:** `gh run rerun --failed` on flaky-looking failures, capped.
- **Bias:** when flaky-vs-real is ambiguous, treats it as real and alerts you
  rather than wasting CI re-running a genuinely broken build.

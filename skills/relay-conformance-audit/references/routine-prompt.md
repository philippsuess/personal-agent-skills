# Scheduled routine prompt (weekly)

Use this as the prompt when creating the weekly routine (via the `schedule` skill / cron). It is self-contained: it clones the skill + the SDK, runs the audit, and posts to Slack. The routine runs as a **cloud agent**, so it needs GitHub access (to clone both repos) and the Slack secrets.

- **Cron:** `0 9 * * 1` — Mondays 09:00 (set your timezone when creating the routine).
- **Secrets:** `SLACK_BOT_TOKEN` (scope `chat:write`, + `files:write` if uploading the report as a snippet) and `SLACK_CHANNEL_ID`.
- **Prerequisite:** the `relay-conformance-audit` skill must be on the branch the routine clones (merge `add-relay-conformance-audit` to `main`, or point the clone at that branch).

---PROMPT---
You are running the weekly Sentry Cocoa ↔ Relay conformance audit. READ-ONLY: never modify SDK code, open PRs, or file issues.

1. Clone the audit skill repo (`gh repo clone philipphofmann/personal-agent-skills`) and read `skills/relay-conformance-audit/SKILL.md` and its `references/`.
2. Clone/refresh `getsentry/sentry-cocoa` at `main`; record the short SHA and today's date (via a shell command, not a hardcoded date).
3. Execute the SKILL.md procedure: fan out one subagent per area in `references/surface-map.md`, each diffing the mapped Cocoa files against the develop-docs page(s) + Relay source; collect structured findings.
4. Classify each finding NEW / KNOWN / RESOLVED against `references/baseline.md`; treat any broken item from the baseline's conformant checklist as NEW / HIGH (a regression).
5. Assemble the delta + full report per `references/report-format.md`, stamped with date + SHA.
6. Post to Slack using the bot token: the delta as the main message (capture its `ts`), then the full report as a threaded reply (`thread_ts`). Check each Slack API response `.ok`; if a post fails, surface `.error` — do not exit as if the run succeeded.

If `SLACK_BOT_TOKEN` is unset, print the delta + full report instead of posting (dry-run).
---END PROMPT---

# Scheduled routine prompt (weekly)

Use this as the prompt when creating the weekly routine (via the `schedule` skill / cron). It is self-contained: it clones the skill + the SDK, runs the audit, and posts to Slack. The routine runs as a **cloud agent**, so it needs GitHub access (to clone both repos) and access to the Slack connector.

- **Cron:** `0 9 * * 3` — Wednesdays 09:00, timezone **Europe/Vienna**.
- **Slack:** posts via the **Slack MCP connector** (`slack_send_message`, which supports `thread_ts`). Target channel: `<SLACK_CHANNEL_ID>`. (Fallback if the connector isn't available in a scheduled run: a bot token + `chat.postMessage` — see `report-format.md`.)
- **Prerequisite:** the `relay-conformance-audit` skill must be on `main` (merge the draft PR from `add-relay-conformance-audit`). Until then, clone the `add-relay-conformance-audit` branch.

---PROMPT---
You are running the weekly Sentry Cocoa ↔ Relay conformance audit. READ-ONLY: never modify SDK code, open PRs, or file issues.

1. Clone the audit skill repo (`gh repo clone philipphofmann/personal-agent-skills`, `main`) and read `skills/relay-conformance-audit/SKILL.md` and its `references/`.
2. Clone/refresh `getsentry/sentry-cocoa` at `main`; record the short SHA and today's date (via a shell command, not a hardcoded date).
3. Execute the SKILL.md procedure: fan out one subagent per area in `references/surface-map.md`, each diffing the mapped Cocoa files against the develop-docs page(s) + Relay source; collect structured findings.
4. Classify each finding NEW / KNOWN / RESOLVED against `references/baseline.md`; treat any broken item from the baseline's conformant checklist as NEW / HIGH (a regression).
5. Assemble the delta + full report per `references/report-format.md`, stamped with date + SHA.
6. Post to Slack channel `<SLACK_CHANNEL_ID>` via the Slack connector: send the **delta** as the main message and capture its `ts` (from the returned message link/timestamp), then send the **full report** as a reply with `thread_ts` = that `ts`. If the Slack connector is unavailable, print the delta + full report and clearly note that posting failed (do not report success).
---END PROMPT---

# Scheduled routine (weekly) — live config

The weekly cloud routine that drives this skill. Created via the `schedule` skill / claude.ai routines.

- **Routine:** `relay-conformance-audit-weekly` — id `trig_01TgfZKrPC6oLU3osDrF5uKu` — https://claude.ai/code/routines/trig_01TgfZKrPC6oLU3osDrF5uKu
- **Cron:** `0 7 * * 3` (UTC) = **Wednesdays 09:00 Europe/Vienna** during CEST. Note: cron is fixed UTC, so in winter (CET) this fires at 08:00 Vienna — bump to `0 8 * * 3` if you want a strict 09:00 year-round.
- **Model:** `claude-sonnet-5` (bump to opus for deeper audits).
- **Sources (auto-checked-out):** `getsentry/sentry-cocoa`, `philipphofmann/personal-agent-skills`.
- **MCP:** Slack connector. **Posts to** `#team-sdk-apple` (`C09MQRJGBU2`).
- **Prerequisite:** the routine reads the skill from the personal-agent-skills checkout on `main`; until the draft PR (`add-relay-conformance-audit`) is merged, the prompt falls back to `git checkout add-relay-conformance-audit`.

## The prompt (as configured)

```
You are running the weekly Sentry Cocoa ↔ Relay protocol-conformance audit. READ-ONLY: never modify SDK code, commit, open PRs, or file issues. Your only external action is posting the report to Slack.

Two repos are checked out for you: sentry-cocoa (getsentry/sentry-cocoa) and personal-agent-skills (philipphofmann/personal-agent-skills).

1. In the personal-agent-skills checkout, open skills/relay-conformance-audit/SKILL.md and its references/ (surface-map.md, baseline.md, report-format.md). If that path is missing (the skill PR isn't merged to main yet), run `git fetch origin add-relay-conformance-audit && git checkout add-relay-conformance-audit` in that checkout, then open it.
2. In the sentry-cocoa checkout, make sure main is current (git pull); record the short commit SHA (git rev-parse --short HEAD) and today's date (date +%Y-%m-%d) via shell — do not hardcode the date.
3. Follow the SKILL.md procedure: for each area in references/surface-map.md, diff the mapped Cocoa files against the develop-docs page(s) and Relay source (fetch via WebFetch / raw.githubusercontent.com). Run areas as parallel subagents if available, otherwise sequentially. Collect structured findings (id, area, severity, file:line, spec citation, failure mode).
4. Classify each finding NEW / KNOWN / RESOLVED against references/baseline.md. Treat any broken item from the baseline's conformant checklist as a NEW / HIGH regression.
5. Build the delta (headline) + full report per references/report-format.md, stamped with the date + sentry-cocoa SHA.
6. Post to Slack channel C09MQRJGBU2 (#team-sdk-apple) via the Slack connector: send the delta as the main message, capture its message_ts, then send the full report as a reply with thread_ts = that message_ts. Verify each Slack response is ok; if the Slack connector is unavailable or a post fails, print the full delta + report to your output and state clearly that the Slack post FAILED — do not report success.
```

## Managing the routine

- Update / disable / run-now: via the `schedule` skill or https://claude.ai/code/routines/trig_01TgfZKrPC6oLU3osDrF5uKu
- To change cadence/channel/model, update the routine (partial update) — no need to touch this file except to keep it accurate.
- **If a scheduled run reports the Slack post FAILED** (connector unavailable headlessly), switch to the bot-token path in `report-format.md`.

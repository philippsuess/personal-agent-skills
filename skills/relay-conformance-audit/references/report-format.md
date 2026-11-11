# Report format & Slack posting

Two outputs per run: a **delta** (the main Slack message) and the **full report** (a threaded reply). Slack uses *mrkdwn*, not full Markdown — no tables, `*bold*` (single asterisks), `` `code` ``, `<url|label>` links, `•` bullets. Keep the delta short; put detail in the thread.

## Main message — delta (Slack mrkdwn)

Header + one count line + NEW/RESOLVED bullets. Quiet week = a single ✅ line.

```
:shield: *Cocoa ↔ Relay conformance* — <DATE> · sentry-cocoa@<SHA>
NEW <n>  ·  RESOLVED <n>  ·  known <n>  ·  conformant <OK|:rotating_light: BROKEN>

:warning: *NEW*
• [<SEVERITY>] <area> — <file:line> — <one-line summary>
• …

:white_check_mark: *RESOLVED* (confirm before removing from baseline)
• <id> <area> — <summary>

:thread: Full report in thread.
```

Quiet week:
```
:shield: *Cocoa ↔ Relay conformance* — <DATE> · sentry-cocoa@<SHA>
:white_check_mark: No new conformance drift. (known <n> · conformant OK)
```

Regression (a conformant-checklist item now broken) is a NEW/HIGH bullet, prefixed `:rotating_light: REGRESSION`.

## Threaded reply — full report

The standalone snapshot: all findings grouped by area (NEW / KNOWN / RESOLVED), each with severity, `file:line`, spec citation, failure mode; end with the conformant-checklist result. If it exceeds Slack's ~3000-char practical message limit, either split into multiple threaded replies or upload as a `report.md` snippet in the thread (see below).

## Posting recipe (bot token, enables threading)

Requires `SLACK_BOT_TOKEN` (scope `chat:write`; `files:write` too if uploading a snippet) and `SLACK_CHANNEL_ID`. Threading needs the Web API — an incoming webhook cannot reply in-thread (it never returns the parent `ts`).

1. Post the delta, capture the parent timestamp:
```bash
TS=$(curl -sS -X POST https://slack.com/api/chat.postMessage \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H 'Content-type: application/json; charset=utf-8' \
  --data "$(jq -n --arg c "$SLACK_CHANNEL_ID" --arg t "$DELTA_TEXT" '{channel:$c, text:$t}')" \
  | jq -r 'if .ok then .ts else ("ERR:"+.error) end')
# guard (an empty TS means curl/jq failed, e.g. Slack unreachable):
[ -n "$TS" ] && [ "${TS#ERR:}" = "$TS" ] || { echo "Slack post failed: ${TS:-no response}"; exit 1; }
```
2. Post the full report as a threaded reply (in a code block; `--rawfile` binds the file as a JSON-escaped string):
```bash
REPLY=$(curl -sS -X POST https://slack.com/api/chat.postMessage \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H 'Content-type: application/json; charset=utf-8' \
  --data "$(jq -n --arg c "$SLACK_CHANNEL_ID" --arg ts "$TS" \
            --rawfile body full-report.md '{channel:$c, thread_ts:$ts, text:("```\n"+$body+"\n```")}')" \
  | jq -r 'if .ok then "ok" else ("ERR:"+.error) end')
[ "$REPLY" = "ok" ] || { echo "Slack thread reply failed: ${REPLY:-no response}"; exit 1; }
```
   For a long report, upload it as a file in the thread instead (current API): `files.getUploadURLExternal` → PUT the bytes → `files.completeUploadExternal` with `channel_id` + `thread_ts`. (The old `files.upload` is deprecated.)

Always check `.ok` in each response and log `.error` on failure so a silent Slack outage doesn't look like "no drift."

## Webhook-only fallback (no threading)

If using an incoming webhook instead of a bot token: post ONE message = delta on top, then a `---` and the (trimmed) full report below, or two separate webhook messages. There is no true thread. `curl -sS -X POST -H 'Content-type: application/json' --data "$(jq -n --arg t "$TEXT" '{text:$t}')" "$SLACK_WEBHOOK_URL"`.

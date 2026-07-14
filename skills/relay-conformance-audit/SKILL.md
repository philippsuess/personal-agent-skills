---
name: relay-conformance-audit
description: Audit the Sentry Cocoa SDK for protocol-conformance drift against Relay and the Sentry SDK develop-docs — anywhere a string/format the SDK must match Relay exactly could silently drop, mis-route, or miscount data (the class of bug behind #8322, the case-sensitive rate-limit header). Diffs Cocoa code vs develop-docs + Relay source across headers, envelopes, data categories, client reports, auth, DSC/baggage, sentry-trace, sessions, and the rate-limit parsers; classifies findings as NEW/KNOWN/RESOLVED against a baseline; produces a delta + full report. Read-only — never fixes code. Use for a scheduled/periodic conformance check or an on-demand review.
---

# Relay / Develop-Docs Conformance Audit — Sentry Cocoa SDK

You audit the **Sentry Cocoa SDK** (`getsentry/sentry-cocoa`) for **protocol-conformance drift** against **Relay** (`getsentry/relay`) and the **Sentry SDK develop-docs** (`develop.sentry.dev/sdk`).

**Why this exists:** bug [#8322](https://github.com/getsentry/sentry-cocoa/issues/8322) (fixed in #8324) came from the SDK reading the `X-Sentry-Rate-Limits` response header with a *case-sensitive* lookup — which silently fails over HTTP/2/HTTP/3 (headers lowercased). That is one instance of a general shape: **the SDK hard-codes many strings and wire formats that must match Relay exactly, and a mismatch fails silently** (dropped/mis-routed/miscounted telemetry). This skill hunts for that whole class, repeatably.

**This skill is READ-ONLY.** It never edits SDK code, opens PRs, or files issues. Its only output is a report (and, when configured, a Slack post).

## When to use

- On a schedule (e.g. weekly) to catch drift as Relay/develop-docs evolve.
- On demand before/after a networking or protocol change.
- After Relay adds a `DataCategory` / `ItemType` / discard reason, to check whether Cocoa needs to learn it.

## Inputs & prerequisites

- **sentry-cocoa checkout** — clone or `git pull` `getsentry/sentry-cocoa` `main`; record the commit SHA. If run from inside a checkout, use it.
- **This skill's `references/`** — `surface-map.md` (what to diff), `baseline.md` (known findings), `report-format.md` (output templates). When run headlessly, clone `github.com/philipphofmann/personal-agent-skills` and read them from `skills/relay-conformance-audit/references/`.
- **Web access** — to fetch develop-docs pages and Relay source (raw.githubusercontent.com).
- **Slack (optional, for scheduled runs)** — `SLACK_BOT_TOKEN` (scope `chat:write`, plus `files:write` if threading the full report as a snippet) and `SLACK_CHANNEL_ID`. See `references/report-format.md`.

## Procedure

1. **Snapshot the target.** Ensure fresh `sentry-cocoa` `main`. Record `git rev-parse --short HEAD` and the date — both stamp the report. (Do NOT stamp with `Date.now()` inside any workflow script; capture the date via a shell command.)

2. **Fan out the diff.** Read `references/surface-map.md`. For **each area**, spawn a subagent (use the Agent/Task tool; run areas in parallel) with this contract:
   - Fetch the listed **develop-docs URL(s)** and **Relay source file(s)** (via WebFetch / raw GitHub).
   - Read the listed **Cocoa source files**.
   - Diff them against the "what to check" notes.
   - Return **structured findings**, each: `{ id, area, severity (HIGH|MEDIUM|LOW), location (file:line), summary, spec_citation (URL or Relay file), failure_mode }`, plus a short list of what it verified **CONFORMANT**.
   - The subagent is read-only and must cite exact strings/line numbers.

3. **Classify vs baseline.** Load `references/baseline.md`. For every finding, match on `area + normalized location + summary` and label:
   - **NEW** — not in the baseline (⚠️ this is the signal that matters).
   - **KNOWN** — already in the baseline.
   - **RESOLVED** — a baseline finding the audit no longer reproduces (✅ likely fixed; worth confirming).
   Also flag **CONFORMANT-REGRESSION**: any item in the baseline's "conformant checklist" that the audit now finds broken (treat as NEW/HIGH).

4. **Assemble two outputs** (templates in `references/report-format.md`):
   - **Delta** (the headline): counts + every NEW and RESOLVED item. If none: "✅ No new conformance drift."
   - **Full report**: all findings grouped by area (NEW/KNOWN/RESOLVED), plus the conformant checklist result. Stamp both with date + SHA.

5. **Deliver.**
   - Scheduled/Slack mode: post the **delta as the main Slack message**, then the **full report as a threaded reply** (see `report-format.md`). 
   - Interactive mode: print the delta, then the full report.

6. **Never modify SDK code or the baseline automatically.** Baseline changes are a human decision (see below).

## Output contract

- The **delta** must be skimmable in 5 seconds: a run header (date + SHA), one count line (`NEW n · RESOLVED n · known n · conformant ok/BROKEN`), then NEW/RESOLVED bullets (each with severity, `file:line`, one-line summary). Quiet weeks are a single ✅ line.
- The **full report** is the standalone snapshot: every finding with citation + failure mode, grouped by area, ending in the conformant checklist.
- Prefer precise `file:line` and exact wire strings over prose — this is a diff, not an essay.

## Baseline maintenance (human-in-the-loop)

`references/baseline.md` is the memory of "known/accepted" state. Update it (via a normal commit to personal-agent-skills) when:
- A finding is **fixed** in the SDK → remove it (so a regression later re-alarms as NEW).
- A finding is **accepted / won't-fix** → keep it, so it doesn't show as NEW each week.
- A **new** finding is triaged and accepted as known → add it.
Each baseline entry has a stable `id`; keep ids stable so history is legible.

## Notes / guardrails

- **Read-only, always.** No `git commit` to sentry-cocoa, no `gh pr`, no issue creation.
- **Relay paths move.** If a Relay source file 404s, search the repo for the symbol (`ItemType`, `DataCategory`, `ClientReport`) rather than trusting a stale path; update `surface-map.md` if a path changed.
- **Severity is about silent-blast-radius**, not effort: a wire-string mismatch that silently drops data is HIGH even if the fix is one line.
- Keep the audit's cost bounded: one subagent per area, parallel; don't recurse into unrelated SDK subsystems.

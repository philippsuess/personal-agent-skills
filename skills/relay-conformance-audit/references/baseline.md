# Baseline — known conformance findings

Captured **2026-07-14** against `getsentry/sentry-cocoa` `main` @ `846947807`.

These are the findings the weekly audit already knows about. A run classifies each new finding as **KNOWN** (listed here), **NEW** (not here → the signal), or **RESOLVED** (here but no longer reproduced → likely fixed). Line numbers drift as the SDK changes — match primarily on `id` / `area` / `summary`, using `file:line` as a hint. Maintain this file by hand (see SKILL.md "Baseline maintenance").

> **Purpose reminder:** the goal is to detect *drift*, not to re-fix these. Only remove an entry when the SDK actually fixes it (so a later regression re-alarms as NEW), or keep it if accepted as won't-fix.

## Findings

### Header case-sensitivity class (the #8322 family)

| id | severity | location | summary |
| -- | -------- | -------- | ------- |
| F1 | HIGH | `Sources/Sentry/SentryNetworkTracker.m:654` | `allHeaderFields[@"Content-Type"]` on a **response** — case-sensitive; HTTP/2/3 lowercases → nil. Tracked as open issue **#8388**; lint-suppressed with a "needs fixing" note. |
| F2 | MEDIUM | `Sources/Sentry/SentryNetworkTracker.m:698` | `allHTTPHeaderFields[@"Content-Type"]` on a request (replay capture); not lint-suppressed. |
| F3 | MEDIUM | `Sources/Sentry/SentryTracePropagation.m:35` | `allHTTPHeaderFields[@"baggage"]` incoming-baggage read is case-sensitive — inconsistent with lines 69/73 of the same method that use `valueForHTTPHeaderField:`. |

### Prevention gaps (header class)

| id | severity | location | summary |
| -- | -------- | -------- | ------- |
| G1 | HIGH | CI config (`.github/workflows/`, `Makefile`) | ObjC banned-pattern linter (`check-objc-banned-pattern.sh`) runs only in pre-commit, **not CI**. Only `swiftlint --strict` runs in CI (Swift rule only). All remaining header bugs are ObjC. |
| G2 | MEDIUM | `.swiftlint.yml`, `scripts/check-objc-banned-pattern.sh` | Linters match `allHeaderFields` but not `allHTTPHeaderFields`, so F2/F3 slip through. |
| G3 | LOW | `Tests/.swiftlint.yml` | `parent_config:` doesn't merge parent `custom_rules`; `avoid_all_header_fields` not applied to tests. |

### Dynamic Sampling Context / sampling

| id | severity | location | summary |
| -- | -------- | -------- | ------- |
| A | MEDIUM | `Sources/Sentry/SentryTraceContext.m:134-149` → `SentryClient.m:428-431` | Error-only / no-transaction traces emit a DSC with no `sample_rand`/`sample_rate`/`sampled` (propagation context never seeds `sample_rand`) → Relay must synthesize one; a later transaction in the trace can disagree. |
| B | MEDIUM | `Sources/Sentry/SentryTraceContext.m:108,114` | `sample_rand`/`sample_rate` serialized with `%f` (6-decimal rounding) — can flip Relay's `sample_rand < sample_rate ⟺ sampled` re-derivation at the boundary. Same format-string family as #8322 (no locale bug — `stringWithFormat:` emits `.`). |
| C | LOW | `Sources/Sentry/SentrySampling.m:36` | `random <= rate` where the spec invariant is strict `<`. Negligible boundary probability. |

### Data categories

| id | severity | location | summary |
| -- | -------- | -------- | ------- |
| 2b | LOW (latent) | `Sources/Sentry/include/SentryDataCategory.h:8-27` | `SentryDataCategory` numeric raw values diverge from Relay's `DataCategory` discriminants. Safe only because indices are internal-only (wire uses names). #8322-shaped landmine if an index is ever serialized. |
| 2c | LOW–MEDIUM | `Sources/Sentry/SentryDataCategoryMapper.m:85-134` + `RateLimitParser.swift:92-95` | `sentryDataCategoryForString` knows 15 names; any other rate-limit category → `.unknown` → silently ignored. Notably `profile_chunk` (non-UI) is unrecognized — fragile coupling to Relay's `profile_chunk_ui` platform inference. |
| 2e | LOW | `Sources/Sentry/SentryDataCategoryMapper.m:64-66` | `log` item maps only to `log_item`, never `log_byte`, so a `log_byte`-only limit isn't enforced pre-send. Byte-quota is a Relay-side concern; matches other SDKs. |

### Sessions

| id | severity | location | summary |
| -- | -------- | -------- | ------- |
| D | LOW | `Sources/Swift/.../SentrySession.swift:44` | `seq` starts at 1 rather than 0/UNIX-ms. Relay only needs monotonicity + forces `seq=0` on init server-side. Benign. |
| E | LOW | `Sources/Swift/.../SentrySession.swift:230-239` | `attrs` omitted when release AND environment are both nil; `attrs.release` is spec-required. In practice release is always supplied. |

### Client reports (minor)

| id | severity | location | summary |
| -- | -------- | -------- | ------- |
| L1 | LOW | `Sources/Sentry/SentryDiscardReasonMapper.m:6-7` | `network_error` / `queue_overflow` reason constants defined but never recorded (dead code). Both spec-valid. |
| L2 | LOW | `Sources/Sentry/include/SentryDiscardReason.h:5` | Stale develop-docs link (`/sdk/client-reports/` → `/sdk/telemetry/client-reports/`). |

## Conformant checklist (regression detectors)

The audit verified these CONFORMANT on 2026-07-14. If a run finds any of these **broken**, treat it as a **NEW / HIGH** regression:

- **Envelope item types** — all 12 emitted strings recognized by Relay `ItemType::from_str` with exact casing (`event, transaction, feedback, session, attachment, client_report, profile, profile_chunk, replay_video, log, trace_metric, statsd`); replay msgpack keys `replay_event`/`replay_recording`/`replay_video` match.
- **Data-category names** — all 15 wire names match Relay `name()`/`from_name` (`default, error, session, transaction, attachment, profile, profile_chunk_ui, replay, metric_bucket, span, feedback, log_item, log_byte, trace_metric` + `""`=all); wire uses names, never indices.
- **Discard reasons** — all 9 emitted strings in the develop-docs allowlist; `ratelimit_backoff` correctly spelled (not `rate_limit_backoff`).
- **Client report** — item type `client_report`; payload `{timestamp, discarded_events:[{reason, category, quantity}]}`; Relay-reserved arrays never populated; 429s not double-counted; rate-limit drops attributed to correct category + `ratelimit_backoff` (incl. `span` +1 and `log_byte` sub-accounting).
- **Auth/request** — `X-Sentry-Auth` (`sentry_version=7`, `sentry_client`, `sentry_key`), `Content-Type: application/x-sentry-envelope`, `Content-Encoding: gzip`, `POST`, `/api/<project>/envelope/` path.
- **Rate-limit parser** — strips spaces; empty categories → all; all-unknown-category limits ignored (not applied to default); metric_bucket namespaces handled; primary header-name reads case-insensitive (the #8324 fix).
- **DSC keys** — all baggage keys exactly named; `org_id` + `sample_rand` supported as first-class fields (gap = the no-transaction path, finding A); `sentry-sampled` = `true`/`false`.
- **sentry-trace** — `traceid-spanid-sampled`, 32/16 hex, sampled `1`/`0`/omitted.
- **Sessions** — field names + ISO-8601 timestamps + status enum (`ok/exited/crashed/abnormal`) + init/seq dedup + never-drop-init migration.

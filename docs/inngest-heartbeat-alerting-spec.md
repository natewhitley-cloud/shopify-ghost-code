# Spec: External heartbeat — email alert on Inngest signing-key drift (cross-app)

**Status:** Tracked as a P1 bead in the **ClearSignal** backlog (filed 2026-08-28).
This doc is the design reference; the bead is the work item. (Originally written
here because ghost-code's beads Dolt store was down at capture time — `bd create` →
"issue_prefix config is missing" — which is itself a separate infra follow-up.)

**Priority:** P1 — this failure mode nearly delisted Ghost Code.

## Incident origin (2026-08-28)

Inngest rotated the **production signing key across the whole portfolio at once**.
All three apps' `PUT /api/inngest` returned `401 "Your signing key is invalid"`,
silently killing every background job — including each app's OWN in-app failure
monitor (`monitor-scan-failures` is itself an Inngest cron, so it cannot alert when
Inngest is the thing that's down). Ghost Code theme scans hung indefinitely (the
`watch-stale-scans` watchdog never fired because it too is an Inngest cron) →
Shopify flagged a 2-week delist risk. ClearSignal + TaxDelta were found dead the
same way during triage.

## Requirement

An **external** heartbeat (independent of each app's own Inngest/Railway runtime)
that pings each app and **emails natewhitley@gmail.com** when the signing key is
invalid or the app is unreachable.

## Check

```
curl -s -o /dev/null -w '%{http_code}' -X PUT <appUrl>/api/inngest
  200 = healthy ("Successfully registered")
  401 = signing-key drift            → ALERT
  5xx / timeout = app down / unreachable → ALERT (distinct message)
```

Also `GET /health` to distinguish "app down" from "Inngest key bad" so the email is
actionable.

### Endpoints

| App | Endpoint |
|---|---|
| Ghost Code | https://app.alpenglowsoftware.com/api/inngest |
| ClearSignal | https://clearsignal.alpenglowsoftware.com/api/inngest |
| TaxDelta | https://tax-integrity-monitor-production.up.railway.app/api/inngest |

## Design options (decide in grooming)

- **A) Scheduled GitHub Actions workflow** (matrix over the 3 URLs) + email via
  `dawidd6/action-send-mail` using a Gmail app-password secret. Fully external to
  Railway/Inngest, version-controlled, free. Lives in one repo (candidate:
  `data-integrity-suite`, the existing GH Pages repo) or `ghost-code-app`.
- **B) External uptime monitor** (BetterStack / UptimeRobot free tier): PUT check,
  expect 200, keyword alert on 401. Zero code, built-in email, fully independent —
  but a third-party signup outside git.

**Recommendation: A** (control + versioned + one place for all three). Fall back to
B if email-from-GHA proves fiddly.

## Frequency

Nathan wants it configurable (4 / 6 / 8 / 12 / 24h). **Recommend every 6h** (4×/day)
as default — a 401 hangs ALL scans (revenue + delist risk), so catch within a
quarter-day while keeping noise low. Tighten to 4h if desired.

## Scope note

Can split one-app-at-a-time, but a single 3-URL checker is strictly less work and
this incident hit all three simultaneously — build it cross-app.

## Related follow-ups (separate items)

1. **ClearSignal + TaxDelta need the SAME key rotation applied** (both 401 as of
   2026-08-28; Ghost Code already fixed).
2. Consider replacing/augmenting the in-app `monitor-scan-failures` since it can't
   self-detect an Inngest outage.
3. Beads Dolt store was down during this session — separate infra fix.

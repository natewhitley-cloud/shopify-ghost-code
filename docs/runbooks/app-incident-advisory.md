# Runbook: affected-app advisory (`APP_INCIDENT_ADVISORY`, gc-14x5)

What it is: one in-app notice per app on the curated list in
`app/data/app-incident-advisories.server.ts`, shown when the PUBLISHED theme
loads that app's script (a `<script src>` tag or a `script_tag` filter in a
Liquid theme file). It states two facts: the theme loads the app's code, and a
public report names the app. It never says the store was affected. In-app
only, every plan, no email.

## Turn it on

1. Deploy the build. With `APP_INCIDENT_ADVISORY_LIVE_ENABLED` unset the
   detector runs on every scan but stores nothing; hits are counted in the
   `scan_signal` event's `detectorHits.APP_INCIDENT_ADVISORY`.
2. Precision review (the soft-launch convention): read those suppressed hits
   for a few days. For each shop that hit, confirm from the stored signal that
   the theme really loads the listed script. Zero hits is a valid result.
3. Set `APP_INCIDENT_ADVISORY_LIVE_ENABLED=true` (exactly `true`). From the
   next scan of a published theme the finding is stored and shown. Scans taken
   before the flag never report it as "new".

The check is live only while the flag is on AND at least one list entry has
not passed its `reviewBy` date (`isAdvisoryCheckLive`).

## Add or renew an entry

Inclusion bar, all required:

- A concrete, citable PUBLIC incident report (`sourceUrl`).
- Match keys (`scriptHosts`) that are VERIFIED: seen in the report itself or
  in real theme code. Never guessed from a vendor name or a CDN path. List the
  exact host the app loads from, never a vendor's base domain.
- `reviewBy`: 90 days after the incident, or after the renewal.
- `summary`: what the report says, nothing about the merchant's store, no
  dashes, no trailing period.

To renew: re-read the report, look for a vendor statement, then set a new
`reviewBy`. To retire: delete the entry. A test fails from the day after
`reviewBy` until one of the two is done.

The card copy is per finding TYPE and is written for a checkout phishing
report (`CARD_COPY_OVERRIDES` in `app/lib/finding-remediation.ts`). An entry
for a different kind of incident needs per-entry copy first.

## Kill switch

1. Unset `APP_INCIDENT_ADVISORY_LIVE_ENABLED` (or set it to anything but
   `true`). This stops NEW findings only. Rows already stored keep rendering
   on the scans that hold them.
2. To remove the stored rows, an operator runs, with the owner's explicit
   go-ahead each time:

   ```sql
   DELETE FROM "Finding" WHERE "findingType" = 'APP_INCIDENT_ADVISORY';
   ```

   There is no read-side filter by design: stored rows are either shown or
   deleted.

## Rollback

The `DELETE` above is REQUIRED before rolling back to any build older than
this feature. An older build's Prisma client does not know the enum value, so
reading a scan that holds such a row fails for that shop. The enum value
itself cannot be dropped in Postgres and can stay; it is only harmless once no
row uses it.

Order: flag off, `DELETE`, then roll back.

## After `reviewBy`

From the next UTC day:

- New scans emit nothing for that entry. When it was the last active entry the
  type is recorded as not live for the scan, so the vanished finding is never
  reported as fixed.
- Until a merchant's next scan, their latest scan still shows the advisory
  card. The "Read the report" link is gone (an expired entry is no longer
  vouched for); the rest of the card is unchanged.
- The host is listed under "Unrecognized Scripts" again on new scans.

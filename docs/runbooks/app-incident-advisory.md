# Runbook: affected-app advisory (`APP_INCIDENT_ADVISORY`, gc-14x5)

What it is: one in-app notice per app on the curated list in
`app/data/app-incident-advisories.server.ts`, shown when the PUBLISHED theme
loads that app's script (a `<script src>` tag or a `script_tag` filter in a
Liquid theme file). It states two facts: the theme loads the app's code, and a
public report names the app. It never says the store was affected. In-app
only, every plan, no email.

## Turn it on

1. Deploy the build. With `APP_INCIDENT_ADVISORY_LIVE_ENABLED` unset the
   detector runs on every scan but stores nothing.
2. Read what the dark period can tell you, and no more. The `scan_signal`
   event carries ONE number per scan, `detectorHits.APP_INCIDENT_ADVISORY`:
   how many advisories the detector would have emitted. It holds no file,
   line or snippet (ops events deliberately carry no theme code), and while
   dark it also counts scans of DRAFT themes, which never get an advisory once
   live. So it answers "how many shops would this touch, at most", not "is
   each hit right". Zero is a valid result.
3. Precision review on a dev store (this is the review; do it before the
   flag goes on in production). Set the flag on a dev environment and scan a
   dev-store theme that holds the listed script tag in each of these forms,
   one at a time:
   - live in `layout/theme.liquid`: expect ONE advisory, the notice on the
     scan page, the line on Home, and the host absent from "Unrecognized
     Scripts";
   - commented out (`<!-- -->`, `{% comment %}`, `{% # %}`): expect none;
   - only in an unpublished copy of the theme: scan that copy and expect none;
   - mentioned but not loaded (a link, a stylesheet): expect none, and the
     stylesheet still listed under "Unrecognized Scripts".
   Then ignore the advisory on a Free dev store and confirm it leaves the
   scan page and Home.
4. Set `APP_INCIDENT_ADVISORY_LIVE_ENABLED=true` (exactly `true`) in
   production. From the next scan of a published theme the finding is stored
   and shown. Scans taken before the flag never report it as "new".

The check is live only while the flag is on AND at least one list entry has
not passed its `reviewBy` date (`isAdvisoryCheckLive`).

A scan needs to know which theme is published. That is one small Admin read
per scan, retried once. If it fails twice (a throttle, an outage) the advisory
is absent for that ONE scan, the type is recorded as not run for it (so
nothing reads as fixed), and it is back on the next good scan.

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
   BEGIN;

   -- 1. FIRST, while the rows still exist: take them out of each scan's
   --    stored count. Scan history shows "Scan"."findingCount" as is for a
   --    shop with no ignores, so without this it stays one too high per
   --    deleted row.
   UPDATE "Scan" AS s
   SET "findingCount" = GREATEST(0, s."findingCount" - d.n)
   FROM (
     SELECT "scanId", COUNT(*)::int AS n
     FROM "Finding"
     WHERE "findingType" = 'APP_INCIDENT_ADVISORY'
     GROUP BY "scanId"
   ) AS d
   WHERE s."id" = d."scanId";

   -- 2. THEN delete the rows.
   DELETE FROM "Finding" WHERE "findingType" = 'APP_INCIDENT_ADVISORY';

   COMMIT;
   ```

   Both statements must run in that order in the SAME transaction: the UPDATE
   is computed from the rows the DELETE removes, so it cannot be run after it,
   and running it twice would subtract twice. This SQL was written against
   `prisma/schema.prisma` ("Scan"."findingCount", "Finding"."scanId") and has
   NOT been run: do a `SELECT COUNT(*)` of the rows first and check the UPDATE
   touches the same number of scans before the COMMIT. `newFindingCount`,
   `resolvedFindingCount` and `persistedFindingCount` on those scans are
   telemetry and are left as they were.

   There is no read-side filter by design: stored rows are either shown or
   deleted.

## Rollback

The kill-switch transaction above (UPDATE, then DELETE) is REQUIRED before rolling back to any build older than
this feature. An older build's Prisma client does not know the enum value, so
reading a scan that holds such a row fails for that shop. The enum value
itself cannot be dropped in Postgres and can stay; it is only harmless once no
row uses it.

Order: flag off, the transaction, then roll back.

## After `reviewBy`

From the next UTC day:

- New scans emit nothing for that entry. When it was the last active entry the
  type is recorded as not live for the scan, so the vanished finding is never
  reported as fixed.
- Until a merchant's next scan, their latest scan still shows the advisory
  card. The "Read the report" link is gone (an expired entry is no longer
  vouched for); the rest of the card is unchanged.
- The host is listed under "Unrecognized Scripts" again on new scans.

## Known limits of the detector

"Loads" means exactly: a `<script src>` tag, or a quoted URL piped straight
into Liquid's `script_tag` filter, on the listed host, in a `.liquid` file
under layout/, templates/, sections/, snippets/ or blocks/, outside HTML
comments, Liquid that never executes (`{% comment %}`, `{% # %}`, `{% raw %}`,
`{% schema %}`, `{% doc %}`) and the bodies of script, noscript, template,
textarea, style, title, xmp, iframe, noembed and noframes elements. Every
doubt resolves toward NOT reporting. Each limit below is pinned by a test in
`tests/services/app-incident-advisory.server.test.ts` ("known limits").

False positives (an advisory is shown although the script does not load):

- the tag sits inside Liquid that never outputs it: `{% if false %}`, or a
  `{% capture %}` that is never printed;
- the tag is text inside another tag's attribute value;
- the tag sits in an outer `<template>` after a nested `<template>` closed.

False negatives (the script loads but no advisory is shown):

- the tag is printed from a `{% raw %}` block;
- a `>` inside Liquid within the tag, before `src`
  (`<script {% if a > b %}...`);
- the URL is built by filters before `script_tag` (`append`), held in a
  variable, or the `src` is Liquid output;
- the script is created by an inline script (`createElement`,
  `document.write`) or loaded from asset JS;
- the tag follows a `<!--` that is not really a comment (in an attribute
  value or a Liquid string) and no `-->` comes after it;
- the tag follows a comment, tag or element that is never closed: the rest of
  that file is not read;
- the script is injected by the app at runtime (a theme app embed or a
  ScriptTag): theme files do not hold it. The embed handle is not matched yet.


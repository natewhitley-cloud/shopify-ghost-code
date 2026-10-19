# Runbook: affected-app advisory (`APP_INCIDENT_ADVISORY`, gc-14x5)

What it is: one in-app notice per app on the curated list in
`app/data/app-incident-advisories.server.ts`, shown when the PUBLISHED theme
loads that app's script (a `<script src>` tag or a `script_tag` filter in a
Liquid theme file) or, failing that, has the app's theme app embed turned on
in `config/settings_data.json` (gc-14x5.1). It states two facts: the theme
loads the app's code (or has its embed on), and a public report names the
app. It never says the store was affected. In-app only, every plan, no email.

Current entries (2026-10-19): Hulk Product Options (host and embed),
Swym Wishlist Plus (embed only), Selleasy (host and embed).

How it shows (gc-q5z8): a red "Security risk" banner per advisory at the top of
Home and of the scan page (the same `SecurityRiskBanner` as known malicious
code), the Home findings tile turns red ("N findings, k security risks"),
Theme health shows the red verdict "An app named in a security incident is in
your theme." with a failed "App security advisories" chip, and "Start here"
names the app. The banner quotes the entry's own `report` sentence (each
vendor's own words, so Selleasy's says "phishing page", Swym's "fake checkout
page"). An advisory honours ignores everywhere: an ignored one has no banner,
does not count as a security risk and leaves the chip green.

The finding records which signal matched:

- host: anchored to the Liquid line that loads the script; description
  "Loads code from <App> (<host>), an app <summary> (<date>)"; the card says
  "Your theme loads a script from this app" and its last step is removing the
  script line.
- embed: anchored to `config/settings_data.json`, line 1, with the embed's
  JSON entry as the snippet; description "Has the <App> app embed turned on,
  an app <summary> (<date>)"; the card says "Your theme has this app's embed
  turned on" and its last step is uninstalling the app or turning the embed
  off in Online Store, Themes, Customize, App embeds.

When both match, the host signal wins (one finding per entry).

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
3. Precision review (this is the review; do it before the flag goes on in
   production). Verification bar (Nathan, 2026-10-19): dev-store installs are
   impossible because Hulk Product Options, Swym Wishlist Plus and Selleasy are
   all delisted, so each embed handle must be seen in several UNRELATED public
   `settings_data.json` files, and the detector must be precise over those
   real files as fixtures:
   - `npx vitest run tests/services/app-incident-advisory-fixtures.server.test.ts`
     passes: nine real public files (three per entry, sources in each
     fixture's header, `tests/fixtures/advisory-embeds/`) each fire only their
     own entry, once; the sibling embeds in them (Swym's
     wishlist-collections-embed, Logbase's DealEasy, Hulk Form Builder, Hulk
     Discounts, Klaviyo, Judge.me and others) fire nothing; and each file with
     its own entry flipped to `"disabled": true` fires nothing.
   - Script hosts: set the flag on a dev environment and scan a dev-store
     theme that holds the listed script tag in each of these forms, one at a
     time:
   - live in `layout/theme.liquid`: expect ONE advisory, the notice on the
     scan page, the line on Home, and the host absent from "Unrecognized
     Scripts";
   - commented out (`<!-- -->`, `{% comment %}`, `{% # %}`): expect none;
   - only in an unpublished copy of the theme: scan that copy and expect none;
   - mentioned but not loaded (a link, a stylesheet): expect none, and the
     stylesheet still listed under "Unrecognized Scripts".
   - Embeds: no install is needed (or possible). Optionally paste one fixture's
     blocks into a dev-store theme's `config/settings_data.json` and scan:
     expect ONE advisory with the embed wording, and none with the entry's
     `"disabled": true`.
   - Ignore the advisory on a Free dev store and confirm the banner leaves the
     scan page and Home, the tile is no longer red for it and the Theme health
     chip turns green.
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

- A concrete, citable PUBLIC incident report (`sourceUrl`), preferably the
  vendor's own statement read at source. Record its URL and date in the
  entry's comment; facts that only appear elsewhere (a press article, a
  relayed merchant email, such as an exact time window) go in the comment,
  never in the merchant copy.
- Match keys that are VERIFIED, never guessed from a vendor name or a CDN
  path. At least one of:
  - `scriptHosts`: seen in the report itself or in real theme code. The
    EXACT host the app loads from (e.g. `upsell-app.logbase.io`), never a
    vendor's base domain (`logbase.io`) or a host shared by the vendor's other
    apps (`swymrelay.com`, `hextom.com`). Matching covers that host and its
    own subdomains only: a sibling subdomain (`cdn.logbase.io`), the parent
    domain or a lookalike (`evil-upsell-app.logbase.io`) never matches.
  - `embedHandles`: the app embed block type WITHOUT its uuid,
    `shopify://apps/<app-handle>/blocks/<block-name>`, lower-case. Verification
    bar: seen in the `current.blocks` of at least two unrelated real public
    `settings_data.json` files (record where in the comment), and added to the
    fixture precision test (`tests/fixtures/advisory-embeds/`, see "Turn it
    on"); a dev-store install is a bonus, not required (delisted apps cannot
    be installed). A match is
    that prefix plus one segment (the uuid); another block or another app of
    the same vendor never matches. Only an ENABLED embed (no
    `"disabled": true`) fires.
- If no key can be verified, leave the field empty with a TODO comment
  rather than guess.
- `reviewBy`: 90 days after the incident, or after the renewal.
- `summary`: what the report says, nothing about the merchant's store, no
  dashes, no trailing period. Part of the STORED finding description: changing
  it orphans existing findings' link and wording (they fall back to neutral
  copy), so treat it as fixed once the flag is on.
- `report` and `reportedByDeveloper` (gc-q5z8): the banner's facts, in the
  source's own words, completing "On {incidentDate}, ..." (no dash, no
  trailing period), and whether the source is the developer's own statement
  ("its developer reported a security incident", "Read {App}'s statement")
  or a third-party report ("it was named in a security incident report",
  "Read the report"). Not stored, so it can be corrected at any time.

To renew: re-read the report, look for a vendor statement, then set a new
`reviewBy`. To retire: delete the entry. A test fails from the day after
`reviewBy` until one of the two is done.

The card copy (`CARD_COPY_OVERRIDES` in `app/lib/finding-remediation.ts`) is
per finding TYPE and is neutral about the incident ("A security incident
report names this app"); the incident itself is described per entry by
`report`. The self-check steps are about a checkout redirect: an entry for a
different kind of incident needs its own steps first.

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
- the tag sits in an outer `<template>` after a nested `<template>` closed;
- the tag is text inside a `{% javascript %}` or `{% stylesheet %}` block, or
  inside a Liquid string that is never output (`{% assign old = '<script ...>' %}`);
- the tag has a `type` the browser does not run (`text/template`,
  `application/json`), or sits inside `<svg>`;
- the `src` holds a JavaScript slash escape written literally (`https:\u002f\u002f...`).

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
- the tag follows a comment, tag or element that is never closed, or a tag
  with an attribute quote that is never closed: the rest of that file is not
  read;
- the tag follows an empty comment written `<!-->`: nothing is read until the
  next `-->`;
- the script is injected by the app at runtime through a ScriptTag, or
  through a theme app embed whose handle is not listed for the entry (Hulk
  Product Options today): theme files do not hold it.

Embed signal limits:

- `disabled` is read as off only when it is the boolean `true` (what Shopify
  writes); an embed block in `presets` but not in `current` is not on.
- An enabled embed of an app that has since been uninstalled is still
  reported (Shopify keeps the block in `settings_data.json` but does not
  render it); the wording only says the embed is turned on.
- A `settings_data.json` that is missing, not valid JSON after the comment
  header, or has no `current.blocks` map gives no embed match.

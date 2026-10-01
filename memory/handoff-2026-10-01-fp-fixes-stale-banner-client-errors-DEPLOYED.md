# Session Handoff: 2026-10-01: FP fixes + stale banner + browser errors DEPLOYED (f5482ee)

Supersedes 2026-09-26 (+ addenda). Deployed 2026-10-01 ~15:25Z: CI + Deploy + smoke green; migration `20261001120000_add_shop_stale_results` applied (3 nullable Shop columns, verified); `/app/client-error` 401 with bad bearer vs 404 for a missing route.
Legal (data-integrity-suite) pushed first: `036ac9a` client error disclosure + `b9b22dd` privacy effective date October 1, 2026.

## Trigger
Digest 10-01: bad-hats-com installed 9/30 16:58Z, scan (Sugar Theme 1.3.0) found 2 findings, preview showed 1, clicked the upgrade ask and started a Standard trial at 16:59 (FIRST paid conversion ever), uninstalled 17:04. Both findings were false positives (seo_title captured just above <title>; 17TRACK script gated by section.settings in the theme's own order-tracking section).

## Shipped (f5482ee)
- gc-6lm `03c2360`: GHOST_TITLE/GHOST_OG: a variable assigned/captured earlier in the same file counts as resolved.
- gc-01n `6f7f746` + gc-vb7 `ee55158`: scripts / stylesheets / unknown resources inside a section.settings / block.settings / settings conditional are skipped (malicious detection excluded).
- gc-cpg `b6e9933`: Shopify global objects added to the shared title/og allowlist.
- Instagram signature `f5482ee`: only LightWidget + Instafeed (instafeed.nfcube.com); no instagram.com / window.instgrm / generic instagram-feed.
- gc-mgi `30cbe1c`: stale-results banner (theme published after the scan): Rescan now / next scan date / trial CTA (Free); Pro sees nothing; one upgrade ask per page; stale_results nudge telemetry.
- gc-nn6 `9a02b98` + audit M1 `32700a2`: browser errors, rejections, ErrorBoundary renders and failed same-origin fetches beaconed to OpsEvent client_error (sanitized both sides, 30/shop/h, pruned 30d, redact by domain); digest BROWSER line. Input to the scrubber is capped (quadratic email regex), and shpat_ tokens are redacted.
- Docs: gdpr rule exception for authenticateWebhookTolerant (gc-95f closed as dup of gc-4hk), auto-fix spike `docs/spikes/2026-10-01-theme-autofix.md` (parked gc-tib).
- Pre-deploy audit: SHIP, 0 HIGH. MED/LOW filed: gc-y3u (recall tradeoffs), gc-sbr (sanitizer/endpoint hardening).

## Exposure (prod read-only, 10-01)
7 of 8 scanned real stores show >=1 now-fixed FP in their STORED latest scan (gift-card title from pre-gc-j93 scans, seo_title captures, May-era og vars). All Free (no auto rescan). Owner decision: NO operator rescans (gc-qh1 won't-do); merchants rescan themselves. Free quota reset 10-01.

## Watch next
- Tomorrow's digest: new `Client errors` line (BROWSER block); stale_results funnel.
- Live click-through still pending: stale banner (Rescan now + trial link), review modal, return banner.
- de66e6-c4 webhook -> 200 + degraded row (gc-4hk live verify) still unobserved.

## Open / next
- gc-c4k P2: generic scriptPatterns (/vitals/, /fera/, ...) and snippetNames (route, cookie-consent, back-in-stock, ...): size prod exposure first. Likely the next FP source.
- gc-nbz P2: for-loop vars (`for image in product.images`) flagged in GHOST_OG.
- gc-fed P2: app embed off + script-tag sunset finding.
- gc-kes P3, gc-7am P3, gc-y3u P2, gc-sbr P3, gc-tib P3 parked.
- Push protection: never put a token-shaped literal in tests (build it at runtime).

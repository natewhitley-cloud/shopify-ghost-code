# Session Handoff: 2026-09-26 — onboarding fix, journey digest, nudge system DEPLOYED (fd616f1)

Supersedes 2026-09-23e. Deploys this session (all CI + Deploy + smoke green, migrations verified read-only):
- 2026-09-24 `6088f4a` gc-11f: capped vs scope-skipped checks (`Scan.cappedCategories`).
- 2026-09-24 `9798c5c` gc-97k.1/.3/.4: nudge telemetry, feedback nudge + MerchantFeedback, Free upgrade teaser.
- 2026-09-26 `fd616f1` (23 commits, 5 migrations 20260926120000..160000):
  - gc-bj4 first-load race (Home showed a DISABLED Start button when Shop row not yet upserted; root cause of ortho-india's 4-min uninstall "Not working properly with store").
  - gc-vg4 "Run your first scan" CTA on empty Scans/Ignored.
  - gc-0lo page_visit = first load per shop+path per 10 min (polling no longer inflates).
  - gc-dpm.1-3 durable Shop.firstOpenedAt/firstResultsViewedAt (backfilled; viewed only for sex-eshop + ortho-india, 14d history limit), ACTIVITY per-shop pages, JOURNEY funnel/stage/timeline.
  - gc-gre reconciler: expired refresh token -> `token_expired (dormant)` (de66e6-c4, refresh expired 2026-08-12); still probed, 404 marks; breaker denominator excludes dormant.
  - gc-97k.6 prompt cap: strict GLOBAL priority review_popup > upgrade_return > feedback, 1 slot per shop per 24h, 7-day bounded blocking; Home review banner RETIRED (column kept).
  - gc-97k.7 native `shopify.reviews.request()` once ever (terminal codes) on a later results visit (>=2h after first view, scan finished >=10 min ago); attempt claimed via nonce CAS; slot claimed at attempt, released on non-success.
  - gc-97k.8 trial CTA "Start 7-day free trial" unless `Shop.everPaidAt`/BillingEvent (backfilled; only internal dev store).
  - gc-97k.9 Free return-visit banner (>=24h after first scan, weekly, 3 dismissals, only when hidden findings) hides the inline teaser.
  - gc-97k.10 Free preview up to 5 findings, never over half; MALICIOUS_SCRIPT always shown, not counted.
- Legal (data-integrity-suite): b31a583 privacy+terms rewrite (gc-cg8); a417bf9 terms prices $9/$29 (also swept in another session's DedupeIQ privacy edits; owner OK'd leaving them live).

## Owner TODO
- Paste Managed Pricing Free card bullet 4: `Up to 5 findings shown in full` (Partner Dashboard > Pricing > Free).
- gc-cg8 residuals: sign Resend DPA; decide on cross-store aggregate ScanDomain use.

## Watch next
- Sun 2026-09-27 06:00Z weekly scan = first broad run of efa9493 detectors + new preview/nudges. Read Mon digest.
- Tomorrow's RECONCILER line should read `token-expired (dormant) 1`, `skipped-transient 0`.
- Live-unverified: review modal display, upgrade link top-level nav + click ping, return banner render. Need a real Free store click-through.

## Open
gc-zji (P3 differ re-counts capped as new), gc-dpm.4 (P4 Partner API uninstall reasons), gc-97k.5 (P4 deferred), gc-cg8 (owner items). ClearSignal local checkout diverged (4 unpushed incl. Guard, 23 behind, 65 dirty): untouched, needs owner reconciliation.

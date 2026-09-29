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

## Addendum 2026-09-27 03:41Z: `64b3715` DEPLOYED (gc-4hk P1 + gc-5l9)
- gc-4hk: webhooks 500'd for shops with a dead refresh token (library refreshes on every webhook; refresh failure = Response(500)); incl app/uninstalled + GDPR. `authenticateWebhookTolerant` re-validates HMAC and runs handlers without admin; one degraded webhook_failure row; digest shows "(degraded but handled: M)". Audit SHIP, no HMAC bypass.
- gc-5l9: one accessScopes query per scan; probe only granted optional scopes (no more 4x ACCESS_DENIED per scan).
- Live verify pending: next de66e6-c4 webhook -> 200 + 1 degraded row; next scan on a no-scope shop -> 0 ACCESS_DENIED in Partner logs.
- Churn: sex-eshop uninstalled 9/26 16:18Z "Not working properly" (stale 9/22 results with the pre-gc-j93 GHOST_TITLE FP as its only visible finding; Free quota blocked rescan; no server errors). Next batch: gc-mgi (stale-results banner), gc-nn6 (client error telemetry).
- Same webhook exposure in FraudPilot + ClearSignal (expiringOfflineAccessTokens): not fixed.

## Addendum 2026-09-29: competitive scan + new finding bead (gc-fed)
Installs are not public on the Shopify App Store; review count is the only proxy. Every direct competitor below has **0 reviews** (checked on each listing 2026-09-29). Ghost Code itself: launched 2026-04-30, 0 reviews.

| App | Launched | Price | Pitch / notable |
|---|---|---|---|
| [App Telemetry](https://apps.shopify.com/app-telemetry) (Red Van) | 2026-02-26 | Free 3 scans/mo; $19; $49 | Per-app speed impact, conflicts, leftover code |
| [Script Scan](https://apps.shopify.com/script-scan) (Matt Gibbins) | 2026-04-28 | Free 1 scan/quarter; $4.99; $14.99 (daily/weekly auto-scans) | Duplicate/orphaned scripts, read-only, health score |
| [GhostSweep](https://apps.shopify.com/ghost-sweep) (Timi Studio) | 2026-06-09 | $20/mo | Uses the phrase "ghost code"; 3 detection methods, Safe/Caution/Danger, PDF/JSON export, metafield cleanup, 8 languages |
| [Upright](https://apps.shopify.com/upright-cleaner) (Boostifyyy) | 2026-06-12 | Free; $7.99 | Dead code from uninstalled apps |
| [ScriptSweep](https://apps.shopify.com/scriptsweep) | 2026-07-01 | Free scan; paid full review | Review-first, never edits theme |
| [Residue](https://apps.shopify.com/theme-residue-cleaner) (Speedy Bloom) | 2026-07-03 | $49/yr | Removes code as a draft theme with backup; re-scans + alerts |
| [ThemeSweep](https://apps.shopify.com/themesweep) (JMS Dev Lab) | 2026-09-07 | Free; $9.99; $19.99; $39.99 agency | Backup + one-click rollback |
| [ThemeMedic](https://apps.shopify.com/theme-medic-1) | 2026-09-08 | Free; $7.99 ($59/yr) | File+line per issue, health score, wasted bytes |
| [BloatBuster](https://apps.shopify.com/bloatbuster-clean-theme-code) (RelayWorks) | 2026-09-16 | $6.99 | Removes leftover code/scripts |

- Read: category went from ~0 to 9 entrants in 7 months (3 in Sept 2026). Price anchors $5-20/mo; several AUTO-REMOVE with backup (Residue, ThemeSweep, BloatBuster), which Ghost Code does not. Ghost Code's differentiators to keep leaning on: 26 checks beyond scripts (translations, settings, store data), 100+ app signatures, MALICIOUS_SCRIPT always free. First real reviews decide ranking: review asks (gc-97k.7) matter more than new detectors.
- Deprecation hooks: `scriptTagCreate`/`Update` error from 2026-10-01; storefront script tags stop injecting 2027-03-01 ([changelog](https://shopify.dev/changelog/posts/online-store-script-tags-deprecation)). New bead **gc-fed** (P2): "script-tag sunset risk + app embed turned off" (settings_data.json app-embed `disabled:true` needs no new scope; ScriptTag API likely only returns the caller's own tags: verify).
- Source: next-bet research doc tab "Shopify deprecations as openings" (https://claude.ai/code/artifact/a6d971c7-e01d-4f7d-a3d8-ed39eec8f642).

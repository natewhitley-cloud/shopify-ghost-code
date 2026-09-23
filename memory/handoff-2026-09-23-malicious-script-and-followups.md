# Session Handoff: 2026-09-23 — MALICIOUS_SCRIPT detector + deep-dive follow-ups DEPLOYED

## What Got Done

- **DEPLOYED merge `9b2cfa1`** (2026-09-23 14:02 UTC). CI, Deploy, smoke all green; deployed SHA verified; migration `20260923120000_add_malicious_script_finding_type` applied; 0 error OpsEvents after deploy.
- **Post-deploy watch (to 14:18 UTC):** crons heartbeating on new code (watch-stale-scans 14:10, monitor-deep-health 14:15), 0 api_error/function_failure/worker_fallback/webhook_failure, no scans yet (detector not yet exercised in prod).
- **New `MALICIOUS_SCRIPT` finding type.** Trigger: new install sex-eshop (2026-09-22) had `shopify.jsdeliver.cloud/config.js` (fake jsDelivr, rogue "Product Network" app) that only surfaced as an "unknown script". Now: curated blocklist `app/data/malicious-domains.server.ts` (`jsdeliver.cloud`, `cb28utrk.com`), always HIGH, critical alert on the scan page listing every finding **in full on ALL plans incl. free, regardless of ignores** (owner directive: web safety + merchant trust).
- **Signatures:** 17TRACK, CJ Dropshipping added; Google Merchant Center widget is an exact-path BENIGN script (not an app signature: it minted false safe-to-remove ghosts).
- **Beads shipped + closed:** gc-5ha (reconciler first live run clean), gc-1gv (express/body-parser/qs/morgan), gc-m5d, gc-8s2, gc-i1n, gc-288, gc-dwp, gc-zeh.
- **Deep-dive #6–#19 triaged** into beads (label `deep-dive-2026-09-22`); remaining open: gc-b37 (#11/#12 hardening), gc-0lb (a11y), gc-cid (dead code).

## Key Decisions

- **Never-paywalled security findings.** Free preview slot and its ignore-fallback skip MALICIOUS_SCRIPT (no duplication); free upsell count excludes visible malicious rows (`freeTierHiddenFindingCount`).
- **Blocklist precision bar:** citable source per entry; never shared multi-tenant hosts; the azurefd.net `frontendInjection.js` host was LEFT OUT (thread ties it to Microsoft Clarity). Shopify publishes no IOC list.
- **gc-8s2:** bound memory DURING fetch (throw `ThemeTooLargeError` from `mapNode`, 50MB text) and fail non-retriably, instead of reviewer's "skip + record" (which would not bound memory and would distort cross-file detectors).
- **gc-288:** never-seen crons go to the NON-gating digest only. Wiring into /health/deep would fail the smoke gate on every deploy that adds a cron.
- **gc-i1n:** reused `notifyFunctionFailure` (no new OpsEvent type), floor `failed >= 3`, 24h dedupe on its own key `monitor-scan-failures:critical`.

## Patterns & Discoveries

- **The gc-zeh e2e test (fake Prisma that APPLIES `where`) found 2 real prod leaks** in domain-keyed streams that ignored `isInternal`: top pages and uninstall count. Masked only because dahi5e is also in the env list. Rule: domain-keyed event streams must be pinned to the filtered shop set (or include isInternal domains).
- **Adversarial audit found a HIGH in my own detector:** the stored snippet started one line early and the row previews 80 chars, so the domain was invisible on every plan. Unit tests passed; only a UI-level read caught it. Snippet now centred on the match.
- I committed gc-8s2 after targeted tests only; an integration mock broke. Run the FULL suite before each commit.

## Follow-up Beads (label `adversarial-audit-2026-09-23`)

- gc-3pd (P2) scan JSON templates/sections + assets/*.js for malicious domains
- gc-qqt (P3) >1MB padded file silently drops the alert
- gc-q8g (P3) heartbeat prune erases dead-cron evidence (keep newest per key)
- gc-d4e (P3) calibrate theme text cap vs real sizes + container memory

## Open Questions / Next

1. **sex-eshop merchant has not been notified.** The alert appears only after they rescan. Owner decision whether to reach out.
2. Rollback caution: after MALICIOUS_SCRIPT rows exist, rolling back to a pre-`9b2cfa1` image means an old Prisma client meeting an unknown enum value (UNVERIFIED). Prefer roll-forward.
3. Tomorrow's digest: verify the new RECONCILER section and that no NO HEARTBEAT line appears.
4. Stale beads: gc-4cv, gc-9ms (shipped in 95386b5), gc-1we (deferred, marked in_progress).

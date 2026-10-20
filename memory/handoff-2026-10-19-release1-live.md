## Session Handoff: 2026-10-19, release 1 LIVE + Start here cards

### RESUME HERE
Prod = a4bd069 (deploy + smoke + CI green, 2026-10-19 ~23:55Z). Extension version ghostcode-12 active
(rollback `shopify app release --version=ghostcode-11 --allow-updates`). Advisory flag
`APP_INCIDENT_ADVISORY_LIVE_ENABLED=true` on Railway since 22:50Z. Nothing in flight; tree clean.
Worktree `~/shopify/gc-5nok` (branch feat/gc-5nok-sidekick == origin/main). Next big item: release 2
"What changed" (gc-rrh.4 P1, gc-qafb P1, Sidekick get_recent_changes), spec `docs/specs/what-changed-release2.md`,
slices built sequentially, dark-data deploy first. Supersedes `handoff-2026-10-19-release1-ready.md`.

### What Got Done
- Release 1 shipped: Selly fix (gc-9ae6), Sidekick tools (gc-5nok, VERIFIED on prod by Nathan on nw-dev-store-2),
  plans (Pro 5 manual scans/UTC day, Standard monthly speed report, Free one-time test; gc-d0ui), Settings redesign
  (gc-4wvb), psew/cswd/wnhs, advisory embed handles + Swym/Selleasy/Hulk entries (gc-14x5.*, epic closed),
  named speed regressions (gc-vgqc), security-risk banner/tile/Theme health (gc-q5z8). Two audit rounds; no HIGH/MED open.
- Privacy policy LIVE eff. 2026-10-19 (data-integrity-suite 0b13f0a): Sidekick, Standard monthly speed, email speed for
  Standard + Pro named apps, server error records.
- Follow-up batch a4bd069: Start here as lane-coloured cards across (gc-g034, option A), Settings Permissions Status
  column aligned, Free plan tile bullet 7 "Malicious code and app incident alerts" (Sidekick now bullet 8).
- Listing (Nathan, live): description B ("Your theme gets slower and riskier as apps pile up..."), Free card security bullet.
  Proposed and liked but NOT confirmed applied: meta description "Keep your theme healthy: see which apps slow your store,
  flag malicious scripts and risky apps, and clean up leftover app code. First scan free." and title tag
  "Shopify Theme Health Check: Slow Apps, Risky Scripts". Feature bullets unchanged (bullet 5 still says weekly only).

### Key Decisions
- Sidekick ships straight to prod; Nathan tests there (memory feedback-sidekick-ship-to-prod-no-dev-test). After a release
  the admin must be hard-reloaded + new Sidekick chat, else "no available tools" and zero /api/sidekick calls.
- paw-naturals (bought "Unlimited scans") gets the 5/day cap with no notice; nudge later if needed.
- gc-w5mk (Free speed upsell names only Pro) deferred.
- Flag-off hides stored advisories at read time (`areStoredAdvisoriesShown`, `withoutHiddenAdvisories`); the runbook DELETE is
  REQUIRED after any flag-off following flag-on (leftover counts otherwise).
- Embed advisory fingerprint keys on the block type without uuid (snippet first line); host vs embed match of one app = different fingerprints by design.
- Malicious code in Start here = red "Security risk" card (`securityRisk` field), lane stays privacy.

### Patterns & Discoveries
- `shopify app deploy` non-TTY: `--no-release`, read diff via expect on `shopify app release` (output wraps 1 char/line; rebuild by joining), then `--allow-updates`. Hand-written extension uid was accepted.
- Prod curl to Shopify-auth routes needs a full Chrome UA (else 410). /health has no SHA; CI smoke checks /health/deep deployedSha.
- deploy.yml paths-ignore memory/**, docs/**, **/*.md: docs-only pushes do not deploy.

### In-Progress Work
None from this session. Stale "in_progress" beads from earlier sessions (features already live): gc-pa3q, gc-wt3y, gc-9mbw,
gc-iirv, gc-2wnf. Verify against prod and close them in the next session.

### Open Questions
- Listing feature bullet 5 ("weekly mobile speed report"): change to "See which apps slow your store, with weekly or monthly tests" (60)? Nathan's call.
- Release 2 start: confirm the spec's 7 slices order with Nathan before dispatch (spec decisions already approved: dark data first, builder footnote, speed shown not counted, plan cards at release 2).

### Open beads from this work (P3 unless noted)
gc-rrh.4 (P1), gc-qafb (P1), gc-xtno, gc-gxnp, gc-w5mk, gc-at1g, gc-b8s8, gc-gjn3 (P4), gc-0a3h, gc-n3in, gc-wcad,
gc-o7y7, gc-hlvu, gc-76dt, gc-ujsc, gc-nit6, gc-6yks.

### Recommended Next Steps
1. Watch the next scans with the advisory live: any APP_INCIDENT_ADVISORY findings in prod are real merchant hits; sanity-check each against the runbook (kill switch = flag false + DELETE).
2. Close the stale in_progress beads after checking prod.
3. Release 2: dispatch slice 1 of `docs/specs/what-changed-release2.md` (dark data) in a fresh worktree from origin/main.
4. ~2026-11-02: re-measure listing Google views vs the 10-11 baseline (memory ghostcode-seo-aeo-2026-10).

### Risks & Warnings
- First-Sunday speed cron now runs Standard + Pro single file (gc-76dt); fine below ~120 shops.
- Scan page and Speed page overflow at 390px (gc-o7y7, gc-hlvu), pre-existing.
- Preview harness: per-folder only (`~/shopify/gc-preview-harness/{settings,speed,risk,starthere}/`); root harness broken (duplicate React).

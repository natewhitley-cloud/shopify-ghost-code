# Session Handoff: 2026-09-16 (scan observability + GTM commit cleanup)

Repo: ~/shopify/ghost-code-app @ `10f82c0` (main). Working tree CLEAN, main in sync with origin/main. Deployed + smoke-verified on prod.

## What Got Done

1. **Marked ads + screenshots complete** in the prior handoff (`memory/handoff-2026-09-12-listing-ads-pricing.md`): screenshots reshot, then App Store Ads ($1-CPC Tier 1) went live. Correct order, stale-hero risk resolved.
2. **Committed the two GTM doc edits** (`docs/gtm/listing-v2.md`, `docs/pricing-and-plans.md`) + the 09-12 handoff note, after scrubbing the em-dashes I had introduced (kept the 2 char-count header dashes for sibling consistency). Commits `6606642`, `13b6019`.
3. **Shipped three scan-observability signals** (spec -> build -> adversarial audit -> deploy). Merged as PR #25 (`10f82c0`). Backend telemetry only: no merchant-facing change, no new scope, no PCD, no change to detection.
   - **ScanDomain** table: full non-Shopify third-party host graph per scan (matched-app / benign / unknown), the flywheel feedstock previously discarded.
   - **scan_signal OpsEvent**: per-scan detector histogram + theme shape (fileCount/scannable/skipped/benignSkips/unknownScripts/thirdPartyDomains) + durationMs. Best-effort, never fails a scan.
   - **Resolution tracking**: new/resolved/persisted finding counts via the existing `scan-differ` (honors skippedCategories/skippedFiles, LOG-4), surfaced as a `RESOLUTION (last 24h)` digest rollup.
4. **Spec**: `docs/specs/scan-observability-signals-spec.md`.

## Key Decisions

- **Serial implementation, not parallel** (despite user OK to parallelize): all three features converge on `scan-theme.ts` + `schema.prisma`, so parallel agents would clobber / produce conflicting migrations. Two serial agents: (1) schema+migration+models, (2) pipeline wiring + tests.
- **Hand-written additive migration** (`20260916115441_add_scan_signals`), not `prisma migrate dev` (hits the live prod DB). Matched the existing `NOT NULL` array-column convention (skippedFiles/skippedCategories) even though fresh Prisma omits NOT NULL: dropping it would make `sources` inconsistent with its sibling columns; `migrate deploy` applies files verbatim so no operational risk.
- **scan_signal metadata into OpsEvent.metadata (JSON), no schema change** for Feature 2. Emitted in the finalize step after all findings persist; detectorHits via a scan-scoped `finding.groupBy`.
- **Deferred retention pruning** (gc-26j) rather than pruning scan_signal now: pruning conflicts with the longitudinal analytics purpose, and per-shop deletion is handled by the redact fix.

## Patterns & Discoveries

- **The adversarial audit caught two real defects** a plain build would have shipped:
  - GDPR: scan_signal keys on `scanId` with `metadata.shopId` (internal cuid); `deleteShopData` purged OpsEvents by DOMAIN only, so those rows survived `shop/redact`. Fixed by adding a `metadata.shopId` OR-clause (`dc9b041`). Durable learning saved to global memory `new-opsevent-type-needs-redact-and-prune-coverage`.
  - Data quality: the `<link>` loop ran stylesheet/preconnect/font regexes independently on the same tag, so a Google-Fonts stylesheet double-counted refCount + emitted a phantom `font` source. Fixed with one-surface-per-tag precedence + `continue`.
- **CI gate (literal)**: `lint` -> `format:check` -> `typecheck` (`react-router typegen && tsc --noEmit`) -> `test` (vitest), each after `prisma generate`. `format:check` globs only `app`/`inngest`/`tests` `.ts` (docs/*.md NOT checked). Deploy is a separate `deploy.yml` on main: `railway up` (preDeployCommand runs `prisma migrate deploy`) then a BLOCKING smoke job (`/health/deep` all-green + deployedSha == github.sha).
- Tests pin a non-routable dummy `DATABASE_URL` (127.0.0.1:1); DB code is tested via mocks, so migrations never enter the test path.

## In-Progress Work

- **gc-1we (P1, in_progress)** external dead-man's-switch (Railway cron evaluates heartbeats independent of Inngest). PRE-EXISTING, NOT touched this session. Untouched; pick up fresh.

## Uncommitted Changes / Blocked

- None. Working tree clean, main == origin/main.

## Resumable Agents

- None. All dispatched agents (2 impl, 3 audit, 1 fix) completed.

## Open Questions

- **scan_signal retention (gc-26j, P2)**: prune vs downsample vs keep-all. Options: age-based prune (loses the longitudinal detector/theme-shape signal, the whole point), rollup into MetricSnapshot then prune raw, or keep-all with a monitored size budget. Criteria: scan volume growth. Decision deferred until volume is nontrivial (currently ~1 scan/day, mostly review-bot).
- **collectThirdPartyDomains re-walk (gc-4nw, P3)**: shares font/ajax/xhr regexes with GHOST_FONT/GHOST_AJAX over the same file content (~2x walk). Regexes are linear/ReDoS-safe; no action now. The new durationMs signal will make any large-theme regression self-evident. Revisit only if telemetry shows it.

## Recommended Next Steps

1. **Watch the daily operator digest** for the new signals landing on real scans: the `RESOLUTION (last 24h)` section, and query `OpsEvent where eventType='scan_signal'` / `ScanDomain` once real merchant scans accrue. At current volume (1 scan/day, review-bot dominated) the signals are live but the sample is near-empty. This was the original prompt that spawned the feature: "what can we learn from scans / what signal are we missing."
2. **Resume the GTM follow-ups** from `memory/handoff-2026-09-12-listing-ads-pricing.md`: (a) draft the checkout.liquid forum post (present-harm framing, sunset date passed); (b) work gc-oam (reframe stale in-app checkout.liquid copy, 4 files).
3. **gc-1we** (P1) external dead-man's-switch if prioritizing ops hardening.

## Risks & Warnings

- **`bd dolt push` may still be DOWN** (flagged in the 09-12 handoff). The two new beads (gc-26j, gc-4nw) and any bead state may be LOCAL-ONLY until the Dolt store is back. Re-check and sync.
- scan_signal + ScanDomain are LIVE but essentially unexercised until real merchant scan volume grows; treat any early readings as low-N.
- Follow-ups gc-26j / gc-4nw are intentionally deferred, not forgotten: revisit when scan volume grows.

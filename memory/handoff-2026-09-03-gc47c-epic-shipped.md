# Session Handoff: gc-47c Agentic AEO epic core SHIPPED (2026-09-03)

Prod: `affee33` (code identical to `a1915a4`; last two commits are memory/docs only). Health: OK. All gates green (2338 tests). Working tree clean, 0 unpushed.

## What Got Done
- **Deployed** the prior session's 4-commit Batch A/B (`feb23df`..`548f1ec`) at session start; CI+Deploy+smoke green.
- **Built + adversarially reviewed + merged + deployed** the gc-47c core:
  - `gc-47c.5` — AI-crawler `<meta name="GPTBot|ClaudeBot|…">` detection. Reused `GHOST_ROBOTS` (no migration). New `app/data/ai-crawlers.server.ts`. **LIVE.**
  - `gc-47c.10` — static-vs-live JSON-LD price detector via `read_products`. **INERT** (flag `JSONLD_LIVE_PRICE_ENABLED`=off + scope-gated). New `app/services/jsonld-price-audit.server.ts`; new scope-gated `product-price-audit` step in `inngest/functions/scan-theme.ts`.
  - `gc-47c.10` pre-activation hardening (bead `gc-1tr`) — gave the live-price audit its **own `FindingType.JSON_LD_PRICE_CONFLICT`** (additive migration `20260903120000_...`), THROTTLED retry in `runQuery`, `MAX_LOOKUPS` cap warn+skip.
  - `gc-47c.12` — GHOST_OG agentic "why it matters" copy in `app/lib/finding-remediation.ts`. **LIVE.**
- **Backlog reconciled**: closed 5 stale handoff beads (gc-4bg, gc-7wl, gc-qsy, gc-0ll, gc-pqq) + gc-1tr; deferred gc-hny + 6 children + gc-47c.6.

## Key Decisions
- **gc-47c.10 = Option B (static-vs-live), built defensively** (Nathan chose). Live product price via read_products; tight FP gate (compareAt/currency/variant/number-vs-string suppression); warn-only via env flag. Rejected: A (static-vs-static, low hit-rate) and C (defer).
- **gc-47c.10 fix #1 = own FindingType** (not a symptom patch). Root cause of the differ bug was sharing `JSON_LD_CONFLICT` across a scope-gated + non-scope-gated detector. Additive enum migration, prod DB NOT mutated (hand-authored SQL, applies on deploy).
- **gc-47c.6 kept PARKED** (critical-co-author call over literal "do it"): P4, value-unproven, blocked on the app-mutation research spike, and naive parsing risks FP on Shopify's default `robots.default_groups` template. Revisit only with (a) demand signal from .5 AND (b) the spike done.
- **.5 reused GHOST_ROBOTS**, **.6 (if ever built) also reuse it** — no new migration for the robots-family theme-file detectors (all non-scope-gated).

## Patterns & Discoveries
- **Adding a FindingType = wide blast radius**: prisma enum + hand-authored additive migration (NOT `migrate dev` — `.env`=PROD), TS-enforced `Record<FindingType,...>` maps (severity, finding.server x2, finding-consequence), string-keyed maps that are NOT TS-enforced (finding-classification, finding-remediation, route `FINDING_TYPE_LABELS`), and ~4 hardcoded `toHaveLength(N)` count-literal tests. In client routes use string-literal keys, never a `@prisma/client` enum VALUE import (bundle leak).
- **NEVER share a FindingType across a scope-gated and a non-scope-gated detector** — `scan-differ`'s `skippedCategories` is per-FindingType; a shared type gets worker rows miscounted as NEW/hidden when the scoped audit is skipped.
- **Worktrees branch from session-start HEAD**, not current main. `.12` built on a stale base (harmless, disjoint files); the `.10`-fixes agent self-corrected with `git reset --hard main`. Brief future worktree agents to verify base + reset when prior work merged.
- Worker→audit correlation: return a compact candidate list on `ScanResult` to cross the Inngest 4MB step-output limit.

## In-Progress Work
None. No in-progress beads, no resumable agents (all completed).

## Uncommitted Changes
None. Tree clean.

## Open Questions / Decisions for Next Session
- **Activate gc-47c.10?** Needs: a dev store with `read_products` granted + a theme carrying a stale static Product JSON-LD price. Steps: grant scope (App Bridge modal) → set `JSONLD_LIVE_PRICE_ENABLED=true` in Railway → redeploy/restart → scan. Criteria: confirm a `JSON_LD_PRICE_CONFLICT` fires and no FP on sale/compareAt/multi-variant. The GraphQL field shapes are mock-tested only — first live scan is the real proof. Known minor (P4, filed): thrown-throttle path busy-retries without backoff.
- **Close the gc-47c epic?** Only `.6`/`.11` remain, both deferred/parked. Core is complete. Decide close vs leave-open.
- **gc-06e (P0) vs gc-syz (P2) next?** Nathan deprioritized both this session, but gc-06e ("pre-ad-push hardening") is the P0 and gates ad spend; `gc-06e.7` (per-finding dismissal) is a ready P1. Revisit priority next session.

## Recommended Next Steps
1. **Live-scan verification** (`gc-fca`) on a dev store: Batch A/B labels + "Why it matters" line + `.5` AI-crawler meta finding + `.12` GHOST_OG copy + the 2 JSON-LD FP edges. This is the pending human eyeball for everything shipped since `548f1ec`.
2. **Reconsider gc-06e (P0) pre-ad-push hardening** — highest-priority backlog item; start `gc-06e.7` (per-finding dismissal) if resuming it.
3. **MEMORY.md compaction pass** — global index at ~19.8KB, near the 24.4KB limit; needs a deliberate one-line-per-entry pass (don't rush; risk of dropping context).
4. Optional: two P4 retro follow-ups (thrown-throttle backoff; derive `AGENTIC_IMPACT_TYPES` from module).

## Risks & Warnings
- `.5` + `.12` went LIVE this deploy without a dev-store eyeball yet (smoke passed, but merchant-facing behavior unverified) — that's step 1 above.
- `.10` is inert but its live GraphQL field shapes (`productByHandle`/variant sku/`availableForSale`) are only mock-tested; verified against 2026-04 API + `product-fetcher.server.ts` in review, but activation is the first real exercise.
- No dev/staging env — "live or it isn't." Verify via tests+build+smoke; deep behavior only confirmable on a real prod scan.

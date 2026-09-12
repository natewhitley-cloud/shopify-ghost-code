# Session Handoff: 2026-09-11 — 3 research beads (gc-b3c, gc-ku3, gc-y0i)

Overnight autonomous session. Worked the 3 research beads from the 2026-09-12 4th-app
decision, in priority order. **Nothing deployed — all changes are working-tree only** (per
Nathan's "no deploys tonight"). Gate is green end-to-end.

## TL;DR
- **gc-b3c (P1) — BUILT.** New `CHECKOUT_SUNSET` detector (Plus checkout.liquid sunset auditor).
- **gc-ku3 (P2) — BUILT (the buildable part).** New `JSON_LD_INVALID` detector + widened AI-crawler
  UA list. The single highest-value AEO move is a **flag-flip you must do (needs a deploy)** — see below.
- **gc-y0i (P2) — PAUSED/BLOCKED.** Honest feasibility spike killed the "just add axe-core" premise;
  needs a product decision on rendering infra. No code written. Bead marked `blocked` with rationale.
- Adversarial audit run (2+ features built): 1 confirmed data-honesty bug + 1 consistency issue,
  **both fixed**. Final gate: tsc 0, eslint 0, **vitest 2627/2627** (baseline was 2588).

## Verification gate (Node 24 — MANDATORY locally; repo is on Node 24, .nvmrc=24)
`npx react-router typegen` → `tsc --noEmit` (0) → `eslint . --max-warnings 0` (0) →
`prettier` (surgical) → `vitest run` **2627 passed / 101 files**. Confirmed by orchestrator on the
combined tree after all agents finished.

---

## gc-b3c — CHECKOUT_SUNSET (checkout-extensibility "what broke" auditor) — BUILT
Theme-file-only detector (scope `read_themes`, NO new scope), **plan-gated Standard+** (mirrors
`canDetectDanglingReferences`; Free gets zero). Severity **HIGH** (enum has no CRITICAL).

Two checks over already-fetched theme files:
1. `layout/checkout.liquid` present with non-trivial content → flags the ~Aug 13 2026 Plus hard-block.
2. Customization-depth signals inside it (`<script>`, tracking tokens, `{% render/include %}`,
   `content_for_*`) → ONE finding, dominant signal → `appName` subtype, all signals enumerated in
   `description` (mirrors DANGLING_REFERENCE's runtime-subtype pattern; no new DB column).

**Deliberately NOT built** (logged honest out-of-reach, like gc-47c.11):
- Additional Scripts / Order-Status / Thank-You scripts (Aug 26 2026 sunset) — **no GraphQL surface
  at any scope**. Genuinely unreachable.
- ScriptTag API usage (dies Mar 1 2027) — needs `read_script_tags` (we don't hold it). **v1.1
  candidate**: adding that optional scope converts this whole category from out-of-reach to
  detectable, and the scope-probe + skip-banner plumbing already exists. Cheap, justified — your call.
- Dropped the spike's `content_for_additional_scripts` residue check — that Liquid object is standard
  in nearly every theme layout → would false-positive.

**Honest limitation:** v1 only reaches the **Plus checkout.liquid** slice (~5,200 merchants, the
8-14%-conversion-drop cohort). Non-Plus merchants get nothing from this detector.

Files: new `app/services/checkout-sunset-detector.server.ts` (+ test), migration
`prisma/migrations/20260911140000_add_checkout_sunset_finding_type/`, plus the standard enum-exhaustive
touch points (schema, severity-classifier, finding-consequence, finding.server, finding-classification
[HEURISTIC + THEME_FILE], scan-detail label, finding-remediation), gate wired in
`inngest/functions/scan-theme.ts` core step, and `canDetectCheckoutSunset` in billing.server.ts +
plan-gating.server.ts.

**LATENT (verify on first live scan):** the spike could not confirm (read-only, no dev store) that
`OnlineStoreTheme.files` actually returns `layout/checkout.liquid` *body content* under `read_themes`.
Fail-safe: if it doesn't come back, the detector simply won't fire (no false positive). Eyeball on the
first Plus merchant with checkout.liquid.

---

## gc-ku3 — AEO / AI-discovery — BUILT (buildable part) + 1 ACTION FOR YOU
Audit finding: gc-ku3 is **mostly a re-prioritization of already-built INERT work**, plus a thin
net-new tail. The app has NO storefront HTTP fetcher (confirmed), so llms.txt / agents.md / rendered
robots.txt / GEO-citation-tracker are all out-of-reach (gc-47c.11/.6 stay parked).

Built tonight (both theme-file-only, all plans, no deploy needed):
1. **`JSON_LD_INVALID`** — flags STATIC `application/ld+json` blocks that fail `JSON.parse` (silently
   discarded today at scan-engine ~1105/1249). Invalid JSON-LD is dropped wholesale by Google + AI
   engines. **FP guard held under adversarial testing**: Liquid-containing blocks (`{{`/`{%`) are
   excluded via the SAME predicate the existing JSON-LD detectors use. Severity MEDIUM.
   Detector lives in `scan-engine.server.ts`; migration
   `prisma/migrations/20260911150000_add_json_ld_invalid_finding_type/`.
2. **Widened `AI_CRAWLER_USER_AGENTS`** (`app/data/ai-crawlers.server.ts`): added OAI-SearchBot,
   ChatGPT-User, Perplexity-User, Meta-ExternalAgent, Meta-ExternalFetcher, Amazonbot, cohere-ai,
   YouBot, Diffbot, Google-CloudVertexBot. Feeds `GHOST_ROBOTS` meta-tag detection automatically.

**>>> ACTION FOR NATHAN (highest-value AEO lever, needs a deploy — NOT done tonight):**
Activate `JSON_LD_PRICE_CONFLICT` (static-vs-live product price/availability). It is **already built,
hardened, merged, and sitting INERT** behind env flag `JSONLD_LIVE_PRICE_ENABLED` (OFF in prod).
Activation = grant `read_products` + flip the flag + redeploy + verify on a live store (GraphQL fields
are mock-tested only). Tracked by open handoff bead **gc-xel** (note: the memory phrase "gated on
gc-fca" is imprecise — gc-fca is a closed push bead; the real gate is the flag). Recommend a
soft-launch/premortem before flipping (RAW-affecting-ish; first live scan is the real test).

Parked (need a product decision, not built): JSON-LD ghost-entity (Product url/sku resolves to 0 live
products — Medium FP); Product JSON-LD completeness (missing price/brand/gtin — narrow + Medium FP).

---

## gc-y0i — Accessibility lane — PAUSED (product decision needed)
**Did not build. Bead set to `blocked` with a full comment.** The feasibility spike refuted the bead's
core premise ("same Playwright + axe-core stack"):
- App has **no** playwright/puppeteer/axe-core deps and **zero** storefront HTTP-fetch / rendering. It
  only sees raw Liquid/CSS/JS **source** via Admin GraphQL.
- axe-core needs a rendered DOM. The honest static-source subset is ~3-5 low-prevalence rules
  (html-lang, viewport zoom-block, positive-tabindex) that **miss color-contrast (the #1 real-world
  a11y failure) and all interactive naming/labeling** = low-single-digit % of WCAG.
- Shipping that under an "Accessibility" banner would violate the app's data-honesty culture AND the
  bead's own "~30% WCAG / never certify" liability guardrails. Worse than nothing.

**Nathan's instruction "build it for Standard/Pro"** is captured and ready to honor: plan-gating
(Standard+, `canDetectAccessibility` mirroring the others) and all detector touch points are mapped in
the spike — the blocker is purely the rendering-infra decision, not the packaging.

**Decision you owe:** does Ghost Code acquire rendering infrastructure (headless browser + storefront
URL fetcher + `@axe-core/playwright`)? If yes, a11y becomes a credible product and this unblocks. If
no, this bead should be closed as won't-do (a detect-only static a11y lane can't be honest). Note:
"Essentials" tier does not exist in code — plans are FREE / STANDARD / PROFESSIONAL; "paid tiers" =
Standard + Professional.

---

## Adversarial audit (code-reviewer, run because 2+ features shipped) — both issues FIXED
1. **CONFIRMED data-honesty bug** (checkout-sunset-detector): evidence snippet was picked from RAW
   content while signals were matched on comment-stripped content → a commented-out `<script>` could
   be shown as "proof" of a live-breakage finding. **Fixed**: `stripComments` now blanks comments
   line-number-preservingly; evidence anchors to the dominant signal in the stripped view. Regression
   test added.
2. **Consistency** (JSON_LD_INVALID SIGNATURE→HEURISTIC): it was placed in SIGNATURE with an ad-hoc
   carve-out, but the module's documented axis is app-attribution (not certainty), and siblings
   DANGLING_REFERENCE/CHECKOUT_SUNSET are HEURISTIC. **Fixed**: moved to HEURISTIC, reverted the
   doc-comment broadening. (Override if you'd rather redefine the axis semantics + badge copy instead.)

Audit areas A(FP guard)/C(plan-gating)/D(enum-exhaustiveness)/E(migration safety)/F(copy honesty)/
G(crawler list) all verified SOLID.

---

## Housekeeping / risk
- **Beads `bd dolt push` still failing ("no store available")** — creates/updates (incl. gc-y0i
  blocked status + comment) are LOCAL ONLY. Re-push when the shared Dolt sql-server is up or they won't
  propagate. (Same as prior handoffs.)
- Two new additive enum migrations are staged (`ADD VALUE IF NOT EXISTS`), un-applied. They apply on
  next deploy via the self-migrating `preDeployCommand` (`prisma migrate deploy`). **Additive +
  reversible; deploy whenever you're ready — not tonight.**
- Change set: 19 tracked files modified + 4 new untracked (2 detectors/tests, 2 migration dirs).
  Verified surgical, no test-file clobber.
- Node 24 required for all local gate commands (`nvm use 24`).

## Suggested next steps (your call)
1. Review + deploy the two new detectors (gc-b3c, gc-ku3 JSON_LD_INVALID + crawler list) — one batched
   push, self-migrating.
2. Decide on the `JSON_LD_PRICE_CONFLICT` activation (gc-xel) — highest AEO ROI, needs premortem +
   flag flip + read_products grant.
3. Decide gc-y0i rendering-infra question (unblock or close won't-do).
4. Consider the `read_script_tags` v1.1 scope for gc-b3c ScriptTag coverage (Mar 1 2027 wave).

# Session Handoff: 2026-09-18 — Competitive epic (gc-rrh) + pricing

## What Got Done
Shipped 3 competitive-epic features to a branch, each with an adversarial audit and all confirmed findings fixed:
- **gc-rrh.1** — Pro-only PDF export + enriched JSON/CSV (health score + description). Audit caught + fixed: detector-adjacent export FPs, dashboard/export ignore-filtering drift, sync-render cap, non-Latin fonts.
- **gc-rrh.3** — duplicate tracking-tag (`DUPLICATE_TRACKER`) + overlapping chat-widget (`OVERLAPPING_CHAT_WIDGET`) detectors, theme-file-only, distinct-ID high-precision. Audit caught + fixed a real FP class (context-free/comment-blind/all-files matching) → aligned with engine gating (isScannableFile + buildCommentSkipLines + tracker context).
- **gc-rrh.5** — "before you uninstall" lean reframe of the App Impact Map + `?app=` filter. Audit caught + fixed: drill-down invisible (preventScrollReset), banner over empty results / free wall, copy overclaim.
- **Pricing** — made the reprice branch deploy-ready (see Risks).

Filed follow-up beads: gc-rrh.6 → BLOCKED; gc-rrh.7/.8/.9/.10 new. Saved memory `ghost-code-runtime-image-excludes-app-dir`.

## Branch States (ALL local, unpushed, undeployed)
- **`feat/gc-rrh-competitive`** (current, 6 commits on top of main): 2d43177 gc-rrh.1 · 71ba0a4 gc-rrh.3 · cac8f2d audit-fixes(1&3) · e599919 PDF fonts · 900585e gc-rrh.5 · c396b07 gc-rrh.5 audit-fixes. **Green: 2724 tests, typecheck, lint, build.** Renamed from `feat/gc-rrh.1-pdf-export`.
- **`chore/pricing-9-29-and-digest-7mt`** (3 commits): bc673bc digest→7MT · d313c42 PLAN_AMOUNTS $9/$29 · 95cbfcd (NEW this session) settings.tsx display $9/$29 + 3 stale reconciler test assertions. **Green, deploy-ready.**
- **`main`**: 2 unpushed docs commits (755a8af, a8aec4d). PLAN_AMOUNTS still $29/$49 here.

## Key Decisions
- **gc-rrh.1 gating = 1A**: JSON/CSV stay both paid tiers; PDF = Pro-only (`canExportPdf`). No regression. (Rejected: all-export-Pro-only = Standard regression.)
- **gc-rrh.3 = theme-file-only (1A) + distinct-ID precision (2A)**: flag only 2+ DISTINCT platform IDs (two GA4/GTM/Meta). Runtime/Web-Pixels deferred (gc-rrh.7). (Rejected: function-presence matching = FP-prone.)
- **gc-rrh.5 = lean reframe (A)**: spike proved the literal feature isn't buildable (can't list installed apps — `appInstallations` is Shopify-internal-only; can't tell installed vs uninstalled). Predictive catalog = gc-rrh.9. (Rejected: predictive-now = no data + no install list.)
- **gc-rrh.6 = BLOCKED**: needs perf measurement (Lighthouse/render/weight) the theme-file scanner lacks (grep-confirmed zero perf capability). Feasible cousin = gc-rrh.10 (lazy-load LCP detector). (Rejected: weak heuristic paradox detector = misleading.)
- **PDF fonts = 6A**: commit Noto Sans TTFs (Latin/Cyrillic/Greek), degrade note for CJK/Arabic/emoji. Full CJK = gc-rrh.8. (Rejected 6D full-CJK = 10-16MB bundle.)

## Patterns & Discoveries
- **Backlog lags code (again)** — gc-rrh.1 ("we have none" but CSV/JSON existed), gc-rrh.3 (DUPLICATE_LIBRARY + tracker signatures already existed), gc-rrh.5 (feature not buildable as described). TRUST CODE; spike before building each.
- **Runtime Docker image excludes `app/`** — reads of committed assets at runtime need a Dockerfile `COPY` (see PDF fonts). Saved to memory.
- **Adversarial audit of same-agent code is high-value** — 3 audit rounds each found real issues the code's own tests missed (tests encode the same wrong assumptions). Notably the gc-rrh.5 preventScrollReset bug I *introduced* by over-applying the systemic guard — it's NOT universal.
- **New FindingType registration checklist** (mirror DUPLICATE_LIBRARY): schema enum + hand-written additive migration + severity-classifier + finding-classification (3 sets) + consequence + remediation + finding.server zero-map + FINDING_TYPE_LABELS. Exhaustive `Record<FindingType,…>` maps make typecheck enforce completeness.
- **Prisma branch-switch dance** — the feature branch adds 2 FindingType enum values; `node_modules/.prisma/client` is shared across branches. After switching between feature branch and pricing/main, MUST `npx prisma generate` or typecheck throws phantom exhaustiveness errors.

## In-Progress / Ready Work
- **gc-1we** (P1, in_progress, UNTOUCHED all session): external dead-man's-switch (Railway cron heartbeat eval, closes review H3). Fresh pickup.
- **gc-rrh.1/.3/.5** all `in_progress` — code done + committed local; keep in_progress until merged + deployed.

## Recommended Next Steps (Nathan's stated priorities first)
1. **Deploy the reprice** (Nathan already set Dashboard → $9/$29). Merge + deploy `chore/pricing-9-29-and-digest-7mt` so code (PLAN_AMOUNTS + settings.tsx display) matches the live Dashboard. This closes the drift. Then optionally merge/deploy `feat/gc-rrh-competitive` (independent). **Watch the Prisma branch-switch (`npx prisma generate`).** gc-rrh.3's additive enum migration self-applies on Railway deploy.
2. **Triage the 2 unknown scripts** from the digest (signature flywheel; low/normal volume).
3. **gc-1we** (P1) — the dead-man's-switch, still untouched.
4. Live attribution verification (PR#26) — still PENDING, needs Railway login refresh.

## Open Questions
- **Deploy sequencing / branch bundling** (`feat/gc-rrh-competitive` bundles 3 features + audit fixes): deploy as one branch (aligned with GitHub-Actions conservation) or split gc-rrh.3 out for independent rollout? Criteria: risk appetite for shipping 3 features at once vs Actions cost. Decide at deploy time.
- **Pricing vs feature deploy order**: pricing branch is the urgent one (live Dashboard drift). Feature branch can follow. Don't stack both blind.

## Risks & Warnings
- **Live pricing drift RIGHT NOW**: Dashboard = $9/$29 (Nathan set it), but deployed `main` still shows $29/$49 (settings.tsx) and records $29/$49 (PLAN_AMOUNTS). Deploy the pricing branch to resolve. "Fine until deploy" per Nathan.
- **Everything unpushed + undeployed** — 3 branches with local-only work.
- **Prisma branch-switch requires `npx prisma generate`** (see Patterns) — else false typecheck failures.
- **gc-rrh.3 ships a Prisma enum migration** — additive `ADD VALUE IF NOT EXISTS`, self-applies on deploy; safe/irreversible-forward.

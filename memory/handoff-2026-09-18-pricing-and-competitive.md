# Session Handoff: 2026-09-18 — Pricing repricing + competitive roadmap

## What Got Done

- **Operator digest cron moved 8:00 → 7:00 AM MT** (`inngest/functions/operator-digest.ts`; cron + doc comment). `TZ=America/Denver` keeps it DST-correct; trailing-24h window loses no data.
- **Repriced Standard $29 → $9 and Professional $49 → $29** after competitive research.
  - Code: `app/lib/billing.server.ts` `PLAN_AMOUNTS` (9/29).
  - Tests: 4 assertions updated in `tests/lib/billing.test.ts` + `tests/inngest/operator-digest.test.ts`. Both suites green (94 passed).
  - Doc: `docs/pricing-and-plans.md` — tier headers, options section, and a full decision-log entry with the comp table + code-sync caveat.
- **Committed on branch `chore/pricing-9-29-and-digest-7mt`** (2 commits: `bc673bc` digest, `d313c42` pricing). NOT pushed, NOT deployed.
- **Committed on main** earlier (not pushed): `a8aec4d` — the 4 pre-existing handoff/review files.
- **Beads filed:** `gc-3s9` (ClearSignal nudge/telemetry port, P3) and epic `gc-rrh` + 6 children (competitive differentiation).

## Key Decisions

- **Prices → $9 / $29 (land-grab), not $19/$39.** Direct-category comps (Residue ~$4/yr-equiv, Script Scan $4.99/$14.99, GhostSweep $20 flat) top out at $20 and **all have 0 reviews** — no proven WTP, no pricing power pre-reviews. Chose lowest defensible price to buy install velocity → reviews → social proof, then raise (grandfather early merchants). Rejected: $29 (above whole range), $19/$39 (above median), sub-$9 (signals "toy," won't cover Admin-API broken-link cost).
- **$9 is the defended floor.** Standard makes real Admin-API calls (broken-link verification); weekly scan cap bounds cost so $9 works, $4.99 wouldn't.
- **Auto-remediation stays KILLED** as a differentiator (per `product-strategy.md:135` — Cleanify Code delisted for FP removals; revisit only after 500+ installs, zero FP reports). Counter-positioning instead: "detection so good removal is a 2-min dev job; we won't touch your live theme."
- **Themediff → build as *attributed* change tracking, not commodity diff** (gc-rrh.4). Generic diff is a $5 commodity; our edge is the PR#26 filename-attribution engine — diff + attribute each change to its causing app.

## Patterns & Discoveries

- **`PLAN_AMOUNTS` is a hand-maintained mirror of Partner Dashboard Managed-Pricing** (`billing.server.ts:86-94`). It feeds `BillingEvent.amount` AND the operator-digest MRR. Runtime cannot detect value drift. **Price changes MUST flip code + Dashboard in the same window** or billing records/MRR silently drift.
- Managed Pricing means dollar amounts live in Partner Dashboard, not in `shopify.server.ts` (grep for prices there returns nothing). Only `PLAN_AMOUNTS` mirrors them in code.
- `product-strategy.md` is rich and already contains several roadmap ideas I re-surfaced (before-you-uninstall scan L195, speed-optimizer paradox L197, Theme Performance Impact Score already shipped L150).

## In-Progress Work

- **gc-1we (P1, in_progress, untouched this session):** External dead-man's-switch — Railway cron evaluates cron heartbeats independently of Inngest (closes deep-dive review H3). Pick up fresh.

## Uncommitted Changes

- None. Working tree clean.

## Deferred / Not Done

- **Live attribution verification (carried from 2026-09-17 handoff, still PENDING):** filename-attribution shipped (PR#26) + unit-tested but no real prod scan has exercised it. Resume: `railway login` (expired) → trigger scan on `nw-dev-store-2` → `scripts/review-latest-scan.ts` to confirm spreadr* findings attribute to Spreadr AND that ScanDomain/scan_signal populate on first instrumented run.

## Resumable Agents

- None dispatched this session.

## Open Questions

- **Pricing deploy timing (`billing.server.ts` + Partner Dashboard):** the $9/$29 code change on branch `chore/pricing-9-29-and-digest-7mt` must go live in the SAME window as Nathan's Partner Dashboard Managed-Pricing edit. Decision: when to merge+deploy the branch. Criteria: Nathan flips Dashboard → merge branch → deploy together. Until then billing records would drift if only one side changed.
- **gc-rrh.2 gating (Standard vs Pro):** should email alerts on new findings be a Standard or Pro feature? Criteria: whether alerts are a "stay-informed" baseline (Standard) or a "monitoring" power feature (Pro). Resolve when scoping gc-rrh.2 alongside gc-3s9.

## Recommended Next Steps

1. **When ready to reprice:** Nathan edits Partner Dashboard Managed Pricing to $9/$29, then merge `chore/pricing-9-29-and-digest-7mt` → deploy (Railway auto-deploys main). Both price sides go live together. The digest 7-MT change rides along in the same branch.
2. **Live attribution verification** — highest-value technical debt: `railway login` → scan `nw-dev-store-2` → `scripts/review-latest-scan.ts`.
3. **gc-1we (P1)** — external dead-man's-switch, fresh pickup.
4. **Competitive roadmap** — `gc-rrh` epic; start with gc-rrh.1 (export, cheapest parity gap) and gc-rrh.2 (email alerts, coupled to gc-3s9).

## Risks & Warnings

- **Price code/Dashboard drift** — see open question #1. The single biggest risk in this session's work. Do NOT deploy the pricing branch until the Dashboard is flipped (and vice versa).
- **Branch not pushed** — `chore/pricing-9-29-and-digest-7mt` (2 commits) and main's `a8aec4d` exist only locally.
- **Digest 7-MT is bundled with pricing on the same branch** — if you want to ship the cron change independently of the reprice, cherry-pick `bc673bc` to its own branch first.

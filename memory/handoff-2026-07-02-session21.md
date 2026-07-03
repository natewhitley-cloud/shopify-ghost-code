# Session Handoff: 2026-07-02 (session 21)

Focus: GC-89k billing plan-state correctness after the Shopify App Pricing webhook deprecation.

## What Got Done
- **GC-89k shipped + deployed live** (`17af54c`, deploy + blocking smoke + CI all green). Redirect fast-path so an upgraded merchant is granted immediately instead of waiting up to 6h.
- **Pushed the S20 docs commit** (`416c969`) — deploy green.
- **Closed the beads-lineage reconciliation** (owner decision): use the live Beads DB as-is as the single source of truth (169→171 issues). Deleted the stray `docs/backlog-live-168-2026-07-01.json` export.
- **Filed `GC-fir`** (P2) — deferred Partner API `activeSubscription` migration.

## Key Decisions
- **C1 over C2/C3 for GC-89k**: redirect fast-path + 1h Admin-API reconcile backstop, using **GA-only APIs**. Rejected C2 (Partner API `activeSubscription`) because it's only in the **2026-07 release candidate** and needs a new org-cred auth pattern; rejected C3 (docs-only) because it left the up-to-6h under-grant window open.
- **`plan_handle` as a trigger, never a source of truth**: it's an *unauthenticated* URL param (a merchant could hit `/app?plan_handle=Professional`). Its presence forces an immediate reconcile; the Admin API `activeSubscriptions` query remains the sole authority for the tier. Rejected: mapping `plan_handle`→tier and writing it directly (security hole).
- **Beads-lineage: stop reconciling, use bd as-is** — the git-JSONL-vs-Dolt divergence was closed as "little value," Beads is now canonical.

## Patterns & Discoveries
- **App Pricing webhook is DEAD as of 2026-04-28** — `APP_SUBSCRIPTIONS_UPDATE` no longer fires. Verified against shopify.dev. This app's primary plan-state writer AND sole `recordBillingEvent` caller was silently dead → two bugs (under-grant on upgrade + billing-event analytics stopped).
- **Admin API `activeSubscriptions` still works** for App Pricing — docs only say the Partner API is "more accurate/persistent," not that the Admin query is broken. The bead's "scattered empty-array reports" framing was not the real issue.
- **Partner API `activeSubscription` / Historical Events are 2026-07 RC only** (not GA) as of today.
- Full details captured in the `gdpr-and-billing.md` rule (rewritten) + global memory (`shopify-app-pricing-webhook-deprecation.md`, flagged portfolio-wide).

## In-Progress Work
- **GC-89k** (stays OPEN): code shipped, but two **manual QA gates** remain (require a real store — cannot be done from a dev session):
  1. Confirm the Partner Dashboard per-plan **Welcome link** resolves to a path **under the `/app` layout**, so `app/routes/app.tsx`'s loader receives `plan_handle`. (If misconfigured, the 1h reconcile still backstops it — degraded, not broken.)
  2. Run a real Managed Pricing **upgrade on a dev/test store** and confirm the tier applies immediately on redirect.
  - Close GC-89k once both pass.

## Uncommitted Changes
- `memory/team/retro-history.md` + `memory/handoff-2026-07-02-session21.md` — session retro/handoff docs, committed locally this session but **left unpushed** (push triggers a full deploy; owner controls timing per S20 norm).

## Blocked Work
- **GC-fir** (P2): Partner API canonical-source migration — blocked on the Active Subscription API reaching **GA** (currently 2026-07 RC). Do not start until GA; verify at shopify.dev/docs/api/partner.

## Resumable Agents
- None. The single implementation agent (general-purpose, `a2adc1596820ccd29`) completed and its output was reviewed + committed.

## Open Questions
- None blocking. The only pending items are the two GC-89k manual QA gates (above), which are decidable by the owner running them on a store.

## Recommended Next Steps
1. **Run the two GC-89k manual QA gates** (welcome-link route under `/app`; live upgrade test), then `bd close GC-89k`.
2. **`GC-rcj` + `GC-fh0`** (P1, Partner Dashboard app name + PAS-style description) — the highest-leverage live-merchant "SEO/listing" work; not time-critical.
3. **Push the local retro/handoff docs** when ready for the (docs-only) deploy.
4. Portfolio follow-through: `tax-integrity-app` carries the same App Pricing webhook-death risk (`tax-integrity-monitor-qkq`).

## Risks & Warnings
- **Every push to main triggers a full production deploy** (docs included) + the blocking smoke gate.
- **Billing code is now live for real merchants.** The fast-path's instant-grant value is unrealized until GC-89k gate 1 (welcome-link route) is confirmed — but the 1h reconcile backstop means the deploy is safe regardless.
- No auto-rollback on the smoke gate — a red smoke reddens main but doesn't revert; a manual revert is needed if prod breaks.

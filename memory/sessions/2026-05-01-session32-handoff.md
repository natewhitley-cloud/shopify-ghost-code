## Session Handoff: 2026-05-01 (session 32) — Launch day + security remediation + trend chart

### What Got Done

1. **Ghost Code approved and live** — app published on Shopify App Store
2. **Billing test mode disabled** — `SHOPIFY_BILLING_TEST=false` set in Railway
3. **Inngest CVE remediated** — upgraded SDK from vulnerable pre-3.54 to 3.54.0; rotated all 4 secrets (SHOPIFY_API_SECRET, TOKEN_ENCRYPTION_KEY, INNGEST_SIGNING_KEY, INNGEST_EVENT_KEY)
4. **Worktrees cleaned up** — 6 accumulated agent worktrees removed; `shopify app deploy` run to restore production URL after tunnel URL was left behind
5. **Railway env vars set** — ADMIN_SHOP_DOMAINS=nw-dev-store-2.myshopify.com, ENABLE_TREND_CHART=true
6. **Trend chart redesigned** — switched from health-score bars (useless at 0) to stacked findings bars (High/Medium/Low), with clipPath for consistent rounded corners, thin centered bars, per-segment counts, findings-based direction logic
7. **CI fixed** — direction tests updated to use findings-based logic after score-based mocks broke
8. **Backlog cleaned** — 8 stale pre-launch issues closed in dolt; 4 real ones remain

### Key Decisions

- **Trend chart metric**: Total findings (not health score). Score floors at 0 for themes with many findings, making chart invisible. Findings count is always meaningful.
- **Stacked bar order**: Low (top, blue) → Medium (yellow) → High (bottom, red). Most severe = heaviest/bottom.
- **Direction logic**: Fewer findings = improving (inverted from score logic).
- **clipPath for rounding**: Single clipPath per bar group instead of rx on each segment — only outer corners round, segment joints are clean.

### In-Progress Work

None — all changes committed and pushed.

### Uncommitted Changes

None.

### Blocked Work

- **EIN**: IRS said call back later (system not ready). Retry 1-800-829-4933 or online at irs.gov. Needed before W-9 to Shopify and before payouts.
- **Sentry**: No account set up yet. SENTRY_DSN still unset in Railway (app runs without it, errors just go unmonitored).

### Open Questions

- When will EIN be obtainable?
- Any real merchants installed yet beyond dev store?

### Open Backlog (4 issues)

| ID | Title | Notes |
|----|-------|-------|
| 6gh.40 | Run performance + compatibility audit | Never done pre-launch |
| 6gh.67 | Add Sentry error reporting | Blocked on Sentry account |
| rb3 | Active upsell: notify when paid feature would have applied | Product feature |
| sg5 | Pro: auto-scan on app uninstall | Product feature |

### Risks & Warnings

- **EIN/W-9 not submitted to Shopify** — no payouts until resolved
- **BOI report with FinCEN due ~late June 2026** — within 90 days of LLC formation (2026-03-27)
- **Sentry unmonitored** — errors in production are invisible until SENTRY_DSN is set
- **Dolt server must be started manually** — `dolt sql-server --data-dir .beads/dolt --port 3307 &` at session start; bd returns 0 silently if not running
- **1 merchant currently** (dev store) — no real merchant data yet

### Recommended Next Steps

1. **EIN** — retry IRS online or call 1-800-829-4933; then W-9 to Shopify Partner Dashboard
2. **Week 1 forum blitz** — r/shopify, Shopify Community forums, relevant Facebook groups
3. **$100 App Store ad credit** — activate in Partner Dashboard (Month 1)
4. **Sentry setup** — create account, get DSN, set in Railway
5. **Performance audit** (6gh.40) — run Lighthouse before/after install comparison
6. **BOI report** — file at boiefiling.fincen.gov before late June

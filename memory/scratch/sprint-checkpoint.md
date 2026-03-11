# Sprint Checkpoint — Wave 4

## Status
- Phase 0: Complete (Light load)
- Phase 1: Complete (all context loaded)
- Phase 2: Complete (plan approved)
- Phase 3: IN PROGRESS (batch 5 ready)

## Batch 1 — COMPLETE
- Scaffolder (.7+.9+.10): DONE — Prisma schema, shopify.app.toml, Inngest setup
- Implementer (.20+.22): DONE — GDPR webhooks, billing plans
- Learnings updated, beads closed

## Batch 2 — COMPLETE
- Implementer (.8+.23): DONE — data access layer + feature gating
- Tester (.33): DONE — Vitest setup + mocks
- Scaffolder (.36+.38): DONE — Railway deployment + ESLint/Prettier

## Batch 3 — COMPLETE
- Implementer (.11+.12+.13): DONE — theme fetcher, scan engine, app signatures + 92 tests
- Implementer (.15+.17+.18): DONE — dashboard, scan history, scan detail routes
- Scaffolder (.37): DONE — GitHub Actions CI/CD

## Batch 4 — COMPLETE
- Implementer (.14+.21): DONE — Inngest scan-theme function + uninstall webhook
- Implementer (.24+.30): DONE — settings route + error boundaries
- Reviewer (.25): DONE — session token audit + CSP verification (all pass)

## Also closed (already done)
- .6 (scaffold — manual), .31 (indexes — from .7), .34 (tests — from batch 3)

## Beads Closed So Far
- .6, .7, .8, .9, .10, .11, .12, .13, .14, .15, .17, .18, .20, .21, .22, .23, .24, .25, .30, .31, .33, .34, .36, .37, .38 (25 closed)

## Key Learnings from Batch 4
- Admin clients not serializable across Inngest steps — create inside each step
- CSP handled by SDK's addDocumentResponseHeaders — no manual config needed
- app/uninstalled fires immediately, shop/redact fires 48h later — both need cleanup

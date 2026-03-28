# Ghost Code — Pre-Submission Checklist

Master checklist for Shopify App Store submission readiness. Consolidates requirements from definition-of-done, E2E test checklist, GDPR/billing rules, app listing guide, and founder playbook.

**Target**: Submit for Shopify app review once all sections are complete.
**Last updated**: 2026-03-27

---

## 1. Legal Entity & Business ⏳ IN PROGRESS

| #   | Item                         | Status       | Notes                                                                              |
| --- | ---------------------------- | ------------ | ---------------------------------------------------------------------------------- |
| 1.1 | LLC formed                   | ⏳ Submitted | Alpenglow Software LLC — filed 2026-03-27, expected by 2026-04-01                  |
| 1.2 | Domain registered            | ✅ Done      | `alpenglowsoftware.com` via Northwest (1st year free)                              |
| 1.3 | Support email set up         | ✅ Done      | `support@alpenglowsoftware.com`                                                    |
| 1.4 | EIN obtained                 | ⬚ TODO       | After formation docs return. IRS.gov, free, 10 min                                 |
| 1.5 | Business bank account opened | ⬚ TODO       | After EIN. Bring Articles of Organization + EIN                                    |
| 1.6 | Operating Agreement signed   | ⬚ TODO       | After formation docs. Add IP Assignment clause (see `strategy/llc-setup-guide.md`) |
| 1.7 | BOI Report filed with FinCEN | ⬚ TODO       | Within 90 days of formation                                                        |

---

## 2. Legal Docs ⏳ IN PROGRESS

| #   | Item                                          | Status  | Notes                                                                                |
| --- | --------------------------------------------- | ------- | ------------------------------------------------------------------------------------ |
| 2.1 | Privacy Policy published                      | ✅ Done | `data-integrity-suite/ghost-code/privacy.html` — updated with Alpenglow Software LLC |
| 2.2 | Terms of Service published                    | ✅ Done | `data-integrity-suite/ghost-code/terms.html` — updated with Alpenglow Software LLC   |
| 2.3 | Privacy Policy URL set in Partner Dashboard   | ⬚ TODO  | Point to GitHub Pages URL                                                            |
| 2.4 | Terms of Service URL set in Partner Dashboard | ⬚ TODO  | Point to GitHub Pages URL                                                            |
| 2.5 | Partner Dashboard contact info updated        | ⬚ TODO  | After LLC confirmed — update business name, support email                            |
| 2.6 | W-9 submitted to Shopify with EIN             | ⬚ TODO  | After EIN — required before receiving payouts                                        |

---

## 3. Technical Compliance ✅ VERIFIED (2026-03-27)

These are the items that cause >60% of app review rejections. All 13 passed audit.

| #    | Item                                                | Status  | Notes                                                      |
| ---- | --------------------------------------------------- | ------- | ---------------------------------------------------------- |
| 3.1  | GraphQL only (no REST calls)                        | ✅ Pass | All calls via `admin.graphql()`                            |
| 3.2  | Session token auth (no cookies, no OAuth redirects) | ✅ Pass | `authenticate.admin()` on all routes                       |
| 3.3  | GDPR webhook: `customers/data_request` responds 200 | ✅ Pass | Handler in webhooks.tsx                                    |
| 3.4  | GDPR webhook: `customers/redact` responds 200       | ✅ Pass | Handler in webhooks.tsx                                    |
| 3.5  | GDPR webhook: `shop/redact` responds 200            | ✅ Pass | Transactional deletion via deleteShopData()                |
| 3.6  | HMAC signature verification on all webhooks         | ✅ Pass | SDK `authenticate.webhook()` handles this                  |
| 3.7  | Billing API via GraphQL `appSubscriptionCreate`     | ✅ Pass | SDK `billing.request()` wrapper                            |
| 3.8  | Feature gating behind active subscription check     | ✅ Pass | `canStartScan()`, `canViewFindingDetails()` enforce quotas |
| 3.9  | Embedded via App Bridge (latest CDN version)        | ✅ Pass | `embedded=true`, AppProvider with apiKey                   |
| 3.10 | Minimal access scopes (only `read_themes`)          | ✅ Pass | `read_themes` required + optional scopes                   |
| 3.11 | App uninstall webhook cleans up shop data           | ✅ Pass | `app/uninstalled` webhook calls deleteShopData()           |
| 3.12 | No absolute URLs in embedded navigation             | ✅ Pass | All nav uses relative paths                                |
| 3.13 | Works in Chrome incognito                           | ✅ Pass | No client-side storage dependencies                        |

---

## 4. App Store Listing ⏳ DRAFT UPDATED (2026-03-27) — final review needed before entering in Partner Dashboard

Copy drafted in `guide/app-listing-ghost-code.md`. Updated 2026-03-27 to reflect full scanner capabilities (26 checks, 96 signatures, 8 surfaces, export, SEO detection). Removed killed permission audit feature. Fixed Standard plan pricing.

**ACTION**: Do a final review of listing copy before entering in Partner Dashboard.

| #    | Item                              | Status | Notes                                           |
| ---- | --------------------------------- | ------ | ----------------------------------------------- |
| 4.1  | App name (30 chars)               | ⬚ TODO | "Ghost Code" — include keyword? See listing doc |
| 4.2  | Tagline / subtitle (62-100 chars) | ⬚ TODO | 3 options drafted in listing doc                |
| 4.3  | Keywords (all 20 slots)           | ⬚ TODO | 8 search terms identified in listing doc        |
| 4.4  | Description (max 2,800 chars)     | ⬚ TODO | 2 options drafted in listing doc                |
| 4.5  | Screenshots (3-6, 1600x900)       | ⬚ TODO | 5 captions drafted — need actual screenshots    |
| 4.6  | Demo video (30-90 seconds)        | ⬚ TODO | Real workflow, not animations                   |
| 4.7  | Demo store link                   | ⬚ TODO | Link to page showing functionality              |
| 4.8  | Pricing plans entered             | ⬚ TODO | Free / Standard $29 / Professional $49          |
| 4.9  | App category selected             | ⬚ TODO | Store management > Store design                 |
| 4.10 | App icon                          | ⬚ TODO | Per style guide standards                       |

---

## 5. Deployment & Infrastructure ⬚ VERIFY

| #   | Item                                           | Status   | Notes                                                           |
| --- | ---------------------------------------------- | -------- | --------------------------------------------------------------- |
| 5.1 | Railway production deployment working          | ⬚ Verify | Check `railway status` for correct project                      |
| 5.2 | All env vars configured in Railway             | ⬚ Verify | Incl. TOKEN_ENCRYPTION_KEY — check for trailing whitespace      |
| 5.3 | Inngest connected and processing jobs          | ⬚ Verify | `scan-theme` function visible in Inngest Cloud                  |
| 5.4 | Database migrations applied to production      | ⬚ Verify |                                                                 |
| 5.5 | `shopify app deploy` run (config + extensions) | ⬚ Verify |                                                                 |
| 5.6 | `test: true` removed from billing mutations    | ⬚ Verify | Must use real billing for production                            |
| 5.7 | Security review completed                      | ⬚ TODO   | Auth, input validation, secrets, GDPR — run before first deploy |

---

## 6. E2E Manual Test Pass ⬚ TODO

Full checklist in `docs/e2e-test-checklist.md`. Run against production (Railway) with a dev store install.

| #   | Section                   | Status | Notes                                                  |
| --- | ------------------------- | ------ | ------------------------------------------------------ |
| 6.1 | Install & Auth            | ⬚ TODO | Install, load, session, refresh                        |
| 6.2 | Dashboard & Navigation    | ⬚ TODO | Tiles render, React Router nav, no full-page reloads   |
| 6.3 | Theme Scan                | ⬚ TODO | Queue, Inngest trigger, completion, results display    |
| 6.4 | Billing                   | ⬚ TODO | Upgrade, approval, plan badge, feature unlock, cancel  |
| 6.5 | Webhooks                  | ⬚ TODO | Uninstall, scopes, billing, themes/publish, all 3 GDPR |
| 6.6 | Scan Limits & Plan Gating | ⬚ TODO | Free/Standard/Professional limits enforced             |
| 6.7 | Error Handling            | ⬚ TODO | Invalid route, session expiry, network error           |
| 6.8 | Re-install Flow           | ⬚ TODO | Uninstall, re-install, clean state                     |

---

## 7. Pre-Submit Final Checks ⬚ TODO

| #   | Item                                      | Status | Notes                                                   |
| --- | ----------------------------------------- | ------ | ------------------------------------------------------- |
| 7.1 | Full codebase review                      | ⬚ TODO | Bugs, test coverage, logging, a11y                      |
| 7.2 | No TypeScript errors (`npx tsc --noEmit`) | ⬚ TODO |                                                         |
| 7.3 | Formatted (`npx prettier --write .`)      | ⬚ TODO |                                                         |
| 7.4 | All tests passing (`npx vitest`)          | ⬚ TODO |                                                         |
| 7.5 | Lighthouse score drop <10 points          | ⬚ TODO | Compared to theme without app installed                 |
| 7.6 | Clean demo data in dev store              | ⬚ TODO | Remove test scans, ensure fresh experience for reviewer |

---

## Submission Sequence

Once all sections above are complete:

1. Submit app for review in Shopify Partner Dashboard (budget 2-3 weeks for review)
2. While waiting: recruit 5-10 beta merchants, offer free lifetime plan
3. On approval: publish listing, begin launch sequence (see `strategy/2026-03-founder-playbook.md`)

# Session Handoff: 2026-09-23e — scanner batch DEPLOYED (efa9493)

Supersedes 23b/23c/23d on-hold handoffs. Three deploys today, all CI + Deploy + smoke green:
- `9b2cfa1` MALICIOUS_SCRIPT detector (never paywalled) + deep-dive follow-ups.
- `d1e7415` audit follow-ups + hybrid circuit breaker (owner 1A).
- `efa9493` scanner batch (this handoff).
- Post-deploy watch (to ~23:55 UTC): crons heartbeating on new container (monitor-deep-health 23:45, watch-stale-scans 23:50), 0 error events, no scans yet (new detectors not yet exercised in prod).

## efa9493 contents (all beads closed)
- Coverage: blocks/*.liquid full scan (gc-zfl); slash escapes hex/code-point/octal (gc-dm7); GHOST_TITLE FPs fixed for SVG titles + stock gift-card translated title (gc-j93, also what sex-eshop saw).
- ReDoS: 30+ regexes linear (gc-t7x + FONT_LINK + checkout-sunset stripping gc-4yg). Equivalence verified: 72k fuzz + 26.6M exhaustive + 113.5M checkout strings, 0 mismatches.
- Correctness: Turkish dotted-I offsets (gc-8jd); attribution Hextom Translate / Bold split + neutral "Bold" / SearchPie / Mailchimp / PageFly (gc-9rw, gc-ovk, gc-5v9); loyalty- product tags -> "Loyalty App".
- Duplicate library: floating tags (latest/next/beta/canary/rc/alpha) = LOW "possible duplicate copies" (owner 1A); %5E range decode (gc-tus.11/.12).
- Robustness: step-output caps + 3MB budget with re-measure (gc-4ce; over-cap existing handles no longer mark skipped); per-file per-type finding cap 200, MALICIOUS_SCRIPT exempt (gc-ypk).
- Copy: checkout.liquid facts corrected to Shopify docs (Aug 13 2024 checkout steps; Aug 28 2025 Thank you/Order status; renders nowhere now), past tense, all stores (gc-oam, owner option A).
- Pipeline: deploy.yml paths-ignore memory/docs/*.md + workflow_dispatch (deploy job main-only) (gc-cpa); smoke polls SHA and gates on the matched response, 401/403 fail fast (gc-7y2).
- Perf: Horizon ~940ms -> ~670ms; timing tests min-of-two (CI 2-core green).

## Expected churn on first scans after efa9493
Block findings "new"; Turkish-text stores may gain tags; Sales Pop -> Hextom Translate and Bold Product Options -> Bold/Bold Upsell/Bold Discounts relabels (prod has ZERO IgnoredFinding rows, so no ignore breakage).

## NEXT SESSION: listing copy (owner will review)
Update Partner Dashboard listing AFTER confirming efa9493 healthy. Draft (docs/gtm/listing-v2.md to be updated):
- Feature bullet 4 -> `Flag scripts from known malicious domains, shown in full on every plan` (70)
- Description (500/500): "Every app you uninstall leaves code behind: scripts, tracking pixels, SEO tags, and metadata across your theme, including Horizon theme blocks. It slows your pages, feeds wrong info to Google and AI agents, and pings services you dropped. GhostCode runs 30+ checks across 8 surfaces, traces every fragment to the app that left it (file, line, snippet), and flags scripts from known malicious domains on every plan. Findings are grouped by what they cost you. Track your health score. First scan free."
- Meta description (154/160): "Scan your Shopify theme for orphaned code left by uninstalled apps. 30+ checks, 100+ signatures, malicious script alerts, AI & SEO fixes. First scan free."
- Guardrails: factual wording only; no "protects/prevents hacks/security scanner" (listing linter rejects outcome claims). Not in hero or keywords. Consider a screenshot of the red malicious alert.
- CHECK live Managed Pricing card: if it says "Catch checkout.liquid sunset risks", change to `Find dead checkout.liquid code` (30/40).

## Open follow-ups
- gc-11f (P2) cap-truncated audits shown as "grant permissions" skipped checks (banner/PARTIAL).
- gc-8sd (P3) memoize/index app-signature lookups (tag-dense 1MB ~3s, zero findings).
- gc-b0m (P3) move heavy perf tests to a non-parallel vitest project + CI step.
- Owner: check tomorrow's digest (RECONCILER section present; no NO HEARTBEAT line).
- sex-eshop: owner chose NOT to contact; alert appears on their next scan.

## Process notes
- Orchestrator mode (repo CLAUDE.md): serialized subagents, every brief gate includes `npm run build` (a node:crypto route import broke build once today).
- Adversarial audits were load-bearing all day (HIGH snippet-visibility bug, Liquid-comment evasions verified against the real Liquid gem, a gc-4ce regression, a flaky CI test). Keep: audit -> fix -> verify fixes -> deploy.

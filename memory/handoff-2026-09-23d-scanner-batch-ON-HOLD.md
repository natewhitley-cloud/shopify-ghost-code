# Session Handoff: 2026-09-23d — scanner batch BUILT, audited, ON HOLD (supersedes 23c)

Branch `feat/blocks-and-escapes` = 30 commits on `main` (origin d1e7415). NOT merged/pushed. Gate green: lint, format, typecheck, build (client clean), 3486 tests. No migrations. Stock Horizon/Dawn/skeleton = 0 findings; planted leftovers detected.

## Contents (close beads on deploy)
- gc-zfl blocks/ full scan; gc-dm7 + extra slash escapes (hex, code-point, octal); gc-j93 GHOST_TITLE (SVG titles, gift-card translated title).
- gc-t7x ReDoS sweep: 30+ regexes linear (e.g. 1MB mixed file 15.5s -> 190ms); equivalence verified (72k fuzz + 10.4M exhaustive, 0 mismatches) + FONT_LINK_TAG follow-up (16.2M, 0 mismatches).
- gc-4yg checkout-sunset stripping linear (main thread); oversized checkout.liquid still emits generic finding.
- gc-8jd Turkish dotted-I offsets; gc-9rw Hextom Translate attribution (+2 snippet vendor fixes); loyalty- product tags -> generic "Loyalty App".
- gc-tus.11 keep oversized files in duplicate-library pass (proved linear); gc-tus.12 floating tags (latest/next/beta/canary/rc/alpha) -> LOW "possible duplicate copies" (owner 1A); %5E range decode fix.
- gc-oam checkout.liquid copy corrected to verified facts (Aug 13 2024 checkout steps; Aug 28 2025 Thank you/Order status; renders nowhere now), past tense, all stores (owner option A).
- gc-cpa deploy.yml paths-ignore docs + workflow_dispatch (deploy job main-only); gc-7y2 smoke polls SHA, deep checks on the matched response, 401/403 fail fast, SHA >= 7 hex.
- gc-pho NUL byte.

## Decisions
- Attribution renames: prod has ZERO IgnoredFinding rows, so no ignore migration needed.
- DUPLICATE_LIBRARY has never fired in prod (low stakes for floating-tag change).
- Accepted: one-time re-fingerprint if checkout.liquid crosses 1MB (documented in code).

## First scan after deploy (expected churn)
Block findings "new"; Turkish-text stores may see newly found tags; Sales Pop -> Hextom Translate relabels.

## Follow-ups
gc-4ce (P2) dangling-ref step output can exceed Inngest 4MB; Bold shadowing; Mailchimp dead domain; tag-dense perf budget.

## Deploy (when approved)
checkout main, merge --no-ff feat/blocks-and-escapes, push; watch CI + Deploy + smoke (smoke now polls up to 4 min for SHA).

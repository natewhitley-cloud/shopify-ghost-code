# Session Handoff: 2026-09-23b — audit follow-ups BUILT, audited, ON HOLD (not deployed)

Branch `feat/audit-followups-2026-09-23` (19 commits on top of local `main`, which is itself 1 docs commit ahead of origin). NOT merged, NOT pushed. Gate green: lint, format, typecheck, build (client bundle clean), 3120 tests.

## Built (beads still OPEN until deployed; close on deploy)
- gc-cid dead helpers removed; gc-b37 myshopify domain guard before secret-bearing refresh POST + constant-time health token (in `app/lib/token-compare.server.ts`; a node:crypto import in a ROUTE broke `npm run build`, caught and fixed); gc-0lb a11y.
- gc-q8g prune keeps newest heartbeat per key (verified with read-only prod count + throwaway Postgres).
- gc-3pd + gc-qqt malicious check also on templates/sections JSON, settings_data.json, locales JSON, blocks/*.liquid, assets js/mjs/liquid, and oversized files; differ exempts MALICIOUS_SCRIPT from the skipped-file rule.
- gc-d4e theme text-size in scan_signal (+ aborted over-cap rows) and read-only `scripts/theme-size-report.ts`.
- Audit fixes: Liquid-faithful comment/raw/doc token walk (0 false negatives vs real Liquid 5.8.1 on 10k fuzzed templates), encoded-slash decodes (JSON, u002f, HTML entities incl &sol;), breaker denominator = probed, domain logged on guard reject, abort metadata adds probed/skipped.

## OPEN DECISION (owner) before deploy
F2: breaker now trips on "100% of PROBED". Safe (never wrong-churns) but noisy: e.g. 10 shops, 9 throttled/skipped, 1 real uninstall => pages, marks nothing. Options in session notes: keep; 100%-of-probed only when probed >= 2 while keeping the old 100%-of-checked rule; or revert to checked.

## Follow-ups filed
gc-zfl (full detector suite for blocks/), gc-dm7 (hex/code-point slash escapes).

## Deploy (when approved)
checkout main, merge --no-ff the branch, push; watch CI + Deploy + smoke; migration: none new on this branch.

# Session Handoff: 2026-09-23c — blocks full scan + slash escapes BUILT, audited, ON HOLD

Branch `feat/blocks-and-escapes` (7 code commits + this doc on top of `main` = origin d1e7415). NOT merged, NOT pushed. Gate green: lint, format, typecheck, build (client clean), 3196 tests. No migrations.

## Built (close beads on deploy)
- gc-zfl: `blocks/*.liquid` runs the full per-file detector suite. Real-theme check (independently re-run): stock Horizon (95 blocks), Dawn, skeleton-theme = 0 findings; planted Klaviyo/Judge.me leftovers in a block detected.
- gc-dm7: hex, code-point (any leading zeros) and legacy octal slash escapes decoded (octal verified vs real JS: backslash-577 = "/7", so no lookahead).
- gc-j93 (closed by efd7d55): GHOST_TITLE ignored SVG <title> and the stock gift-card translated title (quoted locale key + t filter). Stock-theme GHOST_TITLE FPs 1 -> 0 on Horizon and Dawn; also fixes the finding sex-eshop saw.
- Audit fixes: cross-file tracker/chat findings anchor by folder priority (no fingerprint churn / broken ignores when blocks sort first); shared comment-skip helper skips {% doc %}.

## Deploy notes
- First scan after deploy: block findings appear as "new" once (expected).
- Deploy: checkout main, merge --no-ff, push; watch CI + Deploy + smoke.

## Follow-ups filed
- gc-t7x (P2) pre-existing ReDoS: GHOST_TITLE regex quadratic on unclosed <title>; a 1MB file can exceed the worker timeout and fail that scan. Sweep sibling regexes.
- gc-pho (P4) raw NUL byte in dangling-reference-extractor.
- Left as-is (pre-existing, same as sections): gtag in a first-party block -> GHOST_PIXEL; custom spr-badge class -> GHOST_TEXT.

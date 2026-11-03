## Session Handoff: 2026-11-03, push batch built + audited (NOT pushed)

### RESUME HERE
- **Branch `batch/2026-11-03`** (worktree ~/shopify/gc-batch-2026-11-03), on origin/main 44e702b. NOT pushed; push to main = prod deploy (Nathan's go).
- Gate on 9c5544c: lint/format/typecheck/build 0; 291 files / 11,552 tests.
- Commits: dbd54c5 gc-k71c, 5915370 gc-3ate, 5ce5849 + f0b1f5d gc-uczg, f8119cd gc-7f1p + gc-v5p7, 89b41e6 gc-mp01, ddef0e9 spikes (gc-tib, gc-dg5e, gc-08x8), 9c5544c audit round 1.
- Audit: security + feature-logic auditors, 0 HIGH; 3 MEDIUM fixed (extension parser structural limit, live-app suppression never "Fixed", +privacy wording = gc-loqq for Nathan), 6 LOW fixed, 2 LOW beaded (gc-sdg7, gc-81w3), pre-existing gc-2x0o filed.

### Before push (owner)
1. gc-loqq: privacy.html wording (homepage uses + scan diagnostics app handles); publish first.
2. gc-mp01 side effects on paw-naturals: one-time resolved+new for Magisto (summary email "New: 1, Fixed: 1"); check IgnoredFinding for the old host fingerprint and last scan for www.magisto.com theme references.
3. After deploy: digest "SCANNER SIGNALS" line shows embed-check counts (needs SCRIPT_TAG_SUNSET_LIVE_ENABLED on in prod); ~2 weeks of data, then decide gc-uczg.

### Decisions (Nathan 2026-11-03)
gc-3ate 1A (extension script on page = live, sunset severity only); gc-mp01 2A (name Magisto from its own domain, stays HIGH); batch push, not per-fix.

### Spikes (docs/spikes/2026-11-03-*.md)
- gc-tib: exemption long pole (no SLA, a diff-and-approve app was denied 06-2026); fallback = cleaned-theme ZIP export (Residue model); 7 slices, 1-6 buildable pre-approval; D1-D9 owner decisions; justification draft in §1.6.
- gc-dg5e: Shopify staff say Canvas-edited themes don't appear when apps list themes (unverified live); run the GraphQL checks in the doc.
- gc-08x8: all 5 items keep; preview-theme scanner test pending.

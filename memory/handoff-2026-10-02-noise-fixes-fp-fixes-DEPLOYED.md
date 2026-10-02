# Handoff 2026-10-02: scanner-noise + FP fixes DEPLOYED (e196a7a)

## Shipped (Deploy + smoke + CI green, 17:19Z)
- f69da12 + 2ae0c2f: CSRF rejections (document AND .data paths) log one `csrf rejection:` line, never recorded as api_error. Live-verified with foreign-Origin POSTs: 0 rows.
- 7a7507f + 2b8c445: api_error cap = 30/h per (code, path) under a 300/h per-code ceiling; path-less codes 30/h. Fail-open.
- bbacf00: client-error scrubber leaks + streaming byte-capped body read.
- 8a98278 + e196a7a: loop-var scoping (gc-nbz), `{{- -}}` trim + same-quote content (gc-kes); O(log n) scope lookup (gc-dza, 37M-case fuzz parity).
- 5e8a3a9: Instagram embed.js benign; Mintt css narrowed (gc-7am).
- e3b2114: settings_data.json header parse fix (gc-ecr). **SETTINGS_DRIFT_LIVE_ENABLED is OFF**: hits only counted in scan_signal.
- e382739: spec `docs/specs/app-embed-audit-spec.md` (gc-fed) APPROVED (D1-D4 = A).

Two adversarial audits: no HIGH. MED/LOW filed: gc-387, gc-r9t, gc-7do, gc-90a, gc-0yx, gc-bn6y.

## Open / next
1. **gc-6lw (404 half)**: 404s still print a stack in prod. Cause: React Router 7's DefaultErrorComponent always console.errors (dist/development, ENABLE_DEV_WARNINGS hard-coded). Fix = root `ErrorBoundary` in app/root.tsx. Verify live: curl a random path, read `railway logs`.
2. **gc-bwci**: review SETTINGS_DRIFT scan_signal hits on ~10 prod scans, then enable the flag.
3. **gc-fed**: implement per spec (unblocked now gc-ecr is closed); verifications V1-V3 before enabling APP_EMBED_LIVE_ENABLED.
4. gc-387: re-run the 60-file social-meta corpus after the META_CONTENT_RE change.
5. Conversion bet: gc-syz merchant email (only 2 of 12 shops ever re-scan; all upgrade prompts are in-app).

## Environment notes
- Shared beads Dolt server was down; restarted manually (`dolt sql-server --host 127.0.0.1 --port 3307` in castle-builder `.beads/dolt`).
- Shopify CLI auto-upgraded to 4.8.4; CLI holds a `read_themes` store auth for nw-dev-store-2 (`shopify store execute`).
- nw-dev-store-2 offline Session token in prod DB is expired (401); webhook degraded rows for one shop on 10-01 are the gc-4hk fallback, expected.

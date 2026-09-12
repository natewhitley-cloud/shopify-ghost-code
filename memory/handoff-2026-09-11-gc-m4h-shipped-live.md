## Session Handoff: 2026-09-11 — gc-m4h "Broken Links" shipped + activated LIVE

### What Got Done

- **gc-m4h epic: fully built, merged, deployed, and ACTIVATED in prod.** New DANGLING_REFERENCE ("Broken Links") finding class detects theme code that statically references deleted products/collections/pages.
  - .1 spike (`memory/epics/gc-m4h/spike.md`) → .2 FindingType + additive enum migration → .3 static extractor → .4 Admin-API existence resolver → .5 worker wiring (inert) → .7 Standard+ packaging. All 8 subtasks + epic CLOSED in beads.
  - Merged as `f375404` (PR #21, merge-commit convention). Deploy workflow green (Railway + log-error scan + blocking smoke gate). Then flipped `DANGLING_REFERENCE_LIVE_ENABLED=true` on Railway (ghost-code/production/shopify-ghost-code) → redeploy `c5220342` SUCCESS, /health ok.
  - .6/.8 verified already-satisfied by .2's exhaustive-maps work — closed with notes, no redundant dispatch.
- Full suite 2448 tests / 0 failures at every gate; tsc clean.

### Key Decisions (with rationale)

- **v1 scope = products/collections/pages only; menu (`linklists`/P7) + blogs → v2** (decision R2). Menu is rare in modern themes, highest FP risk, drops the whole read_online_store_navigation gate — products/collections/pages carry ~all the value.
- **ONE FindingType (DANGLING_REFERENCE), subtype in `description` + `appName`** — no JSON evidence column exists on the Finding model; this avoids a second migration and stays outside the differ fingerprint.
- **Precise-skip rule (R1):** mark the type "skipped" for a scan only when a _present_ ref's required scope is absent (or lookup budget truncated), so the differ never false-resolves unchecked refs. Alternative (per-subtype FindingTypes) rejected by the one-type decision.
- **Heuristic confidence badge accepted for v1 (R3)** — the drift-guarded taxonomy forces signature-or-heuristic; existence is Admin-verified so the badge under-claims. Noted a future "verified" tier; not worth a taxonomy change now.
- **Packaging = Standard+ (all paid), Free never runs it** (Nathan directive).
- **Ships double-inert** (flag + plan gate) so merge = no-op; activation is a deliberate separate step.

### Patterns & Discoveries

- **FindingType blast-radius = 8 maps.** Adding a FindingType touches: schema enum (+migration), DEFAULT_SEVERITY, CONSEQUENCE_MAP, finding.server typeCounts x2 (all compiler-enforced) + HEURISTIC partition (drift-test enforced, `tests/lib/finding-classification.test.ts:154`), FINDING_TYPE_LABELS (filter-chip gate at `app.scans.$scanId.tsx`), REMEDIATION (silent fallback). UI surfacing is fully map-driven — no per-type UI switch to extend.
- **scan-theme.ts uses dynamic `await import(...)` for every in-step service/lib** — matched that idiom (not cleverness).
- Migration hand-authored (`ALTER TYPE ADD VALUE IF NOT EXISTS`), NOT via `prisma migrate dev` (no shadow DB; .env → prod).

### In-Progress Work

- **None.** Tree clean, on `main`, everything committed/merged/deployed.

### Uncommitted Changes

- None.

### Resumable Agents

- None (all dispatched agents completed).

### Open Questions / Loose Ends

- **gc-m4h end-to-end proof (only real open item):** the static-vs-dynamic FP discipline and scope-gating were never exercised on a live paid store. Next: run a scan on a Standard/Pro store with a hardcoded link to a deleted product/collection/page and confirm a "Broken Links" finding surfaces (and that dynamic refs are NOT flagged). No dev/staging env exists — "live or it isn't."
- **Two parked branches (Nathan holding pushes):**
  - `fix/scan-detail-health-tile` (`e67690e`) — the ONLY live-vs-listing gap: prod scan-detail shows a 0/100 health tile while the submitted listing says "findings over time." Decision: push/merge now vs batch later.
  - `docs/refresh-submission-screenshots` (`78600bc`) — screenshots + copy.

### Recommended Next Steps

1. **Verify gc-m4h on a real paid store** with a known-deleted-entity link (the untested gate). If a false "deleted" appears, first suspect a scope-absence or fuzzy-match edge; reversible via `railway variables --set "DANGLING_REFERENCE_LIVE_ENABLED=false"`.
2. **Decide the two parked branches** — the scan-detail fix closes a real listing-vs-prod inconsistency; recommend pushing it (own PR, merge-commit convention, CI ~4min).
3. Other ready epics if starting fresh work: `gc-xel` (gc-47c live-verify + .10 JSON-LD activation `gc-fca`), `gc-syz` (merchant alerts), `gc-tus` tail.

### Risks & Warnings

- **gc-m4h is now LIVE and RAW-AFFECTING for Standard+** (creates real findings). If FP reports come in, kill switch is the env flag=false (triggers redeploy).
- **scan-detail 0/100 tile still in prod** — contradicts the live App Store listing copy until `fix/scan-detail-health-tile` merges.
- Railway var-change redeploys do NOT run the GitHub smoke gate — verify /health manually after any future flag flip (done for this one).

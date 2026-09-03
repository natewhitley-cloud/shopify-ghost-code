# Session Handoff: 2026-09-03 — gc-47c Batch A + Batch B (copy + JSON-LD detector)

## TOP ACTION FOR NEXT SESSION
**Push 4 unpushed commits to prod, then verify live.** Nothing from this session
(or the prior one) is deployed yet. `main` auto-deploys via Railway (self-migrating,
no staging). Gate is green at HEAD (2280 tests, lint/format/typecheck clean).

```
git push        # ships all 4 below in one deploy
```

Unpushed stack (oldest first):
| SHA | Bead(s) | What |
|---|---|---|
| feb23df | (prev session) | Theme Health tile sizing fix (stop hero stretch) |
| 974f8c1 | gc-opx, gc-47c.7 | Accurate finding labels + "Why it matters" agentic copy |
| 8ef20a5 | gc-47c.9 | Harden detectJsonLdConflicts (@graph/array/all-pairs) |
| 548f1ec | gc-47c.8 | Surface conflicting Offer price/availability |

### After push, verify live on a real scan:
1. **Labels** render correctly: Compare-at Prices, Product Tags, Content Pages, Robots Meta Tags.
2. **"Why it matters:"** line appears above "How to remove:" ONLY on the 6 reframed types
   (canonical, hreflang, meta-robots, JSON-LD, JSON-LD-conflict, duplicate-meta).
3. **Two JSON-LD FP edges to eyeball** (flagged, not blockers):
   - Node-level `@graph` flattening: two *legitimately different* Product nodes in a
     single `@graph` could read as a conflict. Narrow, but watch real scans.
   - Number-vs-string price (`19.99` vs `"19.99"`) still fires the GENERIC gc-47c.9
     conflict (canonical JSON differs); the offer-diff layer correctly suppresses the
     misleading "offer price differs" clause. Confirm the generic finding isn't noisy.

## What Got Done
- **gc-opx** (closed): relabeled 4 finding types whose labels misdescribed detector behavior.
  `FINDING_TYPE_LABELS` in `app/routes/app.scans.$scanId.tsx:100`.
- **gc-47c.7** (closed): agentic "why it matters" copy. Split remediation map to
  `{ impact?, howTo }` in `app/lib/finding-remediation.ts`; new `getFindingImpact()`;
  render a "Why it matters:" line for the 6 reframed types. GHOST_PRICE + GHOST_OG
  deliberately EXCLUDED (price isn't JSON-LD; OG is gc-47c.12).
- **gc-47c.9** (closed): node-model refactor of `detectJsonLdConflicts`
  (`scan-engine.server.ts` ~848-1010). Flattens @graph wrappers, top-level arrays,
  array @type; all-pairs compare; canonical-JSON dedup. Fixed an em-dash in the finding
  description while there.
- **gc-47c.8** (closed): offer-field diff (price/priceCurrency/availability/priceValidUntil)
  ENRICHES the single JSON_LD_CONFLICT description (no double-emit). Strips schema.org URL
  prefix on availability.

## Key Decisions
- **Batch A copy structure = SPLIT** ("Why it matters" + "How to remove"), not a blended
  blurb. Rationale: the row hardcodes a "How to remove:" label; blending would under-sell
  the reframe. Chose `{impact?, howTo}` shape; `getFindingRemediation()` still returns
  `howTo` so existing tests hold. (Rejected: blended single string; blended + relabel to
  "What to do".)
- **gc-47c.8 enriches, does NOT emit a second finding.** A separate offer finding would
  double-count the generic conflict gc-47c.9 already emits.
- **Deferred the push to next session** so live verify happens with fresh context (no
  staging exists — "live or it isn't").
- **Batch B dispatched to subagents** (general-purpose, serialized .9 then .8) per
  orchestrator mode; Batch A hand-edited inline (trivial copy, user-approved).

## Remaining gc-47c epic children (none blocking)
- **gc-47c.5** (P1) — detect orphaned AI-crawler blocks via meta tags (widen robots
  detector + AI_CRAWLER_USER_AGENTS list).
- **gc-47c.10** (P2) — DECIDE + build orphaned Product+Offer detection (static-vs-static
  vs static-vs-live-price). Now unblocked (gc-47c.9 done).
- **gc-47c.12** (P3) — GHOST_OG agentic reframe (the OG copy excluded from Batch A).
- **gc-47c.11** (P4) — parked (llms.txt / rendered robots.txt / ACP feeds out of reach).

## Cleanup surfaced (unfiled — consider a one-shot sweep bead)
- Two more merchant-facing descriptions violate the no-em-dash rule:
  `detectGhostJsonLd` (~scan-engine.server.ts:835) and `detectDuplicateMetaTags` (~L746).

## Housekeeping
- Untracked: `memory/handoff-2026-09-03-nav-bundle-hydration-dashboard-color.md` (prev
  session's note) is still uncommitted in the working tree. This new note too. Commit both
  as `docs:` next session (memory/ md skips the prettier format gate).

## Risks & Warnings
- 4 commits unpushed = prod is stale at 16b814b. First push deploys everything at once.
- No staging: verify on a live dev-store scan, not just tests.
- Watch the two JSON-LD FP edges above on first real scan after deploy.

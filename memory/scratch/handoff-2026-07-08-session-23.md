# Session Handoff: 2026-07-08 — Session 23 (gate flip + curate + GTM pass)

## What Got Done

- **GC-7ml CLOSED** — smoke SHA pin flipped warn-only → BLOCKING (`6f0e710`). Verified live against prod in all 3 modes BEFORE push (match→exit 0, mismatch→exit 1, unset→warn+0), then observed ✓ green on 4 consecutive blocking-mode deploys this session. The S20 false-green gap is fully closed.
- **/curate applied** (`0a22241`) — tester 54→31 lines, implementer 52→25; 47 entries archived with dated reasons; kept sets concentrated on the GC-dda/GC-89k/GC-fir billing/deletion domain. Promote candidate flagged (see Next Steps).
- **GTM second community pass** (`9a1f083`) — full findings in `docs/marketing-plan.md` §6: 10 new response-ready threads, early-adopter promo mechanics, competitive shift, new detector candidates. 6 beads filed (GC-366, GC-tbx, GC-twy, GC-aih, GC-vif, GC-zgg).
- **Retro** (`b308662`) — retro-history appended; 2 new global memories (TaskOutput-JSONL dump, research-agent exclude-list leak).

## Key Decisions

- **SHA gate: no retry-on-mismatch** — 3 consecutive clean matches before the flip suggested the rollover race window is negligible; a red smoke on a docs commit is cheap and diagnostic. Revisit only if the gate ever reds on a mismatch. (Rejected: retry-with-delay — masks the timing signal.)
- **Early-adopter promo: Managed Pricing per-store discount, 100% × 3 billing cycles, applied DURING the 7-day trial** so the $0 cycles come first; auto-expires into paid month 4. (Rejected: 90-day trial extension — trial-ending decision point hurts conversion; public 90-day trial — no targeting, no cap.) Framing: "early tester, direct founder feedback line." **Never review-linked** (verified prohibited — review removal/demotion/delisting risk). Review ask separate, neutral, later, via shipped WriteReviewModal CTA. Cap ~20-30 stores.
- **Curate write-back applied in full** (user chose "apply both"); learnings live in repo and are pushed.
- **GTM findings beaded rather than acted on** — thread responses and trademark review are Nathan-owned judgment calls (GC-366, GC-tbx, GC-twy).

## Patterns & Discoveries

- **Competitive shift (verified live 2026-07-08, details marketing-plan.md §6d):** GhostSweep (App Store, launched 06-09, $20/mo, 0 reviews, Timi Studio Shenzhen, subtitle literally "Ghost Code Scanner", structural detection + metafield cleanup + risk labels) and ghostcode.app (standalone SaaS, no Wayback history, claims 150+ signatures, one-click removal). Cleanify confirmed delisted. The review race is the moat race.
- **Reddit is closed to automated research** (API/RSS/mirrors all blocked) and r/shopify is promo-hostile — community.shopify.com is the primary GTM surface (no anti-promo rules, Accepted Solution mechanic).
- Managed Pricing discount detail worth remembering: discount applies "next billing cycle," so applying DURING trial is what makes the first paid cycles $0.
- BillingEvent `amount` stamps list price during promo — conversion analytics will slightly overstate; cosmetic only, reconciler grants tiers from plan identity not price.

## In-Progress Work

None. Clean stop — tree in sync with origin, no stashes, no in-progress beads, no running agents (both research agents completed; results synthesized into marketing-plan.md §6).

## Blocked Work

- **GC-dda** (delete dead webhook handler, Batch 3) — blocked on GC-89k's two manual QA gates (Nathan: welcome-link route under /app; live upgrade test).

## Open Questions

- **GC-tbx (trademark)**: act on the name collisions? Options: (a) report GhostSweep's "Ghost Code Scanner" subtitle to Shopify partner support (low effort, plausible win), (b) trademark search/filing (cost/benefit unknown), (c) monitor only. Criteria: whois + screenshot evidence first; whether GhostSweep's subtitle actually confuses App Store search results for "ghost code". Nathan's call.
- **GC-twy (removal stance)**: revisit detection-only earlier than the 500-install trigger? Middle path preserving false-positive safety: generated per-finding removal INSTRUCTIONS (copy-pasteable edit, no theme writes). Criteria: does GhostSweep/ghostcode.app removal messaging show up in threads/reviews merchants actually cite? Nathan's call.
- **GC-89k gates** — unchanged from session 22, decidable by running them on a store (~15 min).

## Recommended Next Steps

1. **Nathan: GC-366 (P1)** — post to the §6a top-4 threads (632348, 608042, 385236, 2170385) using §2 response drafts + early-tester framing; apply promo per §6b as merchants bite. Highest-leverage, time-sensitive (review race).
2. **Nathan: GC-89k gates** (~15 min) → unblocks GC-dda for an agent.
3. **Agent-ready: GC-aih** (OS 2.0 JSON-template app-block detector, P2) — best next feature dispatch; scaffolder learnings should be curated first if it goes through /sprint (46 lines, near warning).
4. **Run /promote** — build/deploy-pipeline audit pattern spans tester + scaffolder (4 entries, one incident); strong rule candidate.
5. GC-tbx whois/screenshots can be agent-assisted (evidence gathering) before Nathan decides.

## Risks & Warnings

- **SHA gate is now BLOCKING** — a genuine rollover race would red the workflow on an otherwise-good deploy. That's by design; if it happens, read the smoke log before assuming a bad deploy (expected vs deployed SHA are both printed).
- Push-to-main still = prod deploy; smoke blocks but doesn't roll back (unchanged).
- Competitor pages (ghostcode.app pricing, GhostSweep review count) were verified 2026-07-08 — re-verify before quoting them externally; these change fast.
- `bd dolt push` has no remote here ("no store available") — beads DB is local-only; `docs/backlog-snapshot.json` is the git-tracked backup if the DB ever diverges (see session-known incident memory).

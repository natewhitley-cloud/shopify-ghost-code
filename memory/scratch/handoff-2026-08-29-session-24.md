# Session Handoff: 2026-08-29 — Session 24 (Inngest key-drift incident + delist cleared)

## What Got Done

- **Shopify 2-week DELIST threat RESOLVED — cleared on follow-up review.** Reviewer reported a theme scan running >2h with no completion. Root cause was NOT scan logic: the **Inngest signing key had drifted** (`PUT /api/inngest` → 401 "signing key is invalid"), so no background jobs ran in prod — including `watch-stale-scans`, the 30-min watchdog that would normally mark a stuck scan FAILED. Both are Inngest crons, so the safety net was dead alongside the scan. Fixed by rotating the key + redeploy; resubmitted with a video → **cleared**.
- **Portfolio-wide blast radius found + fixed.** All three apps (**GhostCode, ClearSignal, TaxDelta**) share **one** Inngest signing key. Rotating it to fix GhostCode invalidated the other two (both went 401). Propagated the new key to all three Railway envs + redeployed each; verified all three `PUT /api/inngest` → 200.
- **Scan status decoupled from optional scopes** (`c6a37b7`, deployed). Successful scans now finalize **COMPLETED**, not PARTIAL. PARTIAL was purely scope-driven, and the optional scopes (`read_products/content/navigation/translations`) are **never requested in-app**, so every scan was Partial for every merchant on every tier. `skippedCategories` still persisted → diff engine LOG-4 correctness intact; PARTIAL retained in the enum for historical rows. Full suite 1754 green.
- **App renamed `ghost-code` → `GhostCode`** (`a0e64e3`, deployed to Shopify via `shopify app deploy`). Display name only — app **handle stays `ghost-code`** (`APP_HANDLE`/billing URLs unaffected). Public App Store listing name confirmed updated by Nathan.
- **Ad-campaign doc created** (`docs/gtm/ad-campaign.md`) — cheap ~$30 slice of the shared $100 partner credit; 6 focused keywords; mirrors ClearSignal's `ba-wi4` playbook.
- **Inngest heartbeat-alerting spec created** (`docs/inngest-heartbeat-alerting-spec.md`); filed as a P1 bead in the **ClearSignal** backlog (ghost-code's Dolt store is down).

## Key Decisions

- **Mark scans COMPLETED, nudges later** (Nathan's call). The "enable more checks" nudge UI is deferred; only the status semantics changed. Rejected: keeping PARTIAL + relabeling in the UI (more churn, still confusing).
- **Ads: cheap slice.** $5/day (Shopify floor), pause at ~$30 or ~6 days, 6 keywords, to protect ClearSignal's share of the single shared $100 credit. The credit is one per-account pool applied before the card across ALL ad spend — not per-app.
- **Heartbeat bead lives in ClearSignal**, not ghost-code (Dolt down here). Design doc is the reference.
- **Deferred (Nathan: not now):** separate Inngest env per app; ghost-code Dolt store recovery.

## Patterns & Discoveries

- **All 3 apps share ONE Inngest signing key.** Rotation is a portfolio-wide grenade: it invalidates every app's Railway copy at once; only the app you redeploy recovers. Rotation runbook: update all three Railway copies to the SAME new key + redeploy each, then PUT-sync all three to 200. Diagnose via `PUT /api/inngest` (200/401), key hashes (`shasum` the Railway values), and temporal correlation (an app healthy until *someone else's* rotation shares the key). Memory updated: `inngest-signing-key-drift-kills-all-crons`.
- **In-app `monitor-scan-failures` can't detect an Inngest outage** — it's itself an Inngest cron. Alerting must be EXTERNAL (the heartbeat bead).
- **Optional scopes are declared in `shopify.app.toml` but never requested** anywhere in `app/` — so the 6 optional audits never run for any merchant. (Root cause of the permanent-Partial bug; also a latent feature gap if you ever want those audits live.)
- **ghost-code beads Dolt store is DOWN** — `bd stats` → 0 issues, `bd create` → "issue_prefix config is missing". Backlog is inaccessible here. `docs/backlog-snapshot.json` is the git-tracked backup.
- **Shopify CLI now needs Node 22.8+** (`enableCompileCache`); `.nvmrc` pins 20 (prod parity, `node:20-alpine`). Run CLI commands under `nvm use 24` (v24.18.0 installed, satisfies engines `>=22.12`).

## In-Progress Work / Git State

- **`main` is ahead of origin, unpushed:** `a0e64e3` (rename) + this session's docs/handoff commit. Pushing triggers a Railway redeploy but is a **no-op at runtime** (docs + toml name only; Shopify-side name already deployed via `shopify app deploy`).
- **Untracked (left intentionally):** `docs/community-response-drafts.md` (pre-existing GTM draft, not from this session).

## Blocked Work

- Backlog work is effectively blocked: the beads Dolt store is down (see Discoveries). Fix that before any `bd`-tracked work. Prior blocked item (GC-dda on GC-89k gates) is unverifiable until the store is back.

## Recommended Next Steps

1. **Push** the pending commits when ready (or leave; no runtime impact). `git push origin main`.
2. **Run the GhostCode ad slice** — app is now cleared, so the "wait for review" timing caveat is satisfied. Verify the $100 credit balance in Partner Dashboard → Bills first; redeem starts the 90-day clock on the whole shared credit.
3. **Fix the ghost-code beads Dolt store** before backlog work (bd is unusable now). Suspect the shared `dolt sql-server` isn't serving `beads_shopify-ghost-code`.
4. **Durable fix (deferred):** give each app its own Inngest environment so a key rotation never hits all three again.

## Risks & Warnings

- **Shared Inngest key:** any future rotation MUST update all three Railway copies + redeploy, then PUT-sync all three to 200. Forgetting one silently kills its background jobs.
- **Beads Dolt store down** — can't file/track beads in ghost-code until fixed.
- **Node:** use Node 24 for local Shopify CLI / npm; prod runs Node 20.
- Push-to-main = prod deploy (self-migrating); no migration in this session's changes.

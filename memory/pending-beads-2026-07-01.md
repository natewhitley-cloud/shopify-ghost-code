# Pending Beads — awaiting beads-lineage reconciliation (2026-07-01)

These are file-and-forget captures. They are NOT in the `bd` DB, because the live
Dolt DB is in the anomalous 168-world lineage and is frozen until reconciled (see
`handoff-2026-07-01-session17.md`). Convert each to a real bead via `bd create`
once the canonical lineage is chosen.

---

## Beads infra — root cause + recommended fix (investigated 2026-07-02, not yet actioned)

Investigated the beads setup before any reconciliation. Root cause of the DB-swap
scare is now concrete: **the beads data has no git-tracked source of truth.**
- `.beads/dolt/` (the actual DB) is **gitignored**; runs `dolt_mode: server`, single
  "Initialize" commit, **no history, no remote**.
- Beads' native durability mechanism — a git-tracked `.beads/issues.jsonl` — is
  **disabled**. The only tracked JSONL is `interactions.jsonl` (**0 bytes**).
- So the backlog lives only in the local Dolt server DB + **manual** `docs/*.json`
  snapshots. The `post-checkout`/`post-merge` hooks resync on every git op, but with
  no canonical git JSONL to reconcile against they can drift the server onto a
  different DB → the swap. Nothing versioned = swap invisible + unrecoverable-by-diff.

**Recommended durability fix: enable git-tracked JSONL export — NOT a Dolt remote.**
JSONL rides the git repo you already push (no new infra/credentials), is diffable (a
swap shows as a huge diff = detectable), and kills the manual snapshot dance. A Dolt
remote only adds off-machine backup + a separate push step to forget; skip it unless
you specifically want Dolt-native branch/merge history.

**Recommended reconcile method: fresh rebuild, not a two-DB merge.** snapshot.json is
a non-native JSON array (needs a transform, not `bd import`) and live-168 is
contaminated, so surgical restore-and-merge is fragile. Cleaner: new DB → enable JSONL
export → import the ~29 open items (18 eng from snapshot-86 + 11 product from live-168)
→ archive the 217 closed as reference JSON. One pass reconciles + fixes durability.

Both worlds remain preserved on disk (`docs/backlog-snapshot.json` 86 +
`docs/backlog-live-168-2026-07-01.json` 168) — **do not delete either** until this is
done. Deferred by owner 2026-07-02; not started.

---

## BEAD-1 — App Store listing SEO / discoverability pass (post-launch)

- **type:** task
- **priority:** P2
- **labels:** gtm, aso, listing
- **context:** Ghost Code approved + live 2026-07-01. Live listing reviewed at
  https://apps.shopify.com/ghost-code. Grounded in `docs/marketing-plan.md`
  (ASO audit, lines 153–210) and `docs/product-strategy.md` (positioning, line 246).

### Body

Improve App Store search ranking + Google discoverability for the live listing.
Ordered by impact:

1. **App name — add a keyword (re-review gated).** Currently "Ghost Code" (10/30
   chars, zero keywords). Research says ~70% of installs come from App Store search
   and the name is the strongest ranking signal; Shopify's AI already flagged the
   name as generic. Recommend **"Ghost Code: Theme Audit"** — accurate to a
   detect/report tool, avoids the "cleanup/remove" overpromise on a 0-review listing.
   Alt (higher volume, higher overpromise risk): "Ghost Code - Theme Cleanup" — hold
   until GC-c4g (cleanup-request action) ships and makes "cleanup" true.
   NOTE: changing an approved app's name triggers a listing re-review — one-time cost
   for a permanent ranking gain. This is the item gating the others; batch any other
   re-review-worthy listing changes with it. (Supersedes/absorbs GC-fh0.)

2. **Keyword slots — swap "theme speed" → "leftover app code" (or "code after
   uninstall").** Current 5: theme cleanup, orphaned code, theme speed, app cleanup,
   theme audit. "theme speed" loses to dedicated speed apps (Hyperspeed, Boostify);
   swap for a thin-competition term where Ghost Code is the direct answer. Free, no
   re-review.

3. **Fix tagline overpromise.** Live tagline is "Find and **remove** leftover app
   code…" but the app detects/reports, it does not remove (GC-c4g unbuilt). On a
   0-review listing, "it doesn't actually remove anything" is the most likely 1-star.
   Change verb to "Find and **fix**" / "**Detect** leftover app code…". Keeps SEO
   keywords, drops the promise. Free, no re-review.

4. **Verify SEO title + meta description (Partner Dashboard).** Controls Google
   ranking for "shopify remove app code" etc. Ensure the SEO title leads with
   "leftover app code" / "remove app code," not the brand name. Free, no re-review.

### Strategic note (from product-strategy.md:246)
No natural browse category — discovery is search-driven. Two fronts:
- **Cause-aware** ("leftover app code," "code after uninstall") — thin competition,
  we're the direct answer. Own these via name + keyword slots.
- **Symptom-aware** ("slow store," "improve SEO") — high volume, brutal competition;
  let the *tagline* reach for these, don't burn keyword slots fighting speed apps.

### Ceiling / dependency
All keyword tuning is capped by **social proof**: at 0 reviews the listing is buried
regardless of copy. Highest-leverage discoverability work is actually getting the
**first 5–10 reviews** (see GC-cjo demo store + early-adopter outreach) — sequence
that ahead of, or alongside, the re-review-gated name change.

### Definition of done
- New app name live (post re-review) OR explicit decision to keep "Ghost Code"
- Keyword slot #3 swapped
- Tagline verb corrected
- SEO title/meta verified to lead with primary keyword

---

## BEAD-2 — Finding: offline-token expiry is by-design + self-healing (GC-07t investigated 2026-07-02)

- **type:** task (mostly a documented finding)
- **priority:** P4 (note; no confirmed live bug to fix)
- **labels:** auth, observability, finding

### What was investigated
Prompted by a 2026-07-01 incident (owner logged in → auth issues, then scans
couldn't run) and by `/health/deep` reporting 2 "expired offline sessions" on prod.

### Findings (confidence: CONFIRMED unless noted)
- **Short offline-token expiry is BY DESIGN.** `app/shopify.server.ts` sets
  `future: { expiringOfflineAccessTokens: true }` → Shopify issues short-lived
  (~hours) offline tokens that refresh via a `refreshToken`.
- **All offline sessions carry a `refreshToken`** (verified on prod: 3/3 offline
  sessions, incl. both expired ones). With a refresh token, the SDK auto-refreshes
  the token both interactively (`authenticate.admin`) and in background jobs
  (`unauthenticated.admin`, used by `inngest/functions/scan-theme.ts` etc.) — no
  live App Bridge session needed. So dormant-shop scans CAN refresh + run.
- **`SafeSessionStorage` (`app/lib/safe-session-storage.server.ts`) is the shipped
  GC-07t fix.** It returns `undefined` from `loadSession` ONLY for an offline
  session that is expired (5-min grace) AND has NO `refreshToken` — forcing a clean
  token exchange instead of an infinite reauth loop. Count of that genuinely-stuck
  state on prod right now: **0**. Fleet is healthy.
- **Therefore expired offline session ROWS are the normal, self-healing resting
  state — NOT stuck merchants and NOT a health problem.** The initial
  "systemic auth bug" / "background scans can't refresh" hypotheses were REFUTED by
  the refreshToken evidence.

### The 2026-07-01 incident: cause UNCONFIRMED
The session table was a red herring. Most likely a transient during the
GC-qk3/GC-kde Railway deploy (restart → brief reconnect window), self-resolved on
reload. **If it recurs: capture Railway logs at the incident time — do NOT diagnose
from the Session table.**

### Optional follow-up (low value)
Expired offline session rows accumulate between refreshes; could be pruned, but
they're harmless (overwritten on refresh). Not worth scheduling on its own.

---

## BEAD-3 — Fix /health/deep sessions-check: flag only UN-REFRESHABLE expired offline sessions

- **STATUS: ✅ DONE 2026-07-02** — shipped `1a444c4` (fix) on top of `f331cb2`
  (probe) + `06e25c8` (investigation). Deployed to prod; `scripts/smoke.mjs`
  verified GREEN end-to-end (status ok, 0/0/0, exit 0). Grace-direction kept as a
  probe-tuning choice (`expires < now − 5min`), not an exact mirror of
  SafeSessionStorage — shares the refreshToken-null trigger + FIVE_MINUTES_MS.
  File as closed when beads unfreezes.
- **type:** bug
- **priority:** P2 (blocks making the post-deploy smoke a trustworthy gate)
- **labels:** observability, smoke, auth
- **depends on / explains:** BEAD-2 finding

### Problem
The sessions-check added in f331cb2 counts ALL expired offline sessions
(`isOnline=false, expires < now`). Per BEAD-2 that is the NORMAL self-healing state
under `expiringOfflineAccessTokens: true` → `/health/deep` sits perpetually 503
`degraded` on healthy prod (confirmed: reported degraded with 2 benign expired
sessions, all with refresh tokens). It is a false signal and the reason the
post-deploy smoke can't yet be flipped from soft-launch to blocking.

### Fix
Change the check to mirror `SafeSessionStorage`'s exact trigger — the only
genuinely-stuck, un-refreshable state:

```
db.session.count({ where: {
  isOnline: false,
  refreshToken: null,               // <-- the key addition
  expires: { not: null, lt: new Date(Date.now() - FIVE_MINUTES_MS) },
}})
```

Reuse the 5-minute grace from `safe-session-storage.server.ts` (export/share
`FIVE_MINUTES_MS` rather than duplicating). Today this count is 0 → `/health/deep`
correctly returns 200 `ok` and the smoke goes green. If a shop ever lands in the
un-refreshable state, it flags — a real GC-07t signal.

### Definition of done
- `/health/deep` sessions check uses `refreshToken: null` + 5-min grace (shared const)
- `tests/routes/health.deep.test.ts` updated: expired-but-has-refreshToken → OK;
  expired + no refreshToken → degraded
- Verified green against prod via `scripts/smoke.mjs`
- Once green across a deploy or two, remove `continue-on-error` from the smoke step
  in `.github/workflows/deploy.yml` (marked with a SOFT-LAUNCH comment)

---

## BEAD-4 — Flip the post-deploy smoke from soft-launch to blocking gate

- **STATUS: ✅ DONE 2026-07-02** — `continue-on-error` removed from the smoke step.
  Done same day as BEAD-3 rather than waiting for extra green deploys (owner call),
  since the smoke had already run verified-green in CI once. Note: after the
  `node: not found` CI-wiring fix, the smoke is now its own `smoke` job (needs:
  deploy) on ubuntu-latest — so a failed smoke fails that job / turns the workflow
  red (it does NOT roll back the already-run deploy). File as closed when beads
  unfreezes.
- **type:** chore
- **priority:** P3
- **labels:** observability, smoke, ci
- **depends on:** BEAD-3 (done) + a couple of green deploys

### Why
The "Post-deploy smoke test" step in `.github/workflows/deploy.yml` is currently
`continue-on-error: true` (soft-launched — runs and reports but never fails the
build). BEAD-3 made `/health/deep` a true signal and it verified GREEN in prod on
2026-07-02. Once it has ridden green through **1–2 more natural deploys** (cheap
confidence it's stable, not a fluke), it should become a real gate so a bad deploy
actually goes red.

### Fix
Remove the `continue-on-error: true` line from the `Post-deploy smoke test` step in
`.github/workflows/deploy.yml` (there's a `SOFT-LAUNCH` comment marking exactly
where and why). Leave the best-effort `Scan deploy logs for errors` step as-is
(it should stay `continue-on-error`).

### Watch-outs before flipping
- The smoke runs AFTER `railway up`, so it detects a bad deploy, it does not roll it
  back. Making it blocking turns the GH Action red (alert) — consider whether you
  want an auto-rollback follow-up later.
- It can race the rollout (smoke may hit the old container mid-cutover). If flaps
  appear after flipping, add a version/build marker to `/health/deep` and have the
  smoke assert the new build is live before checking.

### Definition of done
- `continue-on-error` removed from the smoke step; a forced degraded `/health/deep`
  makes the deploy job fail
- Confirmed a normal green deploy still passes

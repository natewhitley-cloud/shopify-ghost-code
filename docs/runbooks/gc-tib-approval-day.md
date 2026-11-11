# Clean copy: approval-day checklist (gc-tib)

Written 2026-11-11 while waiting on Shopify ticket 71890683 (write_themes exemption).
Every step that publishes or deploys needs Nathan's go. Work top to bottom; a step
marked STOP means don't go further until it's resolved.

## A. Before approval (can run any time; makes approval day a switch flip)

1. **Publish the legal update (gc-tib.6).** Must go live before the code deploys, even
   with the feature off: every scan now stores where each leftover snippet sits
   (span offsets + hash).
   - Worktree `~/shopify/dis-ghostcode-clean-copy`, branch `ghostcode-clean-copy-legal`
     (commits 6c404f5, 32f3728). Replace `[EFFECTIVE DATE]`, merge, push (= GitHub Pages
     publish).
   - Check: `natewhitley-cloud.github.io/data-integrity-suite/ghost-code/privacy.html`
     shows the new "Scan results" text and date. If the Pages deploy flakes, run a fresh
     `workflow_dispatch` (don't rerun).
2. **Deploy the branch dark.** Merge `feat/gc-tib-clean-copy` into `main` with
   `CLEAN_COPY_ENABLED` unset in Railway. Push = prod deploy.
   - Pre-deploy runs 3 migrations, all additive: `20261110200000_gc_tib_clean_copy`,
     `20261110210000_gc_tib_fix_item_finding_type`, `20261111120000_gc_tib_fix_run_copy_gone`.
     If one fails, follow `docs/deployment-runbook.md` "Recovering a failed migration".
   - Check: run a scan on nw-dev-store-2 from the app. Results look as before, there's no
     "Make a clean copy" button and no clean copy lines, and the Railway logs show no
     `clean-copy` errors.

## B. Approval day (approved 2026-11-11; legal published 2026-11-11, step 1 DONE)

3. **Read the approval.** Note any conditions Shopify attaches (scope wording, usage
   limits, review steps). If it differs from "themeDuplicate + themeFilesUpsert into an
   unpublished copy", STOP and re-plan.
4. **Add the scope.** In `shopify.app.toml`, add `"write_themes"` to `optional_scopes`
   (keep `scopes = "read_themes"`), then run `shopify app deploy` (config only).
   - It's optional, so existing installs aren't re-prompted. A merchant grants it from
     the select page's "Allow theme changes" button.
   - Check: the new app version in the Partner Dashboard lists write_themes as optional.
5. **Decide how to turn it on (decision for Nathan).** `CLEAN_COPY_ENABLED=true` is
   global: every Professional shop gets the button at once.
   - Option a (CHOSEN 2026-11-11, built): set
     `CLEAN_COPY_SHOPS=nw-dev-store-2.myshopify.com` in Railway with `CLEAN_COPY_ENABLED`
     unset, so step 6 runs on the dev store only. Exact `*.myshopify.com` domains,
     comma-separated; `*` or a bare handle never matches.
   - Option b: flip the flag during a quiet window and run step 6 right away. The dev
     store must be on the Professional plan.
6. **First live run on nw-dev-store-2.** Scan, then Make a clean copy, select, Allow
   theme changes (grant the scope), and start the run.
   - **gc-tib.17 probe:** on a fresh run with no theme edits, the result page must NOT
     say the live theme changed (`LIVE_THEME_CHANGED_COPY`). If it does, `themeDuplicate`
     bumps the live theme's `updatedAt`. STOP: turn the flag off and fix `liveThemeState`
     before anyone else sees it.
   - The result reads "13 of 13" (or similar). In Online Store > Themes, the copy is a
     draft and the live theme's "Last saved" is unchanged. In the code editor the copy
     has the lines removed and the live theme still has them.
   - Preview and editor links open the copy.
   - **Way back (gc-tib.20):** leave the result page and return to the scan page, then
     click "View result". Delete the copy in the admin and open View result again: no
     "don't publish" warning, and "That copy has since been deleted" shows.
   - **Decline path:** on a second store or after revoking the scope, decline the scope
     prompt. The select page shows the declined note and nothing runs.
7. **Canvas (gc-tib.12, launch follow-up).** If a store with Canvas access is available,
   run Live checks A-C in `docs/spikes/2026-11-03-gc-dg5e-canvas-themes.md`. If not, leave
   the bead open and don't market Clean copy to Canvas users. This doesn't block launch.
8. **Turn it on for everyone** (if option a was used): set `CLEAN_COPY_ENABLED=true` and
   clear the allowlist.
9. **Launch copy, same day (gc-tib.19).** Every "read-only / never edits your theme" line
   listed in the bead: site page + JSON-LD, both guides, `llms.txt`, Settings line, the
   Sidekick extension text, the listing, and the help page. Bump the sitemap lastmod and
   log the listing change in `strategy/listing-experiments.md`.
   Message: "Removes leftover code in a copy of your theme. You preview it and publish it
   yourself. Your live theme is never changed."

## Rollback

- Unset `CLEAN_COPY_ENABLED` and redeploy the env. Preflight refuses new runs, and the
  worker exits before any Admin call.
- Runs already finished keep their copies in merchants' theme libraries (unpublished).
  Their result pages still open, and the scan page's "View result" lines (with any
  "don't publish" warning) stay visible with the flag off or the shop off the
  allowlist (audit r5 M1), so a rollback is just the env change.

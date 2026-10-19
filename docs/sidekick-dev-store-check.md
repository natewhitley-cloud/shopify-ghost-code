# Sidekick tools: dev-store check (gc-5nok)

The `sidekick-tools` extension and its two backend routes are built and unit
tested (including against the real auth library, 1.2.0) but have NOT been run
inside Sidekick for GhostCode. ClearSignal (ba-lgun) ran the same pattern on
`nw-dev-store-2` on 2026-10-18: the sandbox attached the Authorization
header, the `app://app/...` links opened the page, and `{ results: [...] }`
was accepted. FraudPilot (ft-68j) ported it next. What is new here is
GhostCode's data, its plan gates, its URL setup and its older auth library.
About 25 minutes.

## GhostCode differences

- **The preview hits the local tunnel.** `shopify.app.toml` has
  `automatically_update_urls_on_dev = true`, so during `shopify app dev` the
  app URL points at the CLI's tunnel and the extension's relative fetch goes
  to your local server, not to production. Confirm it in step 4 (Network tab
  host is the tunnel). Nothing needs to be deployed for the check.
- **The local server needs an `.env`, and that `.env` is PROD.** Worktrees
  have none. Copy the main checkout's: `cp ../ghost-code-app/.env .env`. The
  local server then reads the PRODUCTION database. These routes are
  read-only, but treat it as prod: no scripts, no migrations, no seeding, no
  `npx prisma` commands. Delete the copy when done (step 10).
- **Auth library 1.2.0.** A request with no session token gets a 302 to
  `/auth/login` (2.0+ answers a 200 App Bridge page). Either way the
  extension's `fetchTool` turns it into "GhostCode could not read this data
  right now." (pinned in `tests/routes/api.sidekick.real-library.test.ts`).

## Before you start

- Branch `feat/gc-5nok-sidekick` (worktree `~/shopify/gc-5nok`).
- The dev store needs a completed scan with findings in several impact areas,
  ideally one known malicious finding (or check that case on the scan page of
  a store that has one), and a speed result.
- To check both gates, run once on PROFESSIONAL and once on FREE (Standard
  behaves like Free for speed and like Professional for the scan).

## Steps

1. `cp ../ghost-code-app/.env .env` (see the warning above).
2. `shopify app dev --store nw-dev-store-2`. If the CLI rejects the
   hand-written `uid` in `extensions/sidekick-tools/shopify.extension.toml`,
   delete that line and rerun; the CLI writes a new one. Commit the CLI's
   uid. If it rejects `api_version = "2026-07"` for the extension, report it
   before changing anything.
3. Open the dev store admin in the browser (not the CLI `p` shortcut), open
   the Dev Console, click the `admin.app.tools.data` preview link. Sidekick
   opens.
4. Ask, with browser devtools open on the Network tab:
   - "What did GhostCode find in my theme?" Expect GET
     `/api/sidekick/latest-scan` = 200 with an Authorization header, after an
     OPTIONS preflight = 204. Note the request host (the tunnel).
   - "What should I fix first in my theme?" Same tool; Sidekick should name
     the top findings by impact area (for example "Speed"), never by
     severity, and include the link to the scan.
   - "How fast is my store?" Expect GET `/api/sidekick/speed` = 200.
   - "Which apps slow my store down?" Same tool; Sidekick names the apps
     with their processing time and download size, and the caveat that some
     apps skip loading during speed tests.
     A CORS error means the `cors()` wrapping is wrong; a 401 means the token
     failed validation. If the sandbox does NOT attach the Authorization
     header, the request shows a 302 to `/auth/login` and Sidekick says
     GhostCode could not provide the data.
5. Compare Sidekick's answers to the app:
   - Scan: Home. The total, the impact areas and their counts, the "Start
     here" findings and the Theme health verdict must match. Known malicious
     code (if any) must be named first. The link opens the scan inside
     GhostCode (`app://app/scans/<id>`).
   - Speed: Store speed page. Date, pages, score, timings and the costliest
     apps must match what the page shows. The link opens Store speed
     (`app://app/speed`). Sidekick must never say a value is 0 when the page
     says "Not available" or "Not measured".
6. Privacy: in the Network tab, read both response bodies. They must hold
   counts, fixed GhostCode copy, theme file locations, app names, theme
   names and speed values only: no code snippet, no customer data, no
   tokens, no ids other than the scan id inside the `app://` link.
7. On FREE: ask the same questions.
   - Scan: same counts and impact areas as Home on Free; the top findings
     are only ones Free's scan page already shows in full; known malicious
     code is still listed in full. A Theme health check Free does not run
     reads "Not included in the current plan.", with no plan names.
   - Speed: before the free test, Sidekick says it has not been run and
     can be run once from the Store speed page. After it, only the homepage
     score, timings and ONE app. No upgrade pitch. If Sidekick adds one on
     its own, tighten `instructions.md`.
8. Edge states (as far as the store allows): a scan running (Sidekick says
   so), a password-protected storefront for speed (Sidekick says the
   storefront is password protected and cannot be tested).
9. Make one request fail (stop the dev server mid-question). Sidekick should
   say GhostCode could not provide the data, not show a raw error.
10. Ctrl-C, then `shopify app dev clean` so the store goes back to the
    released app version. Delete the copied `.env` (`rm .env` in the
    worktree only).

## Ship (separately, deliberately)

1. Publish the privacy-policy addition first (draft:
   `docs/privacy-sidekick-draft.md`; Nathan approves and publishes it in
   `data-integrity-suite`).
2. Routes first: merge and push to main (Railway deploys it). The routes are
   inert until an extension calls them: nothing in the app links to them.
3. Check `https://app.alpenglowsoftware.com/health` reports the merged SHA,
   then an unauthenticated preflight for each route must print `204`:

   ```bash
   for p in latest-scan speed; do
     curl -s -o /dev/null -w "$p %{http_code}\n" -X OPTIONS \
       -H 'Origin: https://extensions.shopifycdn.com' \
       -H 'Access-Control-Request-Method: GET' \
       -H 'Access-Control-Request-Headers: authorization' \
       -H 'User-Agent: Mozilla/5.0' \
       "https://app.alpenglowsoftware.com/api/sidekick/$p"
   done
   ```

4. `shopify app deploy`, which publishes a new app version with the
   extension and the `[sidekick]` summary to ALL merchants. Read the deploy
   diff and abort on anything beyond `[sidekick]` and the `sidekick-tools`
   extension. Note the previous version first.
5. Rollback: `shopify app release --version <prev>`.

Record the results on bead `gc-5nok`.

## Session Handoff: 2026-11-03 (evening), gc-tib exemption request prepared, NOT submitted

### RESUME HERE (evening, supersedes the header below)
- Batch below is DEPLOYED: prod = 9c75db8 (smoke green). The "NOT pushed" header further down is stale.
- **gc-tib exemption: NOT submitted yet (Nathan paused).** Text is final below; submit twice (prod + test record).
- Where: Google Form "Online Store Protected Scope Exemption Request":
  https://docs.google.com/forms/d/e/1FAIpQLSfZTB1vxFC5d1-GPdqYunWRGUoDcOheHQzfK2RoEFEHrknt5g/viewform
  (linked from shopify.dev themeFilesUpsert / themeDuplicate / themePublish pages, "submit an exception request"). No Partner Dashboard button.
- **NOT the Partner Dashboard "Protected customer data" panel** (API access page; Customer service / Store management / ... checkboxes). That is for customer/order data; GhostCode reads none. Nathan opened it, ticked nothing; leave it alone. If the API access page shows a separate theme/Online Store scope section, screenshot it before filling.
- Form fields (all required): Email, consent, Partner Account ID (Partner Dashboard URL / Settings), Contact name, App name, App Store URL, Client ID, scope history = "No, this is my first request". The fetched form had no free-text use-case box; if page 2 has none, send the text when Shopify replies.
- Prod record: App Store URL https://apps.shopify.com/ghost-code, client ID 3e80de5fa6065400e94de3f1fe7f0c8b. Test record: URL field "Not listed: development/test record of GhostCode, listed at https://apps.shopify.com/ghost-code"; client ID from Partner Dashboard > Apps > test app > Client credentials (not in repo).
- No confirmation email / status page: screenshot each submission with date. Day 0 = submission date; no answer in 14 days or denied -> D1 fallback (cleaned-theme ZIP export, Residue model). Chase via Partner Support with both client IDs.
- Change vs spike §1.6: the 1.1.3 line now says "GhostCode does not sell or distribute themes" (app has no Theme Store link, so the old "we direct merchants to the Theme Store" claim would be false).

#### Flag reviews + suspicious-code logging (2026-11-04 ~00:30Z)
- **Settings drift (gc-bwci): keep dark.** 13 scan_signal rows since 10-09 (nw-dev-store-2 x7, paw-naturals x4, one Free store x2), SETTINGS_DRIFT=0 on all. Cumulative 20 prod scans + 3 dev themes, 0 hits, no true positive, only 2 real merchant stores. Bottleneck is install volume, not time. Alerts are live, so a flip sends any FP to merchants.
- **Checkout guard (gc-1q1s.1): CLOSED, clean.** 11 guarded shops, 0 incidents ever, paw-naturals 169 readable checks; last outcomes 5 ok / 6 paused_password / 0 unreachable; no datacenter-challenge signal. Caveat kept: empty /cart may show no checkout button on some themes.
- **SUSPICIOUS_CODE_SIGNAL_ENABLED=true set in prod** (Nathan go; Railway redeploy of 9c75db8 SUCCESS 00:29Z, /health 200, no pending migrations). Log-only, merchants see nothing. Review scan_signal.suspiciousCode ~2026-11-18 to 12-02 (gc-gayw); expect few rows (13 scans in 25 days). gc-yn50 also still blocked on release 2 deploy B.
- How the reads were done: `railway run -s Postgres -- sh -c "PGOPTIONS='-c default_transaction_read_only=on' psql \"\$DATABASE_PUBLIC_URL\" -X -q -f <file.sql>"` from ~/shopify/ghost-code-app (linked). scan_signal: OpsEvent eventType='scan_signal', key=scanId, metadata->'detectorHits' (absent type = 0).

#### Paste-ready justification (fill the brackets)

> **App:** GhostCode (Alpenglow Software LLC). Listed at https://apps.shopify.com/ghost-code. This request covers our [production | test] app record, client ID [ID]. Please apply the same decision to our other record, client ID [ID], which we are submitting separately.
>
> **What the app does today:** GhostCode is a theme-code audit tool. With read_themes only, it scans a store's theme files and reports code that uninstalled apps left behind: external app scripts and stylesheets, connection hints to app CDNs, and `{% render %}` calls to app snippets. Each finding shows the file, the line, and the app it came from. Merchants currently delete this code by hand in the code editor. Shopify's own docs describe the problem: "Uninstalling apps often leaves the code edits, or ghost code, behind."
>
> **What we want to add, and why theme app extensions can't do it:** an optional "clean copy" action for merchants who choose it. The leftover code sits in the merchant's existing theme files, so removing it means editing those files. App embeds and app blocks can only add app-owned code. They cannot remove code another app wrote into the theme.
>
> **Exactly what we would write:**
> 1. `themeDuplicate` of the published theme. We never write to the published (MAIN) theme. The original stays untouched as a full backup.
> 2. `themeFilesUpsert` on that unpublished copy only. Each edit deletes one exact tag the merchant selected: a `<script src>` or `<link>` pointing to a known app CDN, or a `{% render %}`/`{% include %}` line for a known app snippet. We never delete files, never edit JSON/config files, and never edit files we didn't flag.
> 3. Before each write we check that the file is byte-identical (checksum) to what we scanned, and we skip the file if it isn't. After writing we re-read the file to confirm the result.
> 4. We do not publish. The merchant previews the copy and publishes it themselves in Shopify admin. If they don't like it, the original theme is still there.
>
> **Scopes and controls:** write_themes will be an optional scope, requested only when a merchant on our Professional plan clicks the clean-copy action. Every other install stays read-only. The merchant ticks each finding, confirms the source app is uninstalled, and sees a per-file diff before anything is written. We do not use themeFilesDelete, themeFilesCopy, themeCreate, themeDelete, themeUpdate or themePublish.
>
> **Category:** we believe this fits the developer tooling / theme maintenance category in Built for Shopify requirement 3.2.2. We also follow the backup-before-change pattern, because the original theme is kept as a complete copy. GhostCode does not sell or distribute themes.
>
> **Question:** while this request is reviewed, can our test app record use these mutations on development stores?
>
> Contact: Nathan Whitley, [email], Partner ID [ID].

Leave out install counts, "Shopify-approved" language, competitor names. Re-check the Shopify quote at https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/migrate before pasting.

#### gc-tib decisions
- Agreed: D4 A (Pro only), D7 A (optional write_themes, legal rewrite first, no mass email).
- Still open (recommendations): D1 A + dated ZIP fallback, D2 A (merchant publishes), D3 A (4 safe-to-remove types), D5 A (embed block + uninstall checkbox), D6 A (re-detect span, store offsets only), D8 update product-strategy.md, D9 exclude Canvas. Nathan can answer "take all recommendations".
- gc-rch: Nathan still owes review of the safe-to-remove mapping + label wording.

#### Next-up beads to consider (recommended order)
1. **gc-tib pre-approval work:** slices 1-3 (span model, splice engine, schema; serve both write path and ZIP fallback), slices 4-5 (mocked orchestrator, UI), legal drafts (D7) + product-strategy.md (D8). Only slice 7 (live dev-store write) waits on the exemption. Needs D1-D9 answers first.
2. **gc-dg5e** Canvas check (P2, blocks gc-tib): run the GraphQL checks in docs/spikes/2026-11-03-gc-dg5e-canvas-themes.md on a dev store.
3. **gc-2x0o** (P3 bug): theme-side active-app suppression reads as Fixed in the differ; adjacent to gc-k71c, cheap while fresh.
4. **Post-deploy watch:** paw-naturals Magisto one-time New 1 / Fixed 1 (check IgnoredFinding for old host fingerprint); gc-uczg decide ~2026-11-17 from digest SCANNER SIGNALS.
5. **Flag decisions:** done 11-04 (see above): gc-bwci stays dark, gc-1q1s.1 closed, suspicious-code logging on; next look ~11-18.
6. **P1 positioning:** gc-rrh.4 change tracking (in progress), gc-qafb quiet-week receipt.
7. **Timely:** gc-ujsc summary email ScriptTag 2027-03-01 countdown + "app removed, left N items".
8. **Possibly stale, verify vs code before building:** gc-i6du (Home theme health checklist shipped 10-12), gc-fed (may be covered by live gc-pa3q).
9. **Hygiene / polish:** gc-8tyc (npm audit + Dependabot), gc-o7y7, gc-wcad, gc-0a3h. Owner outreach: gc-i59y (paw-naturals note, then neutral review ask).

---

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

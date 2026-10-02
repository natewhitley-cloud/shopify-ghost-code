# Session Handoff 2026-10-02 (pm): alerts dark, embed audit dark, Inngest cuts, GHOST_LAYOUT fix — DEPLOYED

Supersedes the top of `handoff-2026-10-02-noise-fixes-fp-fixes-DEPLOYED.md` (morning batch, e196a7a).

## What got done (all on origin/main, deployed)
Three deploys today: `e196a7a` (morning), `5021704`, `73f3f0b` (20:00Z; Deploy+smoke+CI green, Inngest sync 200).
- gc-6lw root ErrorBoundary: random 404 = one access-log line, no stack (live-verified).
- gc-fed app-embed audit: APP_EMBED_OFF + GHOST_APP_EMBED, DARK behind `APP_EMBED_LIVE_ENABLED`. GHOST_APP_EMBED can never fire (gc-n02p: empty `ORPHAN_GRADE_CORROBORATION_TYPES`).
- gc-syz merchant monitoring emails (slices A/B/C + blockers gc-1qt0, gc-rvo0, gc-252x, gc-mb9k): DARK. Nothing sends or renders without `MERCHANT_ALERTS_ENABLED=true` + `MERCHANT_ALERT_FROM` (RESEND_API_KEY already set).
- gc-vi7b GHOST_LAYOUT (LIVE detector): filename-only attribution (`LAYOUT_BUILDER_RULES`), pattern-only candidates, template usage check, completeness guard. Merchant-visible: the 22 prod layout findings (5 shops) re-attribute or resolve on next scan.
- gc-ngx6 Inngest cuts: watch-stale-scans removed; `check-scan-stale` fans out from `scan/requested`; deep-health hourly :37; slots moved off :00/06:00. ~247 cron runs/day -> ~31 + ~2-4 per scan.
- gc-i3vk: `markScanStarted` PENDING-only transition; scan-theme exits if no longer PENDING.
- gc-ecr SETTINGS_DRIFT parse fix live, findings suppressed (`SETTINGS_DRIFT_LIVE_ENABLED` off).
- d27737d: equivalence test 12.5s -> 0.37s (was the unexplained suite-timeout flake).

## Key decisions (don't re-litigate)
- Audit rule: only HIGH blocks; MED/LOW -> beads; one audit right before each deploy. Three audits ran today, 0 HIGH.
- 5A: build paid-shop alerts dark first; Free "locked findings" email is MARKETING (legal: opt-in for CA/EU, Shopify API-terms question) -> separate consent design later, not built.
- Alert baseline = LAST ALERTED scan (throttled scans delay, never drop findings); 90% window tolerance; alerts only on types live in BOTH scans (`Scan.liveFindingTypes`, NULL = legacy -> skip).
- Unsubscribe is a RESOURCE route (RR CSRF check rejects `Origin: null` from RFC 8058 POSTs on document routes). Body link uses `#t=` fragment; token rotates on use.
- GHOST_APP_EMBED premise was wrong (my spec D1): detectors report app code PRESENT, not app gone. Sound replacement = gc-43gv.
- Inngest 6A/7A + slot plan (gc-ngx6 comments); ClearSignal hourly at :02/:07 on the shared account.

## Patterns & discoveries (also saved to global memory)
- RR7 ships only dist/development: DefaultErrorComponent always console.errors -> every app needs a root ErrorBoundary ([[rr7-default-errorboundary-always-logs]]).
- Shopify theme JSON (settings_data.json, templates) starts with a `/* */` header; bare JSON.parse silently failed -> SETTINGS_DRIFT never fired ([[shopify-theme-json-comment-header]]). Use `parseThemeJson`.
- `appByHandle(h).installation` is hidden for other apps; install state is unknowable. Embed entries survive uninstall.
- Shopify CLI `shopify store execute` + `theme pull --only` (store auth for nw-dev-store-2 is set up) = real-theme validation without prod writes.

## Pending verification (needs Nathan)
1. Run a manual **Scan** on nw-dev-store-2 in the embedded app, then check: one `check-scan-stale` run sleeping ~15m then `checks: 1`; `layout/theme.pagefly.liquid` (PageFly) still flagged; new Scan row has `liveFindingTypes` without SETTINGS_DRIFT/APP_EMBED_*.
2. Heartbeat check: `cron_heartbeat` for `monitor-deep-health` lands at :37 hourly; no api_error/function_failure since 20:00Z (a background check was queued for 20:41Z in the session; re-run read-only if its result is lost).
3. Inngest dashboard: delete any alert on `watch-stale-scans`; confirm `check-scan-stale` registered.

## Blocked / owner actions
- gc-syz.8: Resend sending subdomain DKIM/SPF in Northwest DNS; Resend open/click tracking OFF; accept Resend DPA.
- gc-syz.9: privacy draft `ae7f35a` on data-integrity-suite branch `ghost-code-monitoring-emails` (NOT published; repo left on `main`). Re-date at publish. Publish BEFORE enabling alerts. Optional: in-app notice to existing paid shops; terms "missed alerts" disclaimer.
- Listing copy for when flags flip (Standard/Pro cards "Weekly/Daily rescans, email on new leftovers"; Free "Spot app embeds that are switched off") — not yet added to docs/gtm/listing-v2.md.

## Recommended next steps
1. Verification items above.
2. gc-bwci: wait for ~10 real scans (`scan_signal.detectorHits.SETTINGS_DRIFT`), then enable SETTINGS_DRIFT (pre-check: 0 FPs on 3 real themes).
3. Enabling alerts = gc-syz.8 + publish gc-syz.9 + set env vars. Expect one silent cycle (`baseline_unversioned`).
4. gc-1we (P1): external dead-man switch; Inngest outage detection is ~2h until it runs.
5. Backlog LOWs: gc-0xnx, gc-otn2, gc-387 (re-run social-meta corpus), gc-js9b, gc-7jt.

## Risks
- GHOST_LAYOUT completeness guard: one unparseable/BOM JSON template suppresses all layout findings for that theme, silently (gc-0xnx item 5).
- `ecom*`/`layouthub*` builder rules inferred from prod filenames, not vendor docs.
- Global Shopify CLI auto-upgraded to 4.8.4 this session.

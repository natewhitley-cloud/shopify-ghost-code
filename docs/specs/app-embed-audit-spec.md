# Spec: App embed audit + settings_data.json parsing fix (gc-fed, gc-ecr)

Status: APPROVED (decisions D1-D4 locked 2026-10-02: 1A, 2A, 3A, 4A; ready to implement after gc-ecr)
Beads: gc-fed (P2, feature), gc-ecr (P2, bug). Related: gc-tus (benign libs), gc-1ql (filename attribution).
Author: session 2026-10-02
Evidence: read-only spike on nw-dev-store-2 (3 themes), prod finding counts, shopify.dev docs (section 9).

## 1. Problem

Two problems, one file (`config/settings_data.json`):

1. **SETTINGS_DRIFT has never fired on a modern theme (gc-ecr, bug).** The Admin
   GraphQL theme-files API returns `settings_data.json` beginning with Shopify's
   auto-generated `/* IMPORTANT: The contents of this file are auto-generated ... */`
   block comment. `detectSettingsDrift` (`app/services/scan-engine.server.ts`, the
   `JSON.parse(settingsFile.content)` call) throws, and its `catch` returns `[]`.
   Verified on all 3 dev-store themes (live custom theme, Horizon, Debut). Prod: 0
   SETTINGS_DRIFT findings ever, out of 622 findings. No test fixture contains a
   real `settings_data.json`, which is why the suite never caught it.

2. **App embeds are invisible to Ghost Code (gc-fed, feature).** Theme app embeds
   live in `settings_data.json` under `current.blocks`. Nothing in `app/` parses
   them. Two consequences:
   - **Leftovers.** An uninstalled app's embed entry stays in the theme. Verified:
     PageFly is uninstalled on the dev store, yet its entry remains in the live
     theme with `disabled: false`.
   - **Silent "not running".** Shopify stops injecting storefront script tags on
     **2027-03-01** (apps cannot create or update script tags from 2026-10-01).
     Apps moving to theme app embeds only work if the embed is ON. A merchant
     who turned an embed off, or whose embed got switched off, has an app that
     silently does nothing on the storefront.

## 2. What the data looks like

```json
"current": {
  "blocks": {
    "1234567890123456789": {
      "type": "shopify://apps/pagefly-page-builder/blocks/app-embed/0f1e2d3c-...",
      "disabled": false,
      "settings": {}
    }
  }
}
```

- `type` = `shopify://apps/<embed-handle>/blocks/<block-name>/<extension-uuid>`.
- Per shopify.dev: embeds are OFF after install and an entry is only written once
  the merchant switches one on; switching it off later keeps the entry with
  `disabled: true`. So **`disabled: true` means "was on, someone turned it off"**,
  not "never configured". (Default-off embeds that were never enabled have no
  entry and are out of reach.)
- `<embed-handle>` is the app's extension handle, **not** its App Store handle:
  the dev store has `pagefly-page-builder` in the theme, while
  `appByHandle("pagefly")` is the App Store record and
  `appByHandle("pagefly-page-builder")` returns null.

## 3. What we can and cannot know

| Question                                                | Answer                       | Basis                                                                                                                                                                                                                                                    |
| ------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which app embeds are in the theme, on or off            | **Yes**                      | `settings_data.json`, `read_themes` (already granted)                                                                                                                                                                                                    |
| Is that app still installed?                            | **No**                       | `appByHandle(h).installation` is null for every app other than the caller, incl. installed ones. `previouslyInstalled` was `true` for both an installed app (ClearSignal) and an uninstalled one (PageFly). `appInstallations` is Shopify-internal only. |
| Does the app rely on script tags?                       | **No**                       | Script tags are per-app isolated (same blocker as orphaned webhooks).                                                                                                                                                                                    |
| Does Shopify render an uninstalled app's enabled embed? | **Unverified** (believed no) | See V1, section 7.                                                                                                                                                                                                                                       |

Spike caveat: the `appByHandle` test ran as the Shopify CLI connector app, not
Ghost Code's token. Re-check once with Ghost Code's token during implementation
(V2). If Ghost Code _can_ see `installation`, the design simplifies (section 8, D1).

Because install state is unknowable, every finding below is worded conditionally
and must never assert "this app is installed" or "this app is uninstalled".

## 4. Goals / non-goals

Goals

- Fix `settings_data.json` parsing once, shared by every reader (DRY).
- Surface app embeds that are **off** (possible silent breakage, deadline-driven).
- Surface **enabled** embeds only when other scan evidence says the app is gone.
- Name the app for each embed.

Non-goals

- Detecting never-enabled embeds (no entry exists).
- Telling merchants which apps are installed (impossible; see section 3).
- Editing `settings_data.json` (Ghost Code is read-only; the fix is the theme editor).
- Script-tag inventory for other apps (not visible).

## 5. Design

### 5.1 Shared parser (gc-ecr, ships first)

New `parseSettingsData(content: string): Record<string, unknown> | null` in
`app/services/scan-engine.server.ts` (next to the detectors; move to `app/lib/`
only if a second module needs it):

- Strip exactly one **leading** block comment (`^\s*\/\*[\s\S]*?\*\/`), then
  `JSON.parse`. Do not strip comments elsewhere (a `/*` inside a JSON string
  value must survive).
- Return `null` on malformed JSON (unchanged graceful-skip behavior).
- Linear on adversarial input: the lazy match is anchored and terminates at the
  first `*/`; add a ReDoS case for an unterminated `/*` flood.
- `detectSettingsDrift` and the new embed detector both call it.

### 5.2 New finding types

Two types (see D2), both theme-file only, no new scope, no API calls:

**APP_EMBED_OFF**: an entry with `disabled: true`.

- Severity MEDIUM until 2027-03-01, then HIGH (computed from scan date; see D4).
- Lane: primary `customers-see-it`, urgency `compounding`; agentic false.
- Safety label: `verify-first`.
- Description: `"{App}'s theme app embed is turned off."`
- Remediation copy (`finding-remediation.ts`): "If you still use {App}, it isn't
  running on your storefront: turn it on in Online Store > Themes > Customize >
  App embeds. Shopify stops loading older script-tag installs on March 1, 2027,
  so apps that moved to app embeds only work when the embed is on. If you
  removed {App}, this entry is leftover and safe to leave."

**GHOST_APP_EMBED**: an entry with `disabled: false` **and** corroborating
evidence that the app is gone: the same scan has at least one other finding
attributed to the same app (e.g. GHOST_LAYOUT `theme.pagefly.liquid`,
GHOST_SNIPPET `pagefly-main-js`). Mirrors GHOST_PRICE's
corroborating-evidence rule; an enabled embed alone is never flagged (every
active app's embed looks exactly like this, so flagging it would be a false
positive on every store).

- Severity LOW. Lane: primary `housekeeping`, urgency `whenever`.
- Safety label: `leave-alone` (remove via theme editor, never hand-edit JSON).
- Description: `"{App}'s app embed is still switched on, and {App} left other code in this theme."`

Both: `filename = "config/settings_data.json"`, `lineNumber = 1` (same
convention as SETTINGS_DRIFT), `codeSnippet` = the entry JSON truncated to 300
chars, `appName` from 5.3.

Corroboration needs the other detectors' findings, so GHOST_APP_EMBED runs as a
post-pass in `scanThemeFiles` after all per-file and cross-file passes (like
Pass 5 duplicate-library), reading the in-memory findings list.

### 5.3 Embed handle -> app name

- Add optional `embedHandles?: string[]` to `AppSignature`
  (`app/data/app-signatures.server.ts`) and `identifyAppFromEmbedHandle(handle)`
  in `app/services/app-lookup.server.ts` (KEEP IN SYNC note in the signatures
  file applies). Seed with handles we can verify from real themes; starting set:
  PageFly `pagefly-page-builder`. Do not guess handles.
- Fallback when unknown: humanize the handle (`pagefly-page-builder` ->
  "Pagefly Page Builder") and set `appName` to that string. The finding still
  fires for APP_EMBED_OFF; GHOST_APP_EMBED requires a matched signature (the
  corroboration needs a canonical app name to join on).
- Exclude our own portfolio apps' handles? No: a merchant can uninstall
  ClearSignal too. Treated like any app.

### 5.4 Registration footprint (from the CHECKOUT_SUNSET commit e5b4cd9)

Per new type: `prisma/schema.prisma` enum + additive migration;
`severity-classifier.server.ts`; `finding-classification.ts`;
`finding-consequence.ts`; `finding-remediation.ts`; `finding-safety.ts`;
`models/finding.server.ts` count map; `routes/app.scans.$scanId.tsx` label;
`inngest/functions/scan-theme.ts` gating; tests for each exhaustive map.

### 5.5 Plan gating

See D3. Recommendation: detect on **all plans**; Free sees them under the
existing preview rule (up to 5 shown in full, rest counted in the upgrade
teaser by lane).

### 5.6 Rollout

Both changes turn on code that has never run in prod (SETTINGS_DRIFT has
effectively been off since launch). Soft-launch behind
`APP_EMBED_LIVE_ENABLED` and `SETTINGS_DRIFT_LIVE_ENABLED` (the
`DANGLING_REFERENCE_LIVE_ENABLED` pattern in `scan-theme.ts`): detectors run
and emit counts to `scan_signal` (detectorHits) but persist no findings until
the flag is on. Turn on after precision review (section 7, V3).

Diff impact: the first scan after enabling will show these as "new" findings
for every shop. Acceptable (they are new to the merchant); call it out in the
deploy handoff.

## 6. Tests

- `parseSettingsData`: header present / absent / header-only / `/*` inside a
  string value preserved / malformed -> null / unterminated `/*` flood linear.
- **New fixture**: a real `settings_data.json` (header + `current.blocks` +
  `current.sections`) copied verbatim from a dev-store theme, added to
  `tests/fixtures/` with provenance. Regression test: SETTINGS_DRIFT fires on a
  stale section in it (fails on HEAD today).
- APP_EMBED_OFF: one per `disabled: true` entry; none for `disabled: false`;
  missing `blocks`; non-app block types (`shopify://...` theme blocks without
  `/apps/`) ignored; malformed `type`; known vs humanized app name.
- GHOST_APP_EMBED: enabled + same-app GHOST_LAYOUT -> flagged; enabled alone ->
  not flagged; enabled + finding for a _different_ app -> not flagged; disabled
  - corroboration -> APP_EMBED_OFF only (no double finding).
- Severity date switch at 2027-03-01 (fake timers).
- Every exhaustive map covers both types (existing count tests).
- Plan gating per D3; flag off -> zero findings persisted, scan_signal counts present.
- A/B revert proof for parser + both detectors.

## 7. Verification before enabling

- **V1** Does Shopify render an enabled embed whose app is uninstalled? Load the
  dev-store storefront (password page) and check for PageFly embed assets. If it
  DOES render, GHOST_APP_EMBED moves to `customers-see-it` and severity MEDIUM.
- **V2** Re-run the `appByHandle` check with Ghost Code's own token. If
  `installation` is visible to Ghost Code, revisit D1.
- **V3** Precision review: run both detectors (flag off) over the 3 dev-store
  themes plus the first ~10 prod scans' scan_signal hits; read every hit before
  enabling. SETTINGS_DRIFT especially: never tested on real data.

## 8. Decisions (locked 2026-10-02: D1=A, D2=A, D3=A, D4=A)

- **D1 Scope of enabled embeds.** (A, recommended) Flag enabled embeds only with
  same-app corroboration (GHOST_APP_EMBED as above). (B) Never flag enabled
  embeds; show them only in an unflagged "App embeds in your theme" inventory.
  (C) Flag every enabled embed as "verify". C is a guaranteed false positive on
  every active app.
- **D2 One type or two.** (A, recommended) Two types, APP_EMBED_OFF and
  GHOST_APP_EMBED: different lane, safety label and urgency, and every map is
  per-type. (B) One type with the variant in `description` (DANGLING_REFERENCE
  pattern); fewer files, but lane/urgency/safety would be wrong for one variant.
- **D3 Plan gating.** (A, recommended) All plans, normal Free preview. The
  deadline is the strongest upgrade hook we have; hiding it from Free (B,
  Standard+ like CHECKOUT_SUNSET) removes the hook from the teaser.
- **D4 Deadline escalation.** (A, recommended) MEDIUM before 2027-03-01, HIGH
  after, computed at scan time. (B) Fixed MEDIUM.

## 9. Sources

- shopify.dev, Theme app extensions configuration (app embed storage,
  `disabled` semantics, default-off).
- shopify.dev changelog, online-store-script-tags deprecation (read 2026-09-29,
  cited on gc-fed).
- shopify.dev Admin GraphQL `App` object: `installation` ("Returns null if the
  App isn't installed"), `previouslyInstalled`.
- Spike results recorded on bead gc-fed (2026-10-02).

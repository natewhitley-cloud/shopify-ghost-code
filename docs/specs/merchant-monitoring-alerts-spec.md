# Spec: Merchant-Facing Monitoring Alerts + Subscription Packaging

> **Superseded in part (gc-ol95, 2026-10-09):** the per-change "new findings" alert below was replaced by ONE summary email per store after each SCHEDULED scan (Professional weekly, Standard monthly, Free never), sent only when something changed and only with consent (Home notice shown or Settings opt-in). Where this spec conflicts, `docs/pricing-and-plans.md` ("Merchant summary emails") and `app/services/summary-email.server.ts` win.

> Restored 2026-10-02 from commit 2874b7a (written on a side branch, never on main). Decision 2026-10-02 (Nathan, option 5A): build the paid-shop alerts below DARK first (MERCHANT_ALERTS_ENABLED off); a one-time Free "locked findings" follow-up email reuses this infra later, after a legal/consent check. Verify every file/line reference against current code: this spec predates many changes.

**Status:** DRAFT
**Created:** 2026-09-01
**Author:** Claude Opus 4.8 (user-initiated)

---

## Problem Statement

Turn the already-built continuous-scan spine into a retention subscription reason-to-stay by alerting the MERCHANT (not just the operator) when a scheduled/auto rescan surfaces NEW orphaned theme-code findings.

**Grounded current state** (verified in `/Users/nathanwhitley/shopify/ghost-code-app`):
- Scanning already runs on 3 origins: MANUAL (merchant click), SCHEDULED (weekly Inngest cron `poll-check-shop`), AUTO_PUBLISH (`themes/publish` webhook rescan, Professional tier).
- Diff engine EXISTS: `app/services/scan-differ.server.ts` (`diffScans`) computes new-vs-resolved findings between consecutive scans; gated by `canUseScanDiffing` in `app/lib/plan-gating.server.ts`.
- Diff UI + dashboard "new findings" callout already shipped (gc-06e.5; `app/routes/app.scans.$scanId.diff.tsx`).
- Alerting infra EXISTS but is OPERATOR-ONLY: `app/lib/notifications.server.ts` + `app/services/ops-alert.server.ts` email Nathan on Inngest failures via Resend (`RESEND_API_KEY` + `OPS_ALERT_EMAIL`, shared with ClearSignal). NO merchant-facing email/notification exists.
- Scopes: `read_themes` only. Plans: Free (1 scan/mo), Standard (weekly limit), Professional (unlimited + auto-publish rescan).

**The gap this spec covers:** merchant-facing alerting on non-empty new-findings diffs, plus packaging cadence/alerting as a tier lever.

**HARD PLATFORM CONSTRAINT** (must be reflected, do NOT spec around it): Shopify never notifies Ghost Code when a DIFFERENT app is uninstalled. `app/uninstalled` fires only for Ghost Code's own removal, and there's no readable installed-apps list. So alerting cannot be event-driven "on uninstall"; it must ride the existing periodic re-scan + diff. Copy/positioning = "continuous monitoring", never "instant on-uninstall alert".

**Key decisions the spec must pin:**
1. Alert trigger + throttle rule (only email on NEW findings, de-duped, rate-limited to avoid alert fatigue).
2. Merchant notification prefs + unsubscribe (transactional vs marketing consent).
3. Cadence-as-tier packaging (weekly=Standard, faster=Professional?) and whether alerting itself is plan-gated.
4. Email deliverability/sender identity (reuse shared Resend key or separate merchant sender?).
5. Where merchant email address comes from (Shop model / Shopify shop owner email).

---

## Context & Constraints

### Current state: scanning, diffing, alerting

**Scanning** runs through one Inngest pipeline (`inngest/functions/scan-theme.ts`), triggered by the `scan/requested` event from three origins (`prisma/schema.prisma`, enum `ScanOrigin`):
- `MANUAL`: merchant clicks Scan (via `dispatchScan`, `app/services/scan-dispatch.server.ts`).
- `SCHEDULED`: the poll/cron path. `inngest/functions/poll-check-shop.ts` creates a `SCHEDULED` scan and fires `scan/requested`. Standard gets weekly, Professional daily (per `getPlanFeatures`, `app/lib/billing.server.ts`, field `scheduledScan`).
- `AUTO_PUBLISH`: `app/routes/webhooks.themes.publish.tsx` dispatches a rescan, gated on `canUseAutoRescan` (Professional only, `app/lib/plan-gating.server.ts`).

The scan-theme job terminates in a single `finalize-scan` step (`inngest/functions/scan-theme.ts`) that sets status `COMPLETED` and writes `findingCount`/`skippedCategories`/`skippedFiles`. This finalize step is the one natural, already-idempotent hook point for a merchant-alert step: it is the only place a scan reaches a successful terminal state on the success path.

**Diffing (critical architectural finding).** `diffScans` (`app/services/scan-differ.server.ts`) is a pure, synchronous, side-effect-free function (no DB, no I/O). It is currently invoked in exactly ONE place: the diff route loader `app/routes/app.scans.$scanId.diff.tsx`, computed on-demand at page render and never persisted. It is NOT called anywhere in the Inngest pipeline. So new-findings are computed lazily when a merchant opens the diff page; there is no stored "new findings" result and no code path that reacts to a non-empty diff. Alerting therefore requires running `diffScans` inside the scan pipeline (in/after `finalize-scan`), pairing the just-completed scan against `getPreviousScanForTheme(shopId, themeId, beforeDate)` (`app/models/scan.server.ts`), the same helper the diff route uses.

**Alerting is OPERATOR-ONLY.** The entire email surface (`app/services/ops-alert.server.ts` + `app/lib/notifications.server.ts`) sends only to `OPS_ALERT_EMAIL` (Nathan), for Inngest failures. Subject lines are hard-prefixed `[GhostCode Ops]`. There is NO merchant-facing email, notification, in-app inbox, or template anywhere in the codebase.

### The hard platform constraint (reflected, not designed around)

Shopify never notifies Ghost Code when a different app is uninstalled; `app/uninstalled` fires only for Ghost Code's own removal (`markShopUninstalled`, `app/models/shop.server.ts`), and there is no readable installed-apps list under the `read_themes` scope. Alerting cannot be event-driven "on uninstall"; it must ride the existing periodic rescan + diff (SCHEDULED cron for Standard/Pro; AUTO_PUBLISH for Pro). Copy must say "continuous monitoring", never "instant on-uninstall alert".

### Where the merchant email address comes from (verified ABSENT today)

- The `Shop` model (`prisma/schema.prisma`) stores no email / owner-contact field (only `domain`, `plan`, timestamps, `hasSeenReviewPrompt`). `ShopMetadata` (`app/models/shop.server.ts`) confirms: no email.
- The Shopify-managed `Session` table DOES have `email`, `firstName`, `lastName`, `accountOwner` columns, but none of these fields are read anywhere in `app/` or `inngest/`. They are populated by `@shopify/shopify-app-session-storage-prisma` and currently unused. Session email is the individual authenticated user's email (may be a staff/collaborator, not the shop owner), and offline-session rows may not carry it reliably.
- No GraphQL `shop { email }` / `shop { contactEmail }` query exists anywhere in the codebase. So a reliable owner-contact address must be newly sourced: fetch `shop { email }` via Admin GraphQL inside a job (available under the current app install, no customer scope needed; it is shop-owner, not customer, data) and persist it on `Shop`. This is net-new work; nothing today captures or stores it.

### Consent / Shopify App Store constraints

- No notification-preferences, unsubscribe, opt-in/opt-out, or consent handling exists anywhere. This is greenfield.
- The alert is arguably transactional (a security/hygiene notice about the merchant's own store, which the merchant subscribed to monitor), but Shopify App Store rules and anti-spam law (CAN-SPAM/CASL) still push toward: a clear sender identity, an unsubscribe affordance, and using shop-owner email only for service messages, not marketing. The shop-owner email is protected merchant data; its use should be scoped to the monitoring service and covered by the privacy policy.

### Shared-key / infrastructure constraints

- `RESEND_API_KEY` is a single shared transport key used across ghost-code / ClearSignal / TaxDelta. Rotating it breaks all three; a merchant-email volume spike or a Resend suspension on this key would also take down operator paging. The default sender is `onboarding@resend.dev`, fine for internal ops but not for merchant-facing branded mail. A verified sending domain (and likely a separate `MERCHANT_ALERT_FROM` reputation-isolated sender) is needed so merchant volume cannot poison operator deliverability.
- Scope is `read_themes` only, with optional `read_translations`, `read_products`, `read_content`, `read_online_store_navigation`. No customer/email scope; `read_themes` cannot enumerate other apps (reinforces the hard constraint above).
- **Performance / safety in Inngest jobs:** any email send inside a job must be fire-and-forget and never-throw, matching the existing contract. An alert-send failure must never fail or retry a scan. `sendOpsAlert` already models this (returns a result, swallows every error, 5s `AbortSignal.timeout`); `notifyFunctionFailure` wraps it in an outer try/catch. The merchant path must inherit both behaviors, and the diff itself is cheap (pure in-memory), so the only added latency/failure surface is the email HTTP call.

---

## Prior Art

### 1. The operator-alert email pattern to mirror/extend

`app/services/ops-alert.server.ts`, `sendOpsAlert(subject, body)`:
- **Env-gated master switch:** returns `{sent:false, reason:"disabled"}` if `OPS_ALERT_EMAIL` unset; `no_transport` if `RESEND_API_KEY` unset. `getOpsAlertConfigStatus()` reports wiring without sending.
- **Transport:** single `fetch` POST to `https://api.resend.com/emails`, `Authorization: Bearer`, plaintext `text` body, 5000 ms `AbortSignal.timeout`.
- **Never throws:** every path returns an `OpsAlertResult`; non-OK gives `http_error`, exception gives `exception`.
- Subject prefix `[GhostCode Ops]` is baked in. A merchant channel needs a distinct sender/prefix and (per its own comment) was designed to "never collide with any future merchant email".

`app/lib/notifications.server.ts`, `notifyFunctionFailure(ctx)` is the reusable wrapper shape a merchant alert should copy: builds subject + plaintext body, `await sendOpsAlert(...)`, then records an OpsEvent, all inside one outer try/catch that swallows and logs (`notification-dispatch-failed`) so nothing propagates to Inngest. A `notifyMerchantNewFindings(...)` would be the direct sibling: same fire-and-forget, no-throw envelope, different recipient/sender/template and a plan gate.

**Extension decision (see Approach):** reuse `sendOpsAlert` verbatim (fast, but couples merchant mail to the ops sender/prefix and shared key) vs. a parallel `sendMerchantAlert` with its own `MERCHANT_ALERT_FROM`, verified domain, and unsubscribe footer (recommended for deliverability isolation, at the cost of duplicating the transport). Either way the env-gate + never-throw contract is the template.

### 2. The diffScans contract and "new finding" shape

`app/services/scan-differ.server.ts`, `diffScans(currentFindings, previousFindings, opts?)` returns `ScanDiff`:
```
newFindings:      Array<{ filename, findingType, severity, appName, description }>
resolvedFindings: Array<{ filename, findingType, severity, appName, description }>
unchangedCount:   number
```
A "new finding" is exactly that 5-field object: enough to render an alert line (app name, severity, file) without loading full snippets. Fingerprinting is a stable djb2 hash over `filename + findingType + normalized matched line`, deliberately resilient to snippet/context churn (LOG-10). `opts.skippedCategories` / `opts.skippedFiles` exclude un-audited categories/oversized files from `resolvedFindings` so a missing optional scope never fabricates a "resolved". The alert path must pass the scan's persisted `skippedCategories`/`skippedFiles` to avoid false diffs. The alert trigger is simply `newFindings.length > 0`. Inputs come from `getPreviousScanForTheme(...)` + the current scan's findings, exactly as the diff route already assembles them.

### 3. OpsEvent log: the idempotency / dedup / throttle substrate

`app/models/ops-event.server.ts` + `prisma/schema.prisma`. One append-only table, `recordOpsEvent(input)` that never throws. `OPS_EVENT_TYPES` is an open discriminator set. Read helpers already exist for exactly the dedup/throttle logic an alert needs: `getLatestOpsEvent(eventType, key)` and `countOpsEvents(eventType, sinceMs)`. Note: this spec recommends a dedicated `MerchantAlert` table instead of OpsEvent for GDPR-cascade reasons (see Data Model), but the OpsEvent pattern is the model to follow.

### 4. Plan-gating pattern to follow

`app/lib/plan-gating.server.ts` exposes boolean `canUseX(planName)` helpers (`canUseAutoRescan`, `canUseScanDiffing`, `canUseMultipleThemes`) that all delegate to `getPlanFeatures(planName)` (`app/lib/billing.server.ts`), the single source of truth `PlanFeatures` matrix. Cadence is already a tier lever here: `scheduledScan` (Free false / Standard weekly / Pro daily) and `autoRescan` (Pro only). Packaging alerting means adding a field to `PlanFeatures` and a helper following the identical shape. The gating truth is the stored `Shop.plan`, set only by the billing reconciler from Shopify's active subscriptions (per `.claude/rules/gdpr-and-billing.md`), never trust `plan_handle`.

### 5. Inngest job structure: how an alert step slots in

Jobs are built from `step.run(name, fn)` blocks, each independently memoized/idempotent on retry. Default 3 retries, `concurrency.limit: 5`. The clean insertion point is a new terminal `step.run("notify-new-findings", ...)` after `finalize-scan`: load current + previous findings, run `diffScans`, and only if `newFindings.length > 0`, the plan gate passes, and the dedup/throttle allows, call the never-throw merchant-send helper and record a ledger row. Because `diffScans` is pure and the send is fire-and-forget/no-throw, this step cannot fail the scan; and step memoization means an Inngest retry of a later step will not re-send (dedup backstopped by the ledger check). The `unauthenticated.admin(shop.domain)` pattern already used throughout these jobs is available if the send step needs to fetch `shop { email }` on the fly.

---

## Proposed Approach

### End-to-end flow

Alerting rides the existing periodic re-scan spine (per the hard platform constraint, no uninstall event exists). The `scan-theme` Inngest job already runs for all three origins. A new terminal step is appended after `finalize-scan`:

1. **Scan completes**: `finalize-scan` sets `COMPLETED`/`PARTIAL`.
2. **New step `notify-new-findings`** (fire-and-forget, never throws, mirrors the `notifyFunctionFailure` discipline):
   - **Origin guard**: only fires for `SCHEDULED` / `AUTO_PUBLISH` scans (read `scan.origin`). `MANUAL` scans are skipped: the merchant is already looking at the result in-app, so an email would be noise.
   - **Compute the diff server-side.** Reuses the exact same call the diff route uses: `getPreviousScanForTheme(shopId, themeId, scan.createdAt)` + `getFindingsForScan(scanId)`, then `diffScans(current, previous.findings, { skippedCategories, skippedFiles })`. Passing the same `skipped*` opts prevents a missing-scope category from surfacing false "new" findings.
   - **Trigger predicate**: proceed only if `diff.newFindings` is non-empty.
   - **Gating chain** (all must pass): `canReceiveAlerts(shop.plan)` AND `shop.alertsEnabled === true` AND not throttled/duped.
   - **Resolve recipient**, build the email, `sendMerchantAlert(...)`, then record a `MerchantAlert` ledger row for dedup/throttle.

Because `scan-theme` is the single convergence point for both scheduled and auto-publish rescans, one insertion point covers both cadences with no duplication.

### The 5 key decisions (recommended option first)

**(1) Trigger + throttle**
- **RECOMMENDED:** Email only when `diff.newFindings.length > 0`, then apply two suppression rules against the `MerchantAlert` ledger:
  - **Dedup by finding-set hash**: `findingSetHash` = stable hash over the sorted `(filename, findingType)` tuples of `newFindings` (reuse the djb2 approach in `scan-differ.server.ts`; note `newFindings` does not carry `codeSnippet`/`lineNumber`, so hash the tuple, not the full per-finding fingerprint). If the last sent alert for this shop has the same hash, suppress ("same new findings, no new news").
  - **Rate-limit**: max 1 alert per shop per cadence window (the plan's existing scan cadence: weekly for Standard, daily for Professional). Query the latest `MerchantAlert.sentAt` for the shop; suppress if within the window.
  - *Tradeoff:* the hash+window combo prevents alert fatigue from a stuck orphan reappearing every rescan, at the cost of not re-pinging about the same finding. Acceptable, since the finding stays visible in-app.

**(2) Notification prefs + unsubscribe**
- **RECOMMENDED:** Frame as transactional ("continuous monitoring results for a store you installed us on"), default opt-in (`alertsEnabled = true`), with a clear per-shop opt-out. Provide both an in-app toggle (Settings) and a one-click unsubscribe link in every email. Emit RFC 8058 `List-Unsubscribe` + `List-Unsubscribe-Post` headers pointing at the tokenized public route so Gmail/Apple render a native unsubscribe.
  - *Tradeoff:* transactional framing avoids a marketing-consent flow, but we still honor unsubscribe to stay deliverability-safe and CAN-SPAM/GDPR-clean. Copy must say "monitoring", never "instant on-uninstall alert".

**(3) Cadence-as-tier + is alerting plan-gated?**
- **RECOMMENDED:** Do not paywall alerting as an on/off feature. Instead, piggyback the existing `scheduledScan` cadence tiering already in `getPlanFeatures`: Free has `scheduledScan: false` (no rescans, so nothing to alert on), Standard scans weekly, Professional scans daily. Alerts inherit that cadence for free (Standard weekly, Professional daily). Add an explicit `alertCadence: "none" | "weekly" | "daily"` to `PlanFeatures` so the tier lever is legible and the throttle window derives from one source of truth.
  - *Tradeoff:* keeps the pricing story simple ("faster monitoring = higher tier") and reuses scan-cadence machinery instead of a second gate. Alerting is effectively tier-gated through cadence, not as a separate SKU.

**(4) Sender identity**
- **RECOMMENDED:** Reuse the same `RESEND_API_KEY` (one Resend account, no new secret) but with a distinct, verified merchant from-address on a separate sending subdomain (e.g. `Ghost Code <alerts@notify.ghostcode.app>` via a new `MERCHANT_ALERT_FROM` env var), separate from the ops sender.
  - *Tradeoff:* merchant mail is higher-volume and deliverability-sensitive; sharing the `onboarding@resend.dev` sender used for operator pages would pollute reputation and look unbranded. A dedicated subdomain isolates merchant-mail reputation from both operator alerts and the root domain, while a single API key avoids new secret management.

**(5) Merchant email source**
- **RECOMMENDED:** Fetch the shop owner email via Admin GraphQL `shop { email }` inside the job (using `unauthenticated.admin(shop.domain)`, exactly as `scan-theme.ts` and `poll-check-shop.ts` already do), and cache it onto a new `Shop.alertEmail` column, refreshed each scan.
  - *Justification:* Background jobs run on the offline token via `unauthenticated.admin()`; there is no online `Session.email` available in that context, and `Session.email` (the only stored email today) may belong to a staff/collaborator, not the owner. `shop { email }` needs no extra scope, is always current, and caching gives the Settings UI and throttle logic an address without a live fetch (with a fallback if a fetch transiently fails).
  - *Rejected:* relying on `Session.email` (online-session only, possibly non-owner, absent in jobs).

---

## API / Interface Contract

### New service: `app/services/merchant-alert.server.ts`

Mirrors `ops-alert.server.ts` (env-gated, never-throws, single `fetch` to Resend `https://api.resend.com/emails`, `AbortSignal.timeout`).

```ts
// Low-level transport. Env-gated on RESEND_API_KEY + MERCHANT_ALERTS_ENABLED
// master switch; inert no-op (log only) if unset. NEVER THROWS.
export interface MerchantAlertResult {
  sent: boolean;
  reason: "sent" | "disabled" | "no_transport" | "no_recipient" | "http_error" | "exception";
}
export async function sendMerchantAlert(
  to: string,
  subject: string,
  body: string,                        // plaintext (+ optional html)
  opts?: { unsubscribeUrl: string },   // List-Unsubscribe / -Post headers (RFC 8058)
): Promise<MerchantAlertResult>;

// Orchestrator called from the Inngest step. Applies the full gating chain,
// resolves recipient, sends, and records the ledger row. Fire-and-forget; never throws.
export async function notifyNewFindings(
  shop: { id: string; domain: string; plan: string; alertsEnabled: boolean;
          alertEmail: string | null; alertUnsubscribeToken: string | null },
  diff: ScanDiff,                      // from scan-differ.server.ts
  scan: { id: string; themeId: string; themeName: string; origin: ScanOrigin },
): Promise<void>;

// Stable dedup hash over sorted (filename, findingType) tuples of newFindings.
export function buildFindingSetHash(newFindings: ScanDiff["newFindings"]): string;
```

### Plan-feature additions

`app/lib/billing.server.ts`: extend `PlanFeatures` and each `getPlanFeatures` branch:
```ts
export type PlanFeatures = {
  /* existing */
  alertCadence: "none" | "weekly" | "daily";  // Free: "none", Standard: "weekly", Pro: "daily"
};
```
`app/lib/plan-gating.server.ts`: new predicate mirroring `canUseScanDiffing`/`canUseAutoRescan`:
```ts
export function canReceiveAlerts(planName: string): boolean {
  return getPlanFeatures(planName).alertCadence !== "none";
}
export function getAlertWindowMs(planName: string): number | null; // weekly->7d, daily->1d, none->null
```

### Inngest step insertion point

`inngest/functions/scan-theme.ts`: new final step after `finalize-scan`, wrapped so a failure never affects scan status (same guarantee as the outer job's `notifyFunctionFailure` usage):
```ts
await step.run("notify-new-findings", async () => {
  const scan = await getScanById(scanId, { includeFindings: false });
  if (scan.origin === ScanOrigin.MANUAL) return;            // scheduled/auto only
  const shop = await getShopAlertState(shopId);              // new model fn
  if (!canReceiveAlerts(shop.plan) || !shop.alertsEnabled) return;
  const previous = await getPreviousScanForTheme(shopId, themeId, scan.createdAt);
  if (!previous) return;
  const current = await getFindingsForScan(scanId);
  const diff = diffScans(current, previous.findings, {
    skippedCategories: scan.skippedCategories, skippedFiles: scan.skippedFiles,
  });
  if (diff.newFindings.length === 0) return;
  await notifyNewFindings(shop, diff, scan);                 // handles throttle/dedup/send/record
});
```

### New model functions (`app/models/shop.server.ts` + a new `merchant-alert.server.ts` model)
```ts
getShopAlertState(shopId): Promise<{ id; domain; plan; alertsEnabled; alertEmail; alertUnsubscribeToken }>
setShopAlertsEnabled(shopId, enabled: boolean): Promise<...>
disableAlertsByToken(token: string): Promise<{ found: boolean }>   // for public unsubscribe
ensureUnsubscribeToken(shopId): Promise<string>                    // lazily mint opaque token
cacheShopAlertEmail(shopId, email: string): Promise<...>           // from shop { email } fetch
recordMerchantAlert({ shopId, scanId, findingSetHash, recipient, newCount }): Promise<void>
getLastMerchantAlert(shopId): Promise<{ sentAt: Date; findingSetHash: string } | null>
```

### Routes / actions
- **Settings prefs save**: `app/routes/app.settings.tsx` currently has no `action` (loader-only). Add one plus a "Notifications" card: an `<s-checkbox>`/toggle bound to `alertsEnabled`, showing the cached `alertEmail`. Follows Polaris web-component conventions already used in the file.
- **Public unsubscribe endpoint (no app auth)**: RECOMMENDED a tokenized public route `app/routes/unsubscribe.$token.tsx`, placed outside the authenticated `app.*` tree (no `authenticate.admin`). `loader`/`action` call `disableAlertsByToken(params.token)` and render a plain confirmation page. Handles `POST` for RFC 8058 one-click. *Rejected alternative:* Shopify App Proxy (needs storefront proxy config + a shop param; the self-contained token route is simpler and works from any mail client).

---

## Data Model Changes

All additions follow existing conventions (`cuid()` ids, `@default(now())` timestamps, `onDelete: Cascade` on the Shop FK, indexed lookup columns).

### `Shop`: new fields (`prisma/schema.prisma`)
```prisma
alertsEnabled         Boolean   @default(true)   // per-shop opt-in/out (transactional default)
alertEmail            String?                    // cached shop-owner email from Admin `shop { email }`
alertUnsubscribeToken String?   @unique          // opaque token for the public unsubscribe route
```
- `alertsEnabled` default `true` = transactional opt-in; the unsubscribe route and Settings toggle flip it to `false`.
- `alertEmail` nullable, populated/refreshed on each scheduled scan; null until first fetch (fall back to a live fetch).
- `alertUnsubscribeToken` unique, minted lazily (`ensureUnsubscribeToken`) the first time an email is sent.

### Dedup/throttle ledger: new `MerchantAlert` model (RECOMMENDED)
```prisma
model MerchantAlert {
  id             String   @id @default(cuid())
  shopId         String
  shop           Shop     @relation(fields: [shopId], references: [id], onDelete: Cascade)
  scanId         String                       // scan that produced the alert
  findingSetHash String                       // dedup key (sorted filename+findingType hash)
  newCount       Int                          // # new findings in the triggering diff
  recipient      String                       // address emailed (audit trail)
  sentAt         DateTime @default(now())

  @@index([shopId, sentAt])                    // throttle-window lookup
}
```
Add the back-relation `merchantAlerts MerchantAlert[]` on `Shop`.
- *Why a dedicated model over reusing `OpsEvent`:* `OpsEvent` is explicitly scoped to operator observability (per its header comment) and has no `shopId` FK, so it would NOT participate in the `shop/redact` cascade wipe (`deleteShopData`, `shop.server.ts`), a GDPR liability for merchant-addressed data. A `MerchantAlert` with `onDelete: Cascade` is wiped automatically with the shop, keeps merchant business data out of the ops log, and gives an indexed `(shopId, sentAt)` throttle query.
- *Alternative (lighter, not recommended):* reuse `OpsEvent` with a new `OPS_EVENT_TYPES.MERCHANT_ALERT_SENT`, `key = shop.domain`, `metadata = { findingSetHash, scanId, newCount }`. Rejected primarily for the missing shop cascade (redact would orphan rows) and the mixing of concerns.

### `PlanFeatures` (TS type, not DB): add `alertCadence` (see contract). No migration; derived from `plan`.

### New env vars (Railway; inert-by-default like the ops channel)
- `MERCHANT_ALERTS_ENABLED`: master switch (unset gives a pure no-op, keeps local/CI/build silent, matching the `OPS_ALERT_EMAIL` gating pattern).
- `MERCHANT_ALERT_FROM`: merchant sender identity (verified subdomain); reuses the existing `RESEND_API_KEY`.

---

## Migration / Rollout Plan

This ships onto a self-migrating Railway deploy (`railway.toml` -> `preDeployCommand = "npx prisma migrate deploy"`, healthcheck `/health`), where a push to `main` auto-deploys and runs pending migrations against the live production DB before the new image serves traffic. `prisma migrate dev` against this project points at prod (no shadow/local DB, per `tests/setup.ts` header and the 2026-08-29 leak note), so every migration below is additive, nullable-or-defaulted, and independently reversible via `DROP COLUMN`/`DROP TABLE`, mirroring `prisma/migrations/20260829120000_add_shop_uninstalled_at` and `20260830130000_add_scan_skipped_files`.

### 1. Additive Prisma migration (safe on live DB)

New fields on `Shop` and a new `MerchantAlert` table (see Data Model), all nullable or defaulted so existing rows backfill as a no-op. Each migration.sql carries the reversibility comment convention already used in the repo (explicit rollback DDL in the header). No destructive ops, no column drops, no type changes on existing columns, nothing that could fail mid-`migrate deploy` and wedge a deploy.

### 2. Env flag, default OFF (soft launch)

Follows the exact `ENABLE_TREND_CHART` pattern (`app/routes/app._index.tsx` -> `process.env.ENABLE_TREND_CHART === "true"`, documented in `.env.example`):
- `MERCHANT_ALERTS_ENABLED`: off unless the literal string `"true"`. The send path is warn-only/log-only until this is flipped in the Railway prod service env, so CI, build, and dark-deployed prod stay silent.
- `MERCHANT_ALERT_FROM`: sender from-address, analogous to `OPS_ALERT_FROM`. Documented in `.env.example` alongside the existing ops-alert block.

The merchant email service must reuse the inert-by-default gating of `sendOpsAlert`: no `RESEND_API_KEY` or flag off gives a pure no-op that only logs and never calls `fetch`. New env vars are optional/unset by default so the blocking smoke gate stays green (`scripts/smoke.mjs` / `/health/deep` assert db + inngest + sessions + scans, none of which these vars touch).

### 3. Shared Resend key: do NOT rotate

Reuse the existing `RESEND_API_KEY` already set in Railway (shared with ClearSignal ops alerts). Adding a new from-address does not require key rotation. The one prerequisite is deliverability: confirm the merchant sender domain is verified in Resend with DKIM/SPF before broad enable. Until a branded domain is verified, keep `MERCHANT_ALERT_FROM` on a verified sender.

### 4. Phased rollout

1. **Deploy dark**: migration + code land on `main`, `MERCHANT_ALERTS_ENABLED` unset. Diff-at-completion logic runs and logs "would send", but the email path is inert. Smoke gate + SHA-pin (`EXPECTED_SHA` vs `body.deployedSha`, blocking per `deploy.yml`) confirm the commit is live.
2. **Enable for one internal/dev shop**: flip the flag, scope sends to a single allow-listed dev shop domain; verify one real end-to-end send and the unsubscribe link.
3. **Verify one real merchant send**: confirm delivery, DKIM pass, copy, and dedup ledger row written exactly once.
4. **Enable broadly**: remove the shop allow-list; alerting active for all opted-in shops.

### 5. Backward compatibility

- Existing operator alerts (`app/lib/notifications.server.ts` -> `sendOpsAlert`, `OpsEvent` log) are untouched. The merchant path is a separate service with its own env flag and from-address; subject prefixes stay distinct (`[GhostCode Ops]` reserved for operator).
- Shops with no stored `alertEmail` or `alertsEnabled = false` simply skip: no error, logged as a skip (mirrors `sendOpsAlert`'s "disabled" reason).
- Legacy `Shop`/`Scan` rows need no backfill; new columns default correctly.
- If alerting rides the cadence gate (decision 3), a Free shop below the gate simply skips.

---

## Non-Requirements

Explicitly OUT of scope for this spec:
- **One-click remediation / write access to themes.** This spec is read-only monitoring + alerting. Anything touching `write_themes`, backup, or rollback is Idea B, covered by a separate premortem/spec.
- **Event-driven "on uninstall" alerting.** Not achievable (hard platform constraint). Alerting rides the periodic rescan spine only.
- **Alerts on MANUAL scans.** Skipped by design (merchant is already in-app).
- **Alerts on resolved-only diffs.** Only `newFindings.length > 0` triggers; "everything got fixed" is not an alert (could be a future positive-reinforcement nicety, not now).
- **In-app notification inbox / bell / SMS / Slack / webhook delivery.** Email only for v1.
- **Per-finding-type or per-severity alert routing/filtering.** One alert per non-empty new-findings set; no granular subscription preferences beyond on/off.
- **Marketing/promotional email.** Transactional service messages only.
- **A second Resend account or new API key.** Reuse the shared key with a new verified from-address.

---

## Acceptance Criteria

Each bullet is independently testable; unit tests live under `tests/services/` or `tests/lib/` mirroring `app/`, follow the `ops-alert.test.ts` env-gating pattern (delete relevant env vars in `beforeEach`, `vi.stubGlobal("fetch", ...)`, restore in `afterEach`), and rely on `tests/setup.ts` pinning `DATABASE_URL` to the non-routable dummy.

- **Trigger, exactly one email on a non-empty NEW diff:** given a scheduled/auto scan whose `diffScans` result has >=1 `newFindings` entry for an opted-in shop, the merchant alert service is invoked exactly once and `fetch` to the Resend endpoint is called exactly once. Verifiable by asserting `fetch` call count = 1 with a mocked transport.
- **Empty / only-resolved diff sends nothing:** a diff with `newFindings.length === 0` (including diffs that contain only `resolvedFindings`) results in zero send attempts: `fetch` not called, no `MerchantAlert` row written.
- **Throttle / dedup within cadence window:** two consecutive scans surfacing the same finding set within the cadence window produce exactly one send; the second is suppressed by a `MerchantAlert` ledger hit and/or `lastMerchantAlertAt`. Assert send count = 1 across two invocations.
- **Opted-out shop gets nothing:** `alertsEnabled = false` gives no send, no ledger row, logged as a skip, even with a non-empty NEW diff and the flag on.
- **Cadence-gate respected:** a Free shop (`alertCadence: "none"`) receives no alert; a Standard/Pro shop at/above the gate does. Asserted with both plan values against an identical non-empty diff.
- **Email path inert in CI, no prod sends, no leaked rows:** with `MERCHANT_ALERTS_ENABLED` unset and/or `RESEND_API_KEY` unset (the CI default), the service is a no-op that only logs and never calls `fetch` (mirrors the first `ops-alert.test.ts` case). Tests must be DB-isolated (dummy `DATABASE_URL` from `tests/setup.ts`) and mock the transport: no `MerchantAlert`/`OpsEvent` rows may reach prod, closing the 2026-08-29 leak class.
- **Unsubscribe disables alerts without app auth:** hitting the unsubscribe route with a valid `unsubscribeToken` sets `alertsEnabled = false` for that shop with no Shopify session/App Bridge auth required; an invalid/absent token is rejected and changes nothing.
- **Copy discipline:** rendered email + subject contain "continuous monitoring" and NEVER the string "instant" or any on-uninstall-alert phrasing. Assert presence of the required phrase and absence of the forbidden ones. (Also: zero em-dashes, per project copy rule.)
- **Missing merchant email handled gracefully:** `alertEmail` null gives no send, no throw, logged skip (a non-empty NEW diff must not error the scan/worker); the enclosing scan-completion step still succeeds (fire-and-forget, mirroring `notifyFunctionFailure`).
- **Migration applies cleanly on the live DB:** `prisma migrate deploy` applies the new `Shop` columns and `MerchantAlert` table additively against existing prod rows with no backfill and no destructive change; each migration documents its `DROP COLUMN`/`DROP TABLE` rollback (matching `20260829120000_add_shop_uninstalled_at`). Verifiable by applying to a clean DB from the committed baseline with zero row rewrites.
- **Smoke gate stays green:** post-deploy `scripts/smoke.mjs` passes `/health` -> `/health/deep` (db, inngest, sessions, scans all green) -> `PUT /api/inngest`, and the blocking `EXPECTED_SHA` vs `body.deployedSha` pin matches, none of which depend on the new env vars.

---

## Open Questions

1. **Sending domain.** Do we have a domain to verify in Resend for `MERCHANT_ALERT_FROM` (e.g. `notify.ghostcode.app` or the actual app domain `app.alpenglowsoftware.com`)? Deliverability (DKIM/SPF) must be set up before broad enable. This is a prerequisite, not code.
2. **Standard-plan cadence.** Standard currently scans weekly. Is weekly-latency alerting compelling enough as a retention lever, or does the story only really land at Professional (daily)? This affects how the feature is marketed per tier.
3. **Email content depth.** Alert lists app name + severity + file per new finding. Do we cap the number of findings shown (e.g. "5 of 23, see all in-app") and deep-link into the diff page? Deep-link requires an embedded-app URL with `shop`/`host` params (per the known loader-redirect gotcha).
4. **Does the transactional framing hold for Shopify review?** Confirm with the legal agent that shop-owner-email service alerts about the merchant's own store are covered by the current privacy policy and do not need a new consent surface. Update the privacy policy to name this use.
5. **First-send email backfill.** On the very first scheduled scan after ship, every shop with pre-existing findings will have a non-empty diff vs. its prior scan and could all alert at once. Do we suppress the first post-deploy alert (treat the deploy as a baseline reset), or is a one-time "here's what we found" send acceptable? Leaning toward baseline-suppress to avoid a mass send.
6. **Interaction with per-finding dismissal (gc-06e.7).** If a merchant dismisses a finding as "not a problem", should a rescan that re-surfaces it alert? Depends on whether dismissals persist across rescans (the open question blocking gc-06e.7). Alerting and dismissal should be designed to agree.

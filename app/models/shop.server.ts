import type { Prisma } from "@prisma/client";

import { OPS_EVENT_TYPES, recordOpsEvent } from "./ops-event.server";
import db from "../db.server";

/**
 * The subset of shop fields returned by getShopMetadata.
 */
export type ShopMetadata = {
  id: string;
  domain: string;
  plan: string;
  planReconciledAt: Date | null;
  installedAt: Date;
  uninstalledAt: Date | null;
  lastSeenAt: Date | null;
  lastThemePublishAt: Date | null;
  upgradePreviewShownAt: Date | null;
  feedbackNudgeShownAt: Date | null;
  feedbackNudgeDismissedAt: Date | null;
  feedbackSubmittedAt: Date | null;
  firstOpenedAt: Date | null;
  firstResultsViewedAt: Date | null;
  lastPromptKey: string | null;
  lastPromptShownAt: Date | null;
  reviewPopupRequestedAt: Date | null;
  reviewPopupRetryAfter: Date | null;
  reviewPopupAttemptCount: number;
  reviewPopupLastAttemptAt: Date | null;
  reviewPopupLastResult: string | null;
  upgradeReturnLastShownAt: Date | null;
  upgradeReturnLastDismissedAt: Date | null;
  upgradeReturnDismissCount: number;
  upgradeReturnShownAt: Date | null;
  everPaidAt: Date | null;
};

/**
 * Freshness window for the durable `lastSeenAt` "last login" stamp. The app-load
 * loader only writes lastSeenAt when it is null or older than this window, so a
 * merchant clicking through several pages in a session produces at most one write
 * per window rather than one per navigation. Mirrors the plan-reconcile freshness
 * guard (isPlanReconcileStale). Tunable.
 */
export const LAST_SEEN_FRESHNESS_MS = 5 * 60 * 1000; // 5 minutes

/**
 * True when lastSeenAt is stale (null = never stamped, always stale) and should
 * be refreshed. Pure predicate — no DB access — so it can gate the write in the
 * loader without a round-trip.
 */
export function isLastSeenStale(lastSeenAt: Date | null, now: Date = new Date()): boolean {
  if (lastSeenAt === null) return true;
  return now.getTime() - lastSeenAt.getTime() >= LAST_SEEN_FRESHNESS_MS;
}

/**
 * Stamp `lastSeenAt` = now() for a shop by internal id. Called from the app
 * loader on merchant page loads, freshness-gated by isLastSeenStale.
 *
 * Uses updateMany keyed on id so a missing row is a safe no-op (count 0) rather
 * than a throw — this is best-effort activity telemetry and must never break the
 * app load. The caller still wraps it defensively.
 */
export async function touchShopLastSeen(shopId: string): Promise<void> {
  await db.shop.updateMany({ where: { id: shopId }, data: { lastSeenAt: new Date() } });
}

/**
 * Lightweight shop lookup that returns all shop metadata fields.
 * Use this for plan checks, feature gating, interruptive prompts, and any
 * caller that only needs shop identity or settings.
 *
 * Returns null if no shop exists — callers must handle the null case.
 */
export async function getShopMetadata(domain: string): Promise<ShopMetadata | null> {
  return db.shop.findUnique({
    where: { domain },
    select: {
      id: true,
      domain: true,
      plan: true,
      planReconciledAt: true,
      installedAt: true,
      uninstalledAt: true,
      lastSeenAt: true,
      lastThemePublishAt: true,
      upgradePreviewShownAt: true,
      feedbackNudgeShownAt: true,
      feedbackNudgeDismissedAt: true,
      feedbackSubmittedAt: true,
      firstOpenedAt: true,
      firstResultsViewedAt: true,
      lastPromptKey: true,
      lastPromptShownAt: true,
      reviewPopupRequestedAt: true,
      reviewPopupRetryAfter: true,
      reviewPopupAttemptCount: true,
      reviewPopupLastAttemptAt: true,
      reviewPopupLastResult: true,
      upgradeReturnLastShownAt: true,
      upgradeReturnLastDismissedAt: true,
      upgradeReturnDismissCount: true,
      upgradeReturnShownAt: true,
      everPaidAt: true,
    },
  });
}

/**
 * Clear the uninstalled-pending-redact flag on reinstall so the shop rejoins the
 * active set (weekly-scan/poll-theme-changes/metrics/digest all skip rows with a
 * non-null uninstalledAt).
 *
 * Called from the app loader ONLY when an existing shop row still carries a set
 * uninstalledAt (i.e. an actual reinstall), never on every load. Uses updateMany
 * keyed on domain so a missing row is a safe no-op (count 0) rather than a throw.
 *
 * Also nulls `planReconciledAt` so the freshness clock is treated as stale (see
 * isPlanReconcileStale) and the next load forces a fresh reconcile. Without this,
 * a fast uninstall -> reinstall within the 1h freshness window would keep a stale
 * (possibly still-paid) plan until the window elapses (gc-bbb).
 */
export async function reactivateShop(domain: string): Promise<void> {
  await db.shop.updateMany({
    where: { domain },
    data: { uninstalledAt: null, planReconciledAt: null },
  });
}

/**
 * Create a shop record on install, or no-op update if it already exists.
 *
 * The Shopify access token is NOT stored here: the operative offline token
 * lives in the Session table (managed by PrismaSessionStorage) and is read by
 * every background job and webhook via `unauthenticated.admin()`. This function
 * only persists shop identity/settings (domain, plan, installedAt, etc.).
 *
 * Idempotent: safe to call on every authenticated visit. On re-install for an
 * existing shop, the create is skipped and existing metadata is preserved.
 */
export async function upsertShop(domain: string) {
  return db.shop.upsert({
    where: { domain },
    create: { domain },
    // Defensive fallback only: upsertShop is NOT called on a normal reinstall
    // (the app loader takes the existing-row branch and skips this), so this
    // clause only clears uninstalledAt in the rare create-race where the row
    // reappears here. The real reinstall-reset happens via reactivateShop in the
    // app loader (gc-grd).
    update: { uninstalledAt: null },
  });
}

/**
 * True when `err` is Prisma's unique-constraint violation (P2002). Duck-typed on
 * `code` so it holds regardless of which Prisma error class instance is thrown.
 */
function isUniqueConstraintError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

/**
 * Return the shop's metadata, creating the Shop row first if it does not exist.
 *
 * Used by BOTH the parent app.tsx loader and the dashboard (app._index) loader.
 * React Router runs those loaders IN PARALLEL, so on the very first post-install
 * load the child could read before the parent's create committed and see no row
 * (gc-bj4: the onboarding card with "Start First Scan" never rendered).
 * Having each loader get-or-create closes that race.
 *
 * upsertShop runs ONLY when the row is absent (the reinstall path relies on
 * reactivateShop in app.tsx, never on upsertShop running every load; see the
 * gc-grd note on upsertShop).
 *
 * Concurrency: two loaders can both miss the read and both upsert. Prisma issues
 * a native `INSERT ... ON CONFLICT DO UPDATE` for this upsert shape on Postgres,
 * so the loser normally just no-op updates. If the upsert still raises a
 * unique-constraint error (P2002, e.g. a non-native upsert path), the other
 * request created the row, so we swallow ONLY that error and re-read. Any other
 * error propagates.
 *
 * Returns null only if the row vanished between create and re-read (e.g. a
 * shop/redact delete landing in between). Callers keep an explicit fallback.
 */
export async function getOrCreateShopMetadata(domain: string): Promise<ShopMetadata | null> {
  const existing = await getShopMetadata(domain);
  if (existing) return existing;

  try {
    await upsertShop(domain);
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
  }
  return getShopMetadata(domain);
}

/**
 * Revoke access and mark a shop as uninstalled WITHOUT hard-deleting its data.
 *
 * Called by the app/uninstalled webhook. Instead of wiping the Shop + scan data
 * immediately (which would make the shop/redact 48h GDPR grace window meaningless
 * and leave no uninstall record), this:
 *   1. Deletes the shop's Session rows — Sessions use a plain string `shop` field
 *      (no FK), so they must be deleted explicitly. This revokes access tokens.
 *   2. Stamps `uninstalledAt` = now() on the Shop row, marking it uninstalled-but-
 *      pending-redact so iterators/metrics skip it (gc-grd).
 *
 * The full wipe (Shop + all scan data via cascade) stays deferred to shop/redact,
 * which Shopify delivers ~48h after uninstall and which calls deleteShopData.
 *
 * Both writes run in a single transaction. Idempotent on TWO axes:
 *   - updateMany keyed on domain means a missing shop row is a safe no-op (count
 *     0) rather than a throw, matching the null-safe style of deleteShopData; and
 *   - the where-clause also requires `uninstalledAt: null`, so re-marking an
 *     ALREADY-uninstalled shop (webhook redelivery, or a reconciler step retry
 *     after a successful mark) is a true no-op: it does NOT re-stamp uninstalledAt
 *     to a later time and does NOT count as a new mark. Without this guard the
 *     churn timestamp would drift later and the shared event path would record a
 *     duplicate SHOP_UNINSTALLED OpsEvent, double-counting in the operator digest.
 *
 * Return contract:
 *   - `newlyMarked` — true IFF this call transitioned the row from active to
 *     uninstalled (updateMany count > 0). Callers key the SHOP_UNINSTALLED event
 *     off this so a redelivery/retry records nothing.
 *   - `found`       — whether a shop row exists for the domain at all. On the
 *     newly-marked path this is trivially true. On the count-0 (no-op) path it is
 *     resolved with ONE extra cheap count query so the caller can distinguish
 *     "already uninstalled" (found=true, stay quiet) from "no such row"
 *     (found=false, warn) — the webhook needs this precise distinction.
 */
export async function markShopUninstalled(
  domain: string,
): Promise<{ newlyMarked: boolean; found: boolean }> {
  const [, updateResult] = await db.$transaction([
    // Sessions use a plain string `shop` field (no FK) — delete explicitly to revoke access.
    db.session.deleteMany({ where: { shop: domain } }),
    // Guarded on uninstalledAt: null so a re-mark (redelivery / retry) is count 0,
    // not a re-stamp. count > 0 means we newly marked this call.
    db.shop.updateMany({
      where: { domain, uninstalledAt: null },
      data: { uninstalledAt: new Date() },
    }),
  ]);

  const newlyMarked = updateResult.count > 0;
  // count 0 is ambiguous — the row is either already-uninstalled (no-op) or
  // absent. Only on that path do a single cheap existence check so the caller can
  // tell an already-uninstalled redelivery (found=true) from a genuine miss.
  const found = newlyMarked ? true : (await db.shop.count({ where: { domain } })) > 0;

  return { newlyMarked, found };
}

/**
 * Record a SHOP_UNINSTALLED OpsEvent and mark the shop uninstalled, as one unit.
 *
 * This is the SINGLE shared uninstall path so the two producers — the
 * `app/uninstalled` webhook and the periodic install-status reconciler (gc-dyt,
 * the backstop for missed webhooks) — can never drift on how an uninstall is
 * recorded vs. marked. Both call this; only the `source` (and message) differ.
 *
 * Marks FIRST (revoke access + stamp uninstalledAt via markShopUninstalled),
 * then records the durable SHOP_UNINSTALLED OpsEvent ONLY when the mark was NEW
 * (newlyMarked). An already-uninstalled shop (webhook redelivery, reconciler
 * step retry) produces NO re-stamp and NO second event — the operator digest
 * counts SHOP_UNINSTALLED events, so a duplicate would double-count uninstalls.
 * (The order is reversed from the original record-then-mark: we must know whether
 * the mark was new before deciding to record. recordOpsEvent never throws, so it
 * can't block anything; and a mark that throws now correctly records no event.)
 * `metadata.source` distinguishes a webhook-delivered uninstall ("webhook") from
 * a reconciler-detected one ("reconciler") for observability.
 *
 * The SHOP_UNINSTALLED event is keyed on the shop domain, so deleteShopData's
 * domain-keyed OpsEvent purge already covers it at shop/redact — no new
 * redact/prune coverage is needed for the `source` metadata.
 *
 * Returns markShopUninstalled's `{ newlyMarked, found }` so the caller can log a
 * miss and still succeed (webhook returns 200; reconciler logs the outcome).
 */
export async function markShopUninstalledWithEvent(
  domain: string,
  opts: { source: "webhook" | "reconciler"; message: string },
): Promise<{ newlyMarked: boolean; found: boolean }> {
  const result = await markShopUninstalled(domain);
  if (result.newlyMarked) {
    await recordOpsEvent({
      eventType: OPS_EVENT_TYPES.SHOP_UNINSTALLED,
      key: domain,
      message: opts.message,
      metadata: { source: opts.source },
    });
  }
  return result;
}

/**
 * Update the billing plan tier for a shop by Shopify domain.
 * Used by the app/subscriptions/update webhook, which provides the domain
 * (not the internal shop ID) in the webhook payload.
 *
 * Returns null if the shop is not found — caller is responsible for logging
 * and still returning 200 to Shopify.
 *
 * Also stamps `planReconciledAt` to now(): any authoritative plan write (webhook
 * delivery or reconciliation drift correction) means the stored plan now matches
 * Shopify, so the freshness clock should reset and avoid a redundant reconcile.
 */
export async function updateShopPlanByDomain(
  domain: string,
  plan: string,
): Promise<{ id: string; domain: string; plan: string } | null> {
  const shop = await db.shop.findUnique({ where: { domain } });
  if (!shop) return null;

  return db.shop.update({
    where: { domain },
    data: { plan, planReconciledAt: new Date() },
    select: { id: true, domain: true, plan: true },
  });
}

/**
 * Stamp `planReconciledAt` to now() WITHOUT changing the plan.
 *
 * Used by the reconciler on a no-op match (stored plan already equals Shopify's
 * active subscription state) so the freshness clock still advances and the next
 * app load skips the reconciliation query.
 *
 * Returns null if the shop domain is not found.
 */
export async function stampPlanReconciledAt(domain: string): Promise<{ id: string } | null> {
  const shop = await db.shop.findUnique({ where: { domain } });
  if (!shop) return null;

  return db.shop.update({
    where: { domain },
    data: { planReconciledAt: new Date() },
    select: { id: true },
  });
}

/**
 * The Shop stamp columns that in-app nudges claim once per merchant (gc-97k.4
 * upgrade preview, gc-97k.3 feedback, gc-97k.9 upgrade return).
 */
export type NudgeStageColumn =
  | "upgradePreviewShownAt"
  | "upgradePreviewClickedAt"
  | "upgradePreviewConvertedAt"
  | "upgradeReturnShownAt"
  | "upgradeReturnClickedAt"
  | "upgradeReturnDismissedAt"
  | "upgradeReturnConvertedAt"
  | "feedbackNudgeShownAt"
  | "feedbackNudgeClickedAt"
  | "feedbackNudgeDismissedAt"
  | "feedbackSubmittedAt";

/** The durable journey milestone stamps (gc-dpm.1). */
export type JourneyMilestoneColumn = "firstOpenedAt" | "firstResultsViewedAt";

/** First time the reconciler saw the shop on a paid plan (gc-97k.8). */
export type EverPaidColumn = "everPaidAt";

/**
 * Every once-per-merchant Shop stamp column. Typed so a claim can only target
 * one of these nullable DateTime columns.
 */
export type ShopStampColumn = NudgeStageColumn | JourneyMilestoneColumn | EverPaidColumn;

/**
 * Atomically claim a once-per-merchant Shop stamp (a nudge stage or a journey
 * milestone).
 *
 * A conditional updateMany (`where <column> IS NULL`) stamps the column to now()
 * only if it is still unset, so of any number of concurrent callers exactly one
 * sees count === 1. Returns true IFF this call made the first stamp; the caller
 * emits any follow-up event only then. A missing shop row is a safe false.
 *
 * `extraWhere` adds preconditions the row must also meet for the claim to win
 * (e.g. the upgrade preview's `converted` requires `upgradePreviewShownAt` to
 * be set). It cannot override `domain` or the column's IS NULL guard.
 */
export async function claimShopStamp(
  domain: string,
  column: ShopStampColumn,
  extraWhere?: Prisma.ShopWhereInput,
): Promise<boolean> {
  const where: Prisma.ShopWhereInput = { ...extraWhere, domain, [column]: null };
  const { count } = await db.shop.updateMany({ where, data: { [column]: new Date() } });
  return count === 1;
}

/**
 * Claim the shop's single interruptive-prompt slot for `promptKey` (gc-97k.6).
 *
 * A conditional updateMany keyed on the PREVIOUS cap state the caller read
 * (`lastPromptKey` and `lastPromptShownAt` both unchanged) writes the new key
 * and `now`. Of two concurrent loads that read the same state, exactly one sees
 * count === 1, so they can never both claim (different) prompts. Returns true
 * IFF this call won. A missing shop row is a safe false.
 */
export async function claimPromptSlot(
  domain: string,
  promptKey: string,
  previous: { lastPromptKey: string | null; lastPromptShownAt: Date | null },
  now: Date,
): Promise<boolean> {
  const { count } = await db.shop.updateMany({
    where: {
      domain,
      lastPromptKey: previous.lastPromptKey,
      lastPromptShownAt: previous.lastPromptShownAt,
    },
    data: { lastPromptKey: promptKey, lastPromptShownAt: now },
  });
  return count === 1;
}

/**
 * Record a native review popup ATTEMPT (gc-97k.7) before the client asks App
 * Bridge. A compare-and-set on the last attempt time this load read: of two
 * concurrent loads that both picked the popup, exactly one wins (count === 1),
 * so the modal is requested once. The winner increments the attempt count in
 * SQL and clears the last result (this attempt's report is still to come).
 * Never after a terminal result. Returns true IFF this call won; a missing
 * shop row is a safe false.
 */
export async function claimReviewPopupAttempt(
  domain: string,
  previousLastAttemptAt: Date | null,
  now: Date,
): Promise<boolean> {
  const { count } = await db.shop.updateMany({
    where: {
      domain,
      reviewPopupRequestedAt: null,
      reviewPopupLastAttemptAt: previousLastAttemptAt,
    },
    data: {
      reviewPopupAttemptCount: { increment: 1 },
      reviewPopupLastAttemptAt: now,
      reviewPopupLastResult: null,
    },
  });
  return count === 1;
}

/**
 * Record a TERMINAL review popup result (gc-97k.7): stamp reviewPopupRequestedAt
 * (the popup is done for good) and the code, once ever (`where
 * reviewPopupRequestedAt IS NULL`). When the modal was actually displayed the
 * caller passes `claimPromptKey`, and the SAME statement claims the shop's 24h
 * prompt slot (lastPromptKey / lastPromptShownAt), so a displayed popup and
 * its slot can never disagree. Returns true IFF this call made the stamp.
 */
export async function recordReviewPopupTerminal(
  domain: string,
  code: string,
  now: Date,
  claimPromptKey: string | null,
): Promise<boolean> {
  const { count } = await db.shop.updateMany({
    where: { domain, reviewPopupRequestedAt: null },
    data: {
      reviewPopupRequestedAt: now,
      reviewPopupLastResult: code,
      ...(claimPromptKey === null ? {} : { lastPromptKey: claimPromptKey, lastPromptShownAt: now }),
    },
  });
  return count === 1;
}

/**
 * Record a RETRYABLE review popup result (gc-97k.7): no request before
 * `retryAfter`. Counts once per attempt: only while the popup is not done, an
 * attempt was recorded, and that attempt has no result yet
 * (reviewPopupLastResult IS NULL, cleared by claimReviewPopupAttempt), so a
 * replayed report is a no-op. Returns true IFF this call recorded it.
 */
export async function recordReviewPopupRetry(
  domain: string,
  code: string,
  retryAfter: Date,
): Promise<boolean> {
  const { count } = await db.shop.updateMany({
    where: {
      domain,
      reviewPopupRequestedAt: null,
      reviewPopupLastAttemptAt: { not: null },
      reviewPopupLastResult: null,
    },
    data: { reviewPopupRetryAfter: retryAfter, reviewPopupLastResult: code },
  });
  return count === 1;
}

/**
 * Start a new weekly episode of the return-visit upgrade nudge (gc-97k.9):
 * a plain update of upgradeReturnLastShownAt. Concurrent first loads of the
 * same episode each write a near-identical `now`, which is harmless. A missing
 * shop row is a safe no-op.
 */
export async function startUpgradeReturnEpisode(domain: string, now: Date): Promise<void> {
  await db.shop.updateMany({ where: { domain }, data: { upgradeReturnLastShownAt: now } });
}

/**
 * Record a "Not now" on the return-visit upgrade nudge (gc-97k.9), counting at
 * most ONCE per episode, in ONE conditional statement.
 *
 * `episode` is the OPEN episode the caller read (the service checks
 * isUpgradeReturnEpisodeOpen first). The where clause pins both episode
 * columns to exactly those values AND re-checks in SQL that the episode
 * started less than `windowMs` before `now`, so the row can only match while
 * that same episode is still open and undismissed:
 *   - a repeated submit re-reads a dismissal at or after the start: closed,
 *     and the service never calls this;
 *   - concurrent submits that read the same state race on the compare-and-set:
 *     the first ends the episode (lastDismissedAt changes), so the rest match
 *     nothing (count 0).
 * The winner increments the count in SQL (`count = count + 1`) and stamps the
 * dismissal. Returns true IFF this call counted. A missing row is a safe false.
 */
export async function recordUpgradeReturnDismissal(
  domain: string,
  episode: { upgradeReturnLastShownAt: Date; upgradeReturnLastDismissedAt: Date | null },
  now: Date,
  windowMs: number,
): Promise<boolean> {
  const { count } = await db.shop.updateMany({
    where: {
      domain,
      upgradeReturnLastShownAt: {
        equals: episode.upgradeReturnLastShownAt,
        gt: new Date(now.getTime() - windowMs),
      },
      upgradeReturnLastDismissedAt: episode.upgradeReturnLastDismissedAt,
    },
    data: {
      upgradeReturnDismissCount: { increment: 1 },
      upgradeReturnLastDismissedAt: now,
    },
  });
  return count === 1;
}

/**
 * Record the timestamp of the most recent themes/publish webhook for a shop.
 * Used by the dashboard to surface a nudge banner when a theme change occurred
 * since the last completed scan.
 *
 * Returns null if the shop domain is not found — callers must still return 200
 * to Shopify even when no record is updated.
 */
export async function updateThemePublishTimestamp(
  domain: string,
): Promise<{ id: string; domain: string } | null> {
  const shop = await db.shop.findUnique({ where: { domain } });
  if (!shop) return null;

  return db.shop.update({
    where: { domain },
    data: { lastThemePublishAt: new Date() },
    select: { id: true, domain: true },
  });
}

/**
 * Hard-delete a shop and all its data atomically inside a single transaction.
 *
 * Deletion order:
 *   1. Sessions  — no FK to Shop (plain string `shop` field), must be deleted explicitly.
 *   2. OpsEvents — no FK to Shop, must be deleted explicitly (same reason as Sessions).
 *   3. Shop      — PostgreSQL cascades handle all child tables automatically.
 *
 * Cascade map (all have onDelete: Cascade on their Shop or Scan FK):
 *   Shop → Scans → Findings
 *   Shop → Scans → UnknownScripts → SignatureSubmissions
 *   Shop → BillingEvents
 *   Shop → IgnoredFinding
 *   Shop → MerchantFeedback (also deleted explicitly below: personal data)
 *
 * OpsEvent has NO Shop FK, so cascade never touches it — yet observability rows
 * carry the shop's myshopify domain (webhook-failure `metadata.shop`, api-error
 * `metadata.shopDomain`, and the SHOP_UNINSTALLED event `key`). Left alone, the
 * domain would persist indefinitely after shop/redact — a GDPR erasure gap. We
 * purge those rows explicitly here so the delete is atomic with the shop delete.
 * Safe w.r.t. the operator-digest 24h uninstall window: shop/redact fires ~48h
 * after uninstall, so the digest has already read any SHOP_UNINSTALLED row.
 *
 * Returns null if the domain is not found, so callers can log and still
 * return 200 without throwing.
 */
export async function deleteShopData(domain: string) {
  const shop = await db.shop.findUnique({ where: { domain } });
  if (!shop) return null;

  console.log("[gdpr]", { event: "delete_shop_data_start", domain, shopId: shop.id });

  await db.$transaction([
    // Sessions use a plain string `shop` field (no FK) — must delete explicitly.
    db.session.deleteMany({ where: { shop: domain } }),
    // OpsEvent has no Shop FK, so cascade skips it — purge the rows carrying the
    // domain (key on uninstall, metadata.shop / metadata.shopDomain otherwise).
    // The `page_visit` activity event is domain-keyed (key = session.shop), so
    // the `key: domain` clause already reaches it — no extra clause needed.
    // The nudge-funnel events (nudge_shown/clicked/dismissed/converted, gc-97k.1)
    // are domain-keyed the same way, so the `key: domain` clause covers them too.
    // The per-scan `scan_signal` event is the exception: it keys on scanId and
    // carries the INTERNAL shop cuid in metadata.shopId (not the domain), so the
    // shopId clause below is required to reach those rows.
    // Covers the structured domain fields only; a domain incidentally embedded
    // in a free-text `message` (webhook_failure/function_failure error strings)
    // is not reached — accepted as low-risk residual, not structured PII.
    db.opsEvent.deleteMany({
      where: {
        OR: [
          { key: domain },
          { metadata: { path: ["shop"], equals: domain } },
          { metadata: { path: ["shopDomain"], equals: domain } },
          { metadata: { path: ["shopId"], equals: shop.id } },
        ],
      },
    }),
    // MerchantFeedback (gc-97k.3) cascades from Shop too, but it holds the
    // merchant's optional contact email and free text, so the redact path names
    // it explicitly rather than relying on the FK alone (same as ClearSignal).
    db.merchantFeedback.deleteMany({ where: { shopId: shop.id } }),
    // Shop delete cascades to: Scans → Findings, UnknownScripts → SignatureSubmissions,
    // and BillingEvents (all have onDelete: Cascade on their Shop/Scan FK).
    db.shop.delete({ where: { domain } }),
  ]);

  console.log("[gdpr]", { event: "delete_shop_data_complete", domain, shopId: shop.id });

  return shop;
}

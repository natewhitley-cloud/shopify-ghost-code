import db from "../db.server";
import { isExcludedShop } from "../lib/store-exclusion";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BillingEventType = "upgrade" | "downgrade" | "cancellation" | "reactivation";

export type RecordBillingEventInput = {
  shopId: string;
  eventType: BillingEventType;
  fromPlan?: string | null;
  toPlan?: string | null;
  amount?: number | null;
};

// ---------------------------------------------------------------------------
// Model functions
// ---------------------------------------------------------------------------

/**
 * Insert a new BillingEvent row.
 *
 * Returns the created record. If the insert fails the error propagates to the
 * caller — it is the caller's responsibility to catch and handle it in a
 * non-blocking way when recording must not interrupt a billing flow.
 */
export async function recordBillingEvent(input: RecordBillingEventInput) {
  const { shopId, eventType, fromPlan, toPlan, amount } = input;
  return db.billingEvent.create({
    data: {
      shopId,
      eventType,
      fromPlan: fromPlan ?? null,
      toPlan: toPlan ?? null,
      amount: amount ?? null,
    },
  });
}

/**
 * Options for excluding dev/test/internal/app-review stores from the billing-event
 * aggregation, mirroring the exclusion every other operator-digest metric applies.
 */
export type BillingEventExcludeOpts = {
  excludeSet: Set<string>;
  excludePrefixes: Set<string>;
};

/**
 * Return aggregate counts of each event type across all shops.
 * Optionally filter to events on or after `since`.
 *
 * When `opts` is provided, events belonging to a dev/test/internal/app-review
 * store (per the shared shop-level `isExcludedShop` predicate — the durable
 * `shop.isInternal` flag is primary, with the env list + `app-review-` prefix as
 * override/ephemeral cover) are dropped BEFORE counting — so the operator digest's "Billing events (24h)" line
 * is consistent with every other dev-store-excluded metric. Aggregation then
 * happens in JS over the surviving rows. `opts` is REQUIRED: there is exactly
 * one aggregation path, so no caller can accidentally count internal stores
 * (the old no-opts groupBy path was dead and removed, gc-m5d). An event with no
 * resolvable shop is dropped (fail closed).
 *
 * Returns a plain object keyed by eventType string for easy consumption
 * in a future admin dashboard.
 *
 * Example result:
 *   { upgrade: 12, downgrade: 3, cancellation: 5, reactivation: 2 }
 */
export async function getBillingEventStats(
  since: Date | undefined,
  opts: BillingEventExcludeOpts,
): Promise<Record<BillingEventType, number>> {
  const counts: Record<BillingEventType, number> = {
    upgrade: 0,
    downgrade: 0,
    cancellation: 0,
    reactivation: 0,
  };

  // Fetch each in-window event with its shop domain, drop excluded stores, then
  // aggregate by eventType in JS (a groupBy can't filter on the related domain).
  const rows = await db.billingEvent.findMany({
    where: since ? { createdAt: { gte: since } } : undefined,
    select: { eventType: true, shop: { select: { domain: true, isInternal: true } } },
  });

  for (const row of rows) {
    // Fail closed: an event we can't tie to a shop can't be proven to be a real
    // merchant's, so it is not counted.
    if (!row.shop) continue;
    // Shop-level predicate: the durable isInternal flag is the primary signal,
    // with the env exclude list + app-review- prefix as override/ephemeral cover.
    if (isExcludedShop(row.shop, opts.excludeSet, opts.excludePrefixes)) continue;
    const key = row.eventType as BillingEventType;
    if (key in counts) counts[key] += 1;
  }

  return counts;
}

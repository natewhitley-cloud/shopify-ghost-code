import db from "../db.server";

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
 * Return billing events for a single shop, newest-first.
 *
 * @param shopId  - internal DB shop ID
 * @param options.limit - cap the number of results (default: 50)
 * @param options.since - only return events on or after this date
 */
export async function getBillingEventsForShop(
  shopId: string,
  options?: { limit?: number; since?: Date },
) {
  return db.billingEvent.findMany({
    where: {
      shopId,
      ...(options?.since ? { createdAt: { gte: options.since } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: options?.limit ?? 50,
  });
}

/**
 * Return aggregate counts of each event type across all shops.
 * Optionally filter to events on or after `since`.
 *
 * Returns a plain object keyed by eventType string for easy consumption
 * in a future admin dashboard.
 *
 * Example result:
 *   { upgrade: 12, downgrade: 3, cancellation: 5, reactivation: 2 }
 */
export async function getBillingEventStats(
  since?: Date,
): Promise<Record<BillingEventType, number>> {
  const rows = await db.billingEvent.groupBy({
    by: ["eventType"],
    where: since ? { createdAt: { gte: since } } : undefined,
    _count: { eventType: true },
  });

  const counts: Record<BillingEventType, number> = {
    upgrade: 0,
    downgrade: 0,
    cancellation: 0,
    reactivation: 0,
  };

  for (const row of rows) {
    const key = row.eventType as BillingEventType;
    if (key in counts) {
      counts[key] = row._count.eventType;
    }
  }

  return counts;
}

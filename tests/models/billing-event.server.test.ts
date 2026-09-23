/**
 * Tests for app/models/billing-event.server.ts
 *
 * Strategy:
 *   - Mock db.server (Prisma client) to control DB responses.
 *   - Test each exported function: recordBillingEvent, getBillingEventStats
 *     (exclusion opts are required; the old no-opts groupBy path was removed, gc-m5d).
 *   - Verify Prisma call shapes and return value transformations.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockDb = vi.hoisted(() => ({
  billingEvent: {
    create: vi.fn(),
    findMany: vi.fn(),
  },
}));

vi.mock("../../app/db.server", () => ({
  default: mockDb,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  recordBillingEvent,
  getBillingEventStats,
  type BillingEventType,
} from "../../app/models/billing-event.server";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const SHOP_ID = "shop-abc-123";

const BASE_BILLING_EVENT = {
  id: "event-1",
  shopId: SHOP_ID,
  eventType: "upgrade" as BillingEventType,
  fromPlan: "free",
  toPlan: "Standard",
  amount: 29,
  createdAt: new Date("2026-01-15T10:00:00Z"),
};

// ---------------------------------------------------------------------------
// recordBillingEvent
// ---------------------------------------------------------------------------

describe("recordBillingEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a BillingEvent with all provided fields", async () => {
    mockDb.billingEvent.create.mockResolvedValue(BASE_BILLING_EVENT);

    const result = await recordBillingEvent({
      shopId: SHOP_ID,
      eventType: "upgrade",
      fromPlan: "free",
      toPlan: "Standard",
      amount: 29,
    });

    expect(mockDb.billingEvent.create).toHaveBeenCalledOnce();
    expect(mockDb.billingEvent.create).toHaveBeenCalledWith({
      data: {
        shopId: SHOP_ID,
        eventType: "upgrade",
        fromPlan: "free",
        toPlan: "Standard",
        amount: 29,
      },
    });
    expect(result).toEqual(BASE_BILLING_EVENT);
  });

  it("stores null for optional fields when they are not provided", async () => {
    mockDb.billingEvent.create.mockResolvedValue({
      ...BASE_BILLING_EVENT,
      fromPlan: null,
      toPlan: null,
      amount: null,
    });

    await recordBillingEvent({
      shopId: SHOP_ID,
      eventType: "cancellation",
    });

    expect(mockDb.billingEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        fromPlan: null,
        toPlan: null,
        amount: null,
      }),
    });
  });

  it("stores null when fromPlan is explicitly null", async () => {
    mockDb.billingEvent.create.mockResolvedValue(BASE_BILLING_EVENT);

    await recordBillingEvent({ shopId: SHOP_ID, eventType: "upgrade", fromPlan: null });

    const callArg = mockDb.billingEvent.create.mock.calls[0][0];
    expect(callArg.data.fromPlan).toBeNull();
  });

  it("propagates a database error", async () => {
    mockDb.billingEvent.create.mockRejectedValue(new Error("DB write failed"));

    await expect(recordBillingEvent({ shopId: SHOP_ID, eventType: "upgrade" })).rejects.toThrow(
      "DB write failed",
    );
  });
});

// ---------------------------------------------------------------------------
// getBillingEventStats — with exclusion opts (gc-9ms)
// ---------------------------------------------------------------------------

describe("getBillingEventStats with exclusion opts", () => {
  const excludeSet = new Set(["nw-dev-store-2.myshopify.com"]);
  const excludePrefixes = new Set(["app-review-"]);
  const since = new Date("2026-01-01T00:00:00Z");

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("drops events from an excluded exact domain AND an app-review-* prefix domain, counting only real-store events", async () => {
    mockDb.billingEvent.findMany.mockResolvedValue([
      // Excluded: exact dev-store match.
      { eventType: "upgrade", shop: { domain: "nw-dev-store-2.myshopify.com" } },
      // Excluded: ephemeral app-review-* prefix match.
      { eventType: "downgrade", shop: { domain: "app-review-abc123.myshopify.com" } },
      // Kept: real merchant stores.
      { eventType: "upgrade", shop: { domain: "real-a.myshopify.com" } },
      { eventType: "cancellation", shop: { domain: "real-b.myshopify.com" } },
    ]);

    const result = await getBillingEventStats(since, { excludeSet, excludePrefixes });

    expect(result).toEqual({
      upgrade: 1, // only real-a's upgrade; dev-store upgrade dropped
      downgrade: 0, // app-review downgrade dropped
      cancellation: 1,
      reactivation: 0,
    });
  });

  it("fetches events with the shop domain and the in-window createdAt filter when opts is provided", async () => {
    mockDb.billingEvent.findMany.mockResolvedValue([]);

    await getBillingEventStats(since, { excludeSet, excludePrefixes });

    expect(mockDb.billingEvent.findMany).toHaveBeenCalledWith({
      where: { createdAt: { gte: since } },
      select: { eventType: true, shop: { select: { domain: true, isInternal: true } } },
    });
  });

  it("drops an event whose shop is isInternal:true even when its domain is not in the exclude set", async () => {
    // Durable primary signal: a renamed internal store has a clean-looking domain
    // but its billing events must still be excluded from the digest line.
    mockDb.billingEvent.findMany.mockResolvedValue([
      { eventType: "upgrade", shop: { domain: "clean-domain.myshopify.com", isInternal: true } },
      { eventType: "upgrade", shop: { domain: "real.myshopify.com", isInternal: false } },
    ]);

    const result = await getBillingEventStats(since, { excludeSet, excludePrefixes });

    expect(result).toEqual({
      upgrade: 1, // only the real store's upgrade; the internal one dropped
      downgrade: 0,
      cancellation: 0,
      reactivation: 0,
    });
  });

  it("counts a real-store event and ignores unknown event types", async () => {
    mockDb.billingEvent.findMany.mockResolvedValue([
      { eventType: "reactivation", shop: { domain: "real.myshopify.com" } },
      { eventType: "unknown-future-type", shop: { domain: "real.myshopify.com" } },
    ]);

    const result = await getBillingEventStats(since, { excludeSet, excludePrefixes });

    expect(result).toEqual({
      upgrade: 0,
      downgrade: 0,
      cancellation: 0,
      reactivation: 1,
    });
  });

  // gc-m5d: fail CLOSED. An event with no resolvable shop cannot be proven to
  // belong to a real merchant, so it must not be counted (unreachable today via
  // the required shopId FK, but the safe default must not be inverted).
  it("drops an event whose shop is null (fail closed)", async () => {
    mockDb.billingEvent.findMany.mockResolvedValue([
      { eventType: "upgrade", shop: null },
      { eventType: "upgrade", shop: { domain: "real.myshopify.com", isInternal: false } },
    ]);

    const result = await getBillingEventStats(since, { excludeSet, excludePrefixes });

    expect(result.upgrade).toBe(1);
  });

  it("returns zero counts for all event types when there are no events", async () => {
    mockDb.billingEvent.findMany.mockResolvedValue([]);

    const result = await getBillingEventStats(since, { excludeSet, excludePrefixes });

    expect(result).toEqual({ upgrade: 0, downgrade: 0, cancellation: 0, reactivation: 0 });
  });

  it("omits the where clause when since is undefined (all-time)", async () => {
    mockDb.billingEvent.findMany.mockResolvedValue([]);

    await getBillingEventStats(undefined, { excludeSet, excludePrefixes });

    expect(mockDb.billingEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: undefined }),
    );
  });

  it("propagates a database error", async () => {
    mockDb.billingEvent.findMany.mockRejectedValue(new Error("Query failed"));

    await expect(getBillingEventStats(since, { excludeSet, excludePrefixes })).rejects.toThrow(
      "Query failed",
    );
  });
});

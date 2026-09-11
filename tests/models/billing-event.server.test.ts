/**
 * Tests for app/models/billing-event.server.ts
 *
 * Strategy:
 *   - Mock db.server (Prisma client) to control DB responses.
 *   - Test each exported function: recordBillingEvent, getBillingEventStats.
 *   - Verify Prisma call shapes and return value transformations.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockDb = vi.hoisted(() => ({
  billingEvent: {
    create: vi.fn(),
    groupBy: vi.fn(),
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
// getBillingEventStats
// ---------------------------------------------------------------------------

describe("getBillingEventStats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns zero counts for all event types when no rows are returned", async () => {
    mockDb.billingEvent.groupBy.mockResolvedValue([]);

    const result = await getBillingEventStats();

    expect(result).toEqual({
      upgrade: 0,
      downgrade: 0,
      cancellation: 0,
      reactivation: 0,
    });
  });

  it("returns correct counts mapped from groupBy rows", async () => {
    mockDb.billingEvent.groupBy.mockResolvedValue([
      { eventType: "upgrade", _count: { eventType: 12 } },
      { eventType: "downgrade", _count: { eventType: 3 } },
      { eventType: "cancellation", _count: { eventType: 5 } },
    ]);

    const result = await getBillingEventStats();

    expect(result).toEqual({
      upgrade: 12,
      downgrade: 3,
      cancellation: 5,
      reactivation: 0, // not in rows — should be 0
    });
  });

  it("calls groupBy without a where clause when since is not provided", async () => {
    mockDb.billingEvent.groupBy.mockResolvedValue([]);

    await getBillingEventStats();

    expect(mockDb.billingEvent.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: undefined }),
    );
  });

  it("adds a createdAt gte filter when since is provided", async () => {
    mockDb.billingEvent.groupBy.mockResolvedValue([]);
    const since = new Date("2026-01-01T00:00:00Z");

    await getBillingEventStats(since);

    expect(mockDb.billingEvent.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { createdAt: { gte: since } },
      }),
    );
  });

  it("groups by eventType with count aggregation", async () => {
    mockDb.billingEvent.groupBy.mockResolvedValue([]);

    await getBillingEventStats();

    expect(mockDb.billingEvent.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ["eventType"],
        _count: { eventType: true },
      }),
    );
  });

  it("ignores unknown eventType values gracefully (does not throw)", async () => {
    mockDb.billingEvent.groupBy.mockResolvedValue([
      { eventType: "unknown-future-type", _count: { eventType: 7 } },
    ]);

    const result = await getBillingEventStats();

    // Unknown types are ignored — known types remain 0
    expect(result).toEqual({
      upgrade: 0,
      downgrade: 0,
      cancellation: 0,
      reactivation: 0,
    });
  });

  it("propagates a database error", async () => {
    mockDb.billingEvent.groupBy.mockRejectedValue(new Error("Query failed"));

    await expect(getBillingEventStats()).rejects.toThrow("Query failed");
  });
});

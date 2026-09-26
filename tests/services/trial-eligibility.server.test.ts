/**
 * Tests for app/services/trial-eligibility.server.ts (gc-97k.8) with the REAL
 * hasBillingHistory (billing-event model) against a mocked Prisma client.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = vi.hoisted(() => ({
  billingEvent: { findFirst: vi.fn() },
}));

vi.mock("../../app/db.server", () => ({ default: mockDb }));

const mockLoggerError = vi.fn();
vi.mock("../../app/lib/logger.server", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));

import { getTrialEligibility } from "../../app/services/trial-eligibility.server";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getTrialEligibility", () => {
  it("never-paid Free shop (no BillingEvent): eligible", async () => {
    mockDb.billingEvent.findFirst.mockResolvedValue(null);

    await expect(
      getTrialEligibility({ id: "shop-1", plan: "free", everPaidAt: null }),
    ).resolves.toBe(true);
    expect(mockDb.billingEvent.findFirst).toHaveBeenCalledWith({
      where: { shopId: "shop-1" },
      select: { id: true },
    });
  });

  it("previously-paid Free shop (any BillingEvent): not eligible", async () => {
    mockDb.billingEvent.findFirst.mockResolvedValue({ id: "be-1" });

    await expect(
      getTrialEligibility({ id: "shop-1", plan: "free", everPaidAt: null }),
    ).resolves.toBe(false);
  });

  it.each(["Standard", "Professional"])(
    "a %s shop is not eligible and costs no query",
    async (plan) => {
      await expect(getTrialEligibility({ id: "shop-1", plan, everPaidAt: null })).resolves.toBe(
        false,
      );
      expect(mockDb.billingEvent.findFirst).not.toHaveBeenCalled();
    },
  );

  it("a Free shop with everPaidAt set is not eligible and costs no query", async () => {
    await expect(
      getTrialEligibility({
        id: "shop-1",
        plan: "free",
        everPaidAt: new Date("2026-05-01T00:00:00Z"),
      }),
    ).resolves.toBe(false);
    expect(mockDb.billingEvent.findFirst).not.toHaveBeenCalled();
  });

  it("a Free shop with no everPaidAt still checks BillingEvent (both signals kept)", async () => {
    mockDb.billingEvent.findFirst.mockResolvedValue({ id: "be-1" });

    await expect(
      getTrialEligibility({ id: "shop-1", plan: "free", everPaidAt: null }),
    ).resolves.toBe(false);
    expect(mockDb.billingEvent.findFirst).toHaveBeenCalledTimes(1);
  });

  it("never throws: a failed read logs and falls back to the non-trial copy", async () => {
    mockDb.billingEvent.findFirst.mockRejectedValue(new Error("db down"));

    await expect(
      getTrialEligibility({ id: "shop-1", plan: "free", everPaidAt: null }),
    ).resolves.toBe(false);
    expect(mockLoggerError).toHaveBeenCalledWith("trial-eligibility-read-failed", {
      shopId: "shop-1",
      error: "db down",
    });
  });
});

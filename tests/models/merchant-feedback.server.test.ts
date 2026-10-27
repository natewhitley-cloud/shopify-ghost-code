/**
 * Tests for app/models/merchant-feedback.server.ts (gc-97k.3, Help messages
 * since gc-3twe).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = vi.hoisted(() => ({
  merchantFeedback: { create: vi.fn(), count: vi.fn() },
}));

vi.mock("../../app/db.server", () => ({ default: mockDb }));

import {
  countMerchantFeedbackSince,
  createMerchantFeedback,
} from "../../app/models/merchant-feedback.server";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createMerchantFeedback", () => {
  it("inserts one row for the shop with every field, nulls included", async () => {
    mockDb.merchantFeedback.create.mockResolvedValue({ id: "fb-1" });
    const data = {
      topic: "bug",
      message: "Scan stuck",
      csat: null,
      contactEmail: "owner@shop.com",
      contactConsentAt: new Date("2026-10-27T00:00:00Z"),
      context: "plan=free; latestScan=none",
    };

    await expect(createMerchantFeedback("shop-1", data)).resolves.toEqual({ id: "fb-1" });

    expect(mockDb.merchantFeedback.create).toHaveBeenCalledWith({
      data: { shopId: "shop-1", ...data },
    });
  });
});

describe("countMerchantFeedbackSince", () => {
  it("counts the shop's rows created at or after `since`", async () => {
    mockDb.merchantFeedback.count.mockResolvedValue(3);
    const since = new Date("2026-10-26T12:00:00Z");

    await expect(countMerchantFeedbackSince("shop-1", since)).resolves.toBe(3);
    expect(mockDb.merchantFeedback.count).toHaveBeenCalledWith({
      where: { shopId: "shop-1", createdAt: { gte: since } },
    });
  });
});

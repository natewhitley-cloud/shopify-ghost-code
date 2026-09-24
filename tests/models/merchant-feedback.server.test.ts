/**
 * Tests for app/models/merchant-feedback.server.ts (gc-97k.3).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = vi.hoisted(() => ({
  merchantFeedback: { create: vi.fn() },
}));

vi.mock("../../app/db.server", () => ({ default: mockDb }));

import { createMerchantFeedback } from "../../app/models/merchant-feedback.server";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createMerchantFeedback", () => {
  it("inserts one row for the shop with every answer, nulls included", async () => {
    mockDb.merchantFeedback.create.mockResolvedValue({ id: "fb-1" });
    const data = {
      csat: 2,
      valuable: null,
      improvement: "More detail",
      wtp: null,
      contactEmail: null,
    };

    await expect(createMerchantFeedback("shop-1", data)).resolves.toEqual({ id: "fb-1" });

    expect(mockDb.merchantFeedback.create).toHaveBeenCalledWith({
      data: { shopId: "shop-1", ...data },
    });
  });
});

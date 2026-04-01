/**
 * Tests for the shop model functions, focusing on updateShopPlanByDomain
 * which was added for the billing webhook handler.
 *
 * Strategy:
 *   - Mock db.server (Prisma client) to control DB responses.
 *   - Test the function in isolation — no Shopify SDK involvement.
 *
 * Note on vi.mock hoisting: vi.mock factory functions run before any top-level
 * variable initializations in the test file. Use vi.hoisted() to define mock
 * objects that are referenced inside a vi.mock factory.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// vi.hoisted() runs before vi.mock factories, making mockDb safe to reference
// inside the factory below.
const mockDb = vi.hoisted(() => ({
  shop: {
    findUnique: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  session: {
    deleteMany: vi.fn(),
  },
  scan: {
    deleteMany: vi.fn(),
  },
  // Array-form $transaction: resolve each staged operation in parallel.
  $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
}));

vi.mock("../../app/db.server", () => ({
  default: mockDb,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  updateShopPlanByDomain,
  updateThemePublishTimestamp,
  dismissReviewPrompt,
  deleteShopData,
} from "../../app/models/shop.server";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("updateShopPlanByDomain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when the shop domain is not found in DB", async () => {
    mockDb.shop.findUnique.mockResolvedValue(null);

    const result = await updateShopPlanByDomain("unknown.myshopify.com", "Standard");

    expect(result).toBeNull();
    expect(mockDb.shop.update).not.toHaveBeenCalled();
  });

  it("calls db.shop.update with the correct domain and plan when shop exists", async () => {
    const existingShop = {
      id: "shop-123",
      domain: "test-shop.myshopify.com",
      accessToken: "token-abc",
      plan: "free",
    };
    mockDb.shop.findUnique.mockResolvedValue(existingShop);
    mockDb.shop.update.mockResolvedValue({
      id: "shop-123",
      domain: "test-shop.myshopify.com",
      plan: "Standard",
    });

    const result = await updateShopPlanByDomain("test-shop.myshopify.com", "Standard");

    expect(mockDb.shop.update).toHaveBeenCalledWith({
      where: { domain: "test-shop.myshopify.com" },
      data: { plan: "Standard" },
      select: { id: true, domain: true, plan: true },
    });
    expect(result).toEqual({
      id: "shop-123",
      domain: "test-shop.myshopify.com",
      plan: "Standard",
    });
  });

  it("persists the free plan string on downgrade", async () => {
    const existingShop = {
      id: "shop-456",
      domain: "another-shop.myshopify.com",
      accessToken: "token-xyz",
      plan: "Standard",
    };
    mockDb.shop.findUnique.mockResolvedValue(existingShop);
    mockDb.shop.update.mockResolvedValue({
      id: "shop-456",
      domain: "another-shop.myshopify.com",
      plan: "free",
    });

    const result = await updateShopPlanByDomain("another-shop.myshopify.com", "free");

    expect(mockDb.shop.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { plan: "free" } }),
    );
    expect(result?.plan).toBe("free");
  });

  it("persists the Professional plan string when upgrading", async () => {
    const existingShop = {
      id: "shop-789",
      domain: "pro-shop.myshopify.com",
      accessToken: "token-pro",
      plan: "Standard",
    };
    mockDb.shop.findUnique.mockResolvedValue(existingShop);
    mockDb.shop.update.mockResolvedValue({
      id: "shop-789",
      domain: "pro-shop.myshopify.com",
      plan: "Professional",
    });

    const result = await updateShopPlanByDomain("pro-shop.myshopify.com", "Professional");

    expect(mockDb.shop.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { plan: "Professional" } }),
    );
    expect(result?.plan).toBe("Professional");
  });
});

// ---------------------------------------------------------------------------
// updateThemePublishTimestamp
// ---------------------------------------------------------------------------

describe("updateThemePublishTimestamp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when the shop domain is not found in DB", async () => {
    mockDb.shop.findUnique.mockResolvedValue(null);

    const result = await updateThemePublishTimestamp("unknown.myshopify.com");

    expect(result).toBeNull();
    expect(mockDb.shop.update).not.toHaveBeenCalled();
  });

  it("calls db.shop.update with lastThemePublishAt set to a Date when shop exists", async () => {
    const existingShop = {
      id: "shop-123",
      domain: "test-shop.myshopify.com",
      accessToken: "token-abc",
      plan: "free",
    };
    mockDb.shop.findUnique.mockResolvedValue(existingShop);
    mockDb.shop.update.mockResolvedValue({
      id: "shop-123",
      domain: "test-shop.myshopify.com",
    });

    await updateThemePublishTimestamp("test-shop.myshopify.com");

    expect(mockDb.shop.update).toHaveBeenCalledOnce();
    const callArg = mockDb.shop.update.mock.calls[0][0];
    expect(callArg.where).toEqual({ domain: "test-shop.myshopify.com" });
    expect(callArg.data.lastThemePublishAt).toBeInstanceOf(Date);
  });

  it("returns the updated shop object with id and domain when shop is found", async () => {
    const existingShop = {
      id: "shop-456",
      domain: "another-shop.myshopify.com",
      accessToken: "token-xyz",
      plan: "Standard",
    };
    mockDb.shop.findUnique.mockResolvedValue(existingShop);
    mockDb.shop.update.mockResolvedValue({
      id: "shop-456",
      domain: "another-shop.myshopify.com",
    });

    const result = await updateThemePublishTimestamp("another-shop.myshopify.com");

    expect(result).toEqual({
      id: "shop-456",
      domain: "another-shop.myshopify.com",
    });
  });

  it("selects only id and domain in the update call", async () => {
    const existingShop = {
      id: "shop-789",
      domain: "select-test.myshopify.com",
      accessToken: "token-select",
      plan: "free",
    };
    mockDb.shop.findUnique.mockResolvedValue(existingShop);
    mockDb.shop.update.mockResolvedValue({
      id: "shop-789",
      domain: "select-test.myshopify.com",
    });

    await updateThemePublishTimestamp("select-test.myshopify.com");

    expect(mockDb.shop.update).toHaveBeenCalledWith(
      expect.objectContaining({
        select: { id: true, domain: true },
      }),
    );
  });

  it("propagates a database error from update", async () => {
    const existingShop = {
      id: "shop-err",
      domain: "error-shop.myshopify.com",
      accessToken: "token-err",
      plan: "free",
    };
    mockDb.shop.findUnique.mockResolvedValue(existingShop);
    mockDb.shop.update.mockRejectedValueOnce(new Error("DB write failed"));

    await expect(updateThemePublishTimestamp("error-shop.myshopify.com")).rejects.toThrow(
      "DB write failed",
    );
  });
});

// ---------------------------------------------------------------------------
// dismissReviewPrompt
// ---------------------------------------------------------------------------

describe("dismissReviewPrompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when the shop id is not found in DB", async () => {
    mockDb.shop.findUnique.mockResolvedValue(null);

    const result = await dismissReviewPrompt("nonexistent-id");

    expect(result).toBeNull();
    expect(mockDb.shop.update).not.toHaveBeenCalled();
  });

  it("calls db.shop.update with hasSeenReviewPrompt: true when shop exists", async () => {
    const existingShop = {
      id: "shop-review-1",
      domain: "review-shop.myshopify.com",
      accessToken: "token-abc",
      plan: "free",
      hasSeenReviewPrompt: false,
    };
    mockDb.shop.findUnique.mockResolvedValue(existingShop);
    mockDb.shop.update.mockResolvedValue({ id: "shop-review-1" });

    await dismissReviewPrompt("shop-review-1");

    expect(mockDb.shop.update).toHaveBeenCalledWith({
      where: { id: "shop-review-1" },
      data: { hasSeenReviewPrompt: true },
      select: { id: true },
    });
  });

  it("returns the updated shop object with id on success", async () => {
    const existingShop = {
      id: "shop-review-2",
      domain: "review-shop-2.myshopify.com",
      accessToken: "token-xyz",
      plan: "Standard",
      hasSeenReviewPrompt: false,
    };
    mockDb.shop.findUnique.mockResolvedValue(existingShop);
    mockDb.shop.update.mockResolvedValue({ id: "shop-review-2" });

    const result = await dismissReviewPrompt("shop-review-2");

    expect(result).toEqual({ id: "shop-review-2" });
  });

  it("looks up shop by id (not domain)", async () => {
    mockDb.shop.findUnique.mockResolvedValue(null);

    await dismissReviewPrompt("shop-id-123");

    expect(mockDb.shop.findUnique).toHaveBeenCalledWith({
      where: { id: "shop-id-123" },
    });
  });

  it("propagates a database error from update", async () => {
    const existingShop = {
      id: "shop-review-err",
      domain: "error-shop.myshopify.com",
      accessToken: "token-err",
      plan: "free",
      hasSeenReviewPrompt: false,
    };
    mockDb.shop.findUnique.mockResolvedValue(existingShop);
    mockDb.shop.update.mockRejectedValueOnce(new Error("DB write failed"));

    await expect(dismissReviewPrompt("shop-review-err")).rejects.toThrow("DB write failed");
  });
});

// ---------------------------------------------------------------------------
// deleteShopData
// ---------------------------------------------------------------------------

describe("deleteShopData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when the shop domain is not found in DB", async () => {
    mockDb.shop.findUnique.mockResolvedValue(null);

    const result = await deleteShopData("ghost.myshopify.com");

    expect(result).toBeNull();
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("does not call $transaction when shop is not found", async () => {
    mockDb.shop.findUnique.mockResolvedValue(null);

    await deleteShopData("ghost.myshopify.com");

    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("calls $transaction when the shop exists", async () => {
    const existingShop = {
      id: "shop-gdpr-1",
      domain: "delete-me.myshopify.com",
      accessToken: "token-gdpr",
      plan: "free",
    };
    mockDb.shop.findUnique.mockResolvedValue(existingShop);
    mockDb.session.deleteMany.mockResolvedValue({ count: 2 });
    mockDb.scan.deleteMany.mockResolvedValue({ count: 3 });
    mockDb.shop.delete.mockResolvedValue(existingShop);

    await deleteShopData("delete-me.myshopify.com");

    expect(mockDb.$transaction).toHaveBeenCalledOnce();
  });

  it("calls session.deleteMany with the domain string (not shopId)", async () => {
    const existingShop = {
      id: "shop-gdpr-2",
      domain: "delete-me.myshopify.com",
      accessToken: "token-gdpr",
      plan: "free",
    };
    mockDb.shop.findUnique.mockResolvedValue(existingShop);
    mockDb.session.deleteMany.mockResolvedValue({ count: 1 });
    mockDb.scan.deleteMany.mockResolvedValue({ count: 0 });
    mockDb.shop.delete.mockResolvedValue(existingShop);

    await deleteShopData("delete-me.myshopify.com");

    expect(mockDb.session.deleteMany).toHaveBeenCalledWith({
      where: { shop: "delete-me.myshopify.com" },
    });
  });

  it("does not call scan.deleteMany (cascade handles it via onDelete: Cascade on Shop FK)", async () => {
    const existingShop = {
      id: "shop-gdpr-3",
      domain: "delete-me.myshopify.com",
      accessToken: "token-gdpr",
      plan: "free",
    };
    mockDb.shop.findUnique.mockResolvedValue(existingShop);
    mockDb.session.deleteMany.mockResolvedValue({ count: 0 });
    mockDb.shop.delete.mockResolvedValue(existingShop);

    await deleteShopData("delete-me.myshopify.com");

    expect(mockDb.scan.deleteMany).not.toHaveBeenCalled();
  });

  it("calls shop.delete with the domain", async () => {
    const existingShop = {
      id: "shop-gdpr-4",
      domain: "delete-me.myshopify.com",
      accessToken: "token-gdpr",
      plan: "free",
    };
    mockDb.shop.findUnique.mockResolvedValue(existingShop);
    mockDb.session.deleteMany.mockResolvedValue({ count: 0 });
    mockDb.scan.deleteMany.mockResolvedValue({ count: 0 });
    mockDb.shop.delete.mockResolvedValue(existingShop);

    await deleteShopData("delete-me.myshopify.com");

    expect(mockDb.shop.delete).toHaveBeenCalledWith({
      where: { domain: "delete-me.myshopify.com" },
    });
  });

  it("returns the shop object (pre-deletion snapshot) on success", async () => {
    const existingShop = {
      id: "shop-gdpr-5",
      domain: "delete-me.myshopify.com",
      accessToken: "token-gdpr",
      plan: "Standard",
    };
    mockDb.shop.findUnique.mockResolvedValue(existingShop);
    mockDb.session.deleteMany.mockResolvedValue({ count: 1 });
    mockDb.scan.deleteMany.mockResolvedValue({ count: 2 });
    mockDb.shop.delete.mockResolvedValue(existingShop);

    const result = await deleteShopData("delete-me.myshopify.com");

    expect(result).toEqual(existingShop);
  });

  it("propagates a $transaction error", async () => {
    const existingShop = {
      id: "shop-gdpr-err",
      domain: "error-shop.myshopify.com",
      accessToken: "token-err",
      plan: "free",
    };
    mockDb.shop.findUnique.mockResolvedValue(existingShop);
    mockDb.$transaction.mockRejectedValueOnce(new Error("Transaction rolled back"));

    await expect(deleteShopData("error-shop.myshopify.com")).rejects.toThrow(
      "Transaction rolled back",
    );
  });
});

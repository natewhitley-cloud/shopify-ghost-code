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
    upsert: vi.fn(),
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
  getShopMetadata,
  upsertShop,
  updateShopPlanByDomain,
  updateThemePublishTimestamp,
  dismissReviewPrompt,
  deleteShopData,
} from "../../app/models/shop.server";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getShopMetadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when the shop domain is not found in DB", async () => {
    mockDb.shop.findUnique.mockResolvedValue(null);

    const result = await getShopMetadata("unknown.myshopify.com");

    expect(result).toBeNull();
  });

  it("queries with a select that excludes accessToken", async () => {
    mockDb.shop.findUnique.mockResolvedValue(null);

    await getShopMetadata("test-shop.myshopify.com");

    expect(mockDb.shop.findUnique).toHaveBeenCalledWith({
      where: { domain: "test-shop.myshopify.com" },
      select: {
        id: true,
        domain: true,
        plan: true,
        installedAt: true,
        lastThemePublishAt: true,
        hasSeenReviewPrompt: true,
      },
    });
  });

  it("returns all metadata fields when shop is found", async () => {
    const installedAt = new Date("2026-01-01T00:00:00Z");
    const lastThemePublishAt = new Date("2026-03-01T00:00:00Z");
    const shopMetadata = {
      id: "shop-123",
      domain: "test-shop.myshopify.com",
      plan: "Standard",
      installedAt,
      lastThemePublishAt,
      hasSeenReviewPrompt: false,
    };
    mockDb.shop.findUnique.mockResolvedValue(shopMetadata);

    const result = await getShopMetadata("test-shop.myshopify.com");

    expect(result).toEqual(shopMetadata);
  });

  it("returns null for lastThemePublishAt when field is null", async () => {
    const shopMetadata = {
      id: "shop-new",
      domain: "new-shop.myshopify.com",
      plan: "free",
      installedAt: new Date("2026-01-01T00:00:00Z"),
      lastThemePublishAt: null,
      hasSeenReviewPrompt: false,
    };
    mockDb.shop.findUnique.mockResolvedValue(shopMetadata);

    const result = await getShopMetadata("new-shop.myshopify.com");

    expect(result?.lastThemePublishAt).toBeNull();
  });

  it("does not include accessToken in the returned object", async () => {
    // Simulate Prisma returning only the selected fields (no accessToken)
    const shopMetadata = {
      id: "shop-123",
      domain: "test-shop.myshopify.com",
      plan: "free",
      installedAt: new Date("2026-01-01T00:00:00Z"),
      lastThemePublishAt: null,
      hasSeenReviewPrompt: false,
    };
    mockDb.shop.findUnique.mockResolvedValue(shopMetadata);

    const result = await getShopMetadata("test-shop.myshopify.com");

    expect(result).not.toHaveProperty("accessToken");
  });
});

// ---------------------------------------------------------------------------
// upsertShop
// ---------------------------------------------------------------------------

describe("upsertShop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("upserts by domain with create:{domain} and an empty update (no token)", async () => {
    mockDb.shop.upsert.mockResolvedValue({
      id: "shop-new",
      domain: "new-shop.myshopify.com",
      plan: "free",
    });

    await upsertShop("new-shop.myshopify.com");

    expect(mockDb.shop.upsert).toHaveBeenCalledWith({
      where: { domain: "new-shop.myshopify.com" },
      create: { domain: "new-shop.myshopify.com" },
      update: {},
    });
  });

  it("returns the created shop record on first install", async () => {
    const created = {
      id: "shop-created",
      domain: "first-install.myshopify.com",
      plan: "free",
      installedAt: new Date("2026-06-15T00:00:00Z"),
      lastThemePublishAt: null,
      hasSeenReviewPrompt: false,
    };
    mockDb.shop.upsert.mockResolvedValue(created);

    const result = await upsertShop("first-install.myshopify.com");

    expect(result).toEqual(created);
  });

  it("returns the existing record on re-install without mutating metadata (update is a no-op)", async () => {
    const existing = {
      id: "shop-existing",
      domain: "re-install.myshopify.com",
      plan: "Professional",
      installedAt: new Date("2026-01-01T00:00:00Z"),
      lastThemePublishAt: new Date("2026-05-01T00:00:00Z"),
      hasSeenReviewPrompt: true,
    };
    mockDb.shop.upsert.mockResolvedValue(existing);

    const result = await upsertShop("re-install.myshopify.com");

    // The update clause is empty, so an existing shop's plan/flags are preserved.
    expect(mockDb.shop.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: {} }));
    expect(result).toEqual(existing);
  });

  it("does not pass an accessToken in the create or update clause", async () => {
    mockDb.shop.upsert.mockResolvedValue({ id: "shop-x", domain: "x.myshopify.com" });

    await upsertShop("x.myshopify.com");

    const callArg = mockDb.shop.upsert.mock.calls[0][0];
    expect(callArg.create).not.toHaveProperty("accessToken");
    expect(callArg.update).not.toHaveProperty("accessToken");
  });

  it("propagates a database error from upsert", async () => {
    mockDb.shop.upsert.mockRejectedValueOnce(new Error("DB write failed"));

    await expect(upsertShop("err.myshopify.com")).rejects.toThrow("DB write failed");
  });
});

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
      plan: "free",
    };
    mockDb.shop.findUnique.mockResolvedValue(existingShop);
    mockDb.$transaction.mockRejectedValueOnce(new Error("Transaction rolled back"));

    await expect(deleteShopData("error-shop.myshopify.com")).rejects.toThrow(
      "Transaction rolled back",
    );
  });
});

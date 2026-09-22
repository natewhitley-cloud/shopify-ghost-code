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
    updateMany: vi.fn(),
    delete: vi.fn(),
  },
  session: {
    deleteMany: vi.fn(),
  },
  scan: {
    deleteMany: vi.fn(),
  },
  opsEvent: {
    create: vi.fn(),
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

import { OPS_EVENT_TYPES } from "../../app/models/ops-event.server";
import {
  getShopMetadata,
  upsertShop,
  updateShopPlanByDomain,
  stampPlanReconciledAt,
  updateThemePublishTimestamp,
  dismissReviewPrompt,
  deleteShopData,
  markShopUninstalled,
  markShopUninstalledWithEvent,
  reactivateShop,
  isLastSeenStale,
  touchShopLastSeen,
  LAST_SEEN_FRESHNESS_MS,
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
        planReconciledAt: true,
        installedAt: true,
        uninstalledAt: true,
        lastSeenAt: true,
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

  it("upserts by domain with create:{domain} and a reinstall-reset update (no token)", async () => {
    mockDb.shop.upsert.mockResolvedValue({
      id: "shop-new",
      domain: "new-shop.myshopify.com",
      plan: "free",
    });

    await upsertShop("new-shop.myshopify.com");

    expect(mockDb.shop.upsert).toHaveBeenCalledWith({
      where: { domain: "new-shop.myshopify.com" },
      create: { domain: "new-shop.myshopify.com" },
      // Reinstall clears the uninstalled flag (gc-grd).
      update: { uninstalledAt: null },
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

  it("clears uninstalledAt on re-install while preserving other metadata (plan/flags)", async () => {
    const existing = {
      id: "shop-existing",
      domain: "re-install.myshopify.com",
      plan: "Professional",
      installedAt: new Date("2026-01-01T00:00:00Z"),
      uninstalledAt: null,
      lastThemePublishAt: new Date("2026-05-01T00:00:00Z"),
      hasSeenReviewPrompt: true,
    };
    mockDb.shop.upsert.mockResolvedValue(existing);

    const result = await upsertShop("re-install.myshopify.com");

    // The update clause only clears uninstalledAt (reinstall-reset); it does not
    // touch plan/flags, so an existing shop's other metadata is preserved.
    expect(mockDb.shop.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { uninstalledAt: null } }),
    );
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
      data: { plan: "Standard", planReconciledAt: expect.any(Date) },
      select: { id: true, domain: true, plan: true },
    });
    expect(result).toEqual({
      id: "shop-123",
      domain: "test-shop.myshopify.com",
      plan: "Standard",
    });
  });

  it("stamps planReconciledAt to a Date alongside the plan write", async () => {
    const existingShop = {
      id: "shop-stamp",
      domain: "stamp-shop.myshopify.com",
      plan: "free",
    };
    mockDb.shop.findUnique.mockResolvedValue(existingShop);
    mockDb.shop.update.mockResolvedValue({
      id: "shop-stamp",
      domain: "stamp-shop.myshopify.com",
      plan: "Standard",
    });

    await updateShopPlanByDomain("stamp-shop.myshopify.com", "Standard");

    const callArg = mockDb.shop.update.mock.calls[0][0];
    expect(callArg.data.planReconciledAt).toBeInstanceOf(Date);
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
      expect.objectContaining({ data: { plan: "free", planReconciledAt: expect.any(Date) } }),
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
      expect.objectContaining({
        data: { plan: "Professional", planReconciledAt: expect.any(Date) },
      }),
    );
    expect(result?.plan).toBe("Professional");
  });
});

// ---------------------------------------------------------------------------
// stampPlanReconciledAt
// ---------------------------------------------------------------------------

describe("stampPlanReconciledAt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when the shop domain is not found in DB", async () => {
    mockDb.shop.findUnique.mockResolvedValue(null);

    const result = await stampPlanReconciledAt("unknown.myshopify.com");

    expect(result).toBeNull();
    expect(mockDb.shop.update).not.toHaveBeenCalled();
  });

  it("updates only planReconciledAt (a Date) without touching the plan", async () => {
    mockDb.shop.findUnique.mockResolvedValue({
      id: "shop-noop",
      domain: "noop-shop.myshopify.com",
      plan: "Standard",
    });
    mockDb.shop.update.mockResolvedValue({ id: "shop-noop" });

    const result = await stampPlanReconciledAt("noop-shop.myshopify.com");

    const callArg = mockDb.shop.update.mock.calls[0][0];
    expect(callArg.where).toEqual({ domain: "noop-shop.myshopify.com" });
    expect(callArg.data.planReconciledAt).toBeInstanceOf(Date);
    expect(callArg.data).not.toHaveProperty("plan");
    expect(callArg.select).toEqual({ id: true });
    expect(result).toEqual({ id: "shop-noop" });
  });

  it("propagates a database error from update", async () => {
    mockDb.shop.findUnique.mockResolvedValue({
      id: "shop-err",
      domain: "err-shop.myshopify.com",
      plan: "free",
    });
    mockDb.shop.update.mockRejectedValueOnce(new Error("DB write failed"));

    await expect(stampPlanReconciledAt("err-shop.myshopify.com")).rejects.toThrow(
      "DB write failed",
    );
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

  it("purges OpsEvent rows carrying the domain (key + metadata.shop + metadata.shopDomain) and the internal shopId", async () => {
    const existingShop = {
      id: "shop-gdpr-ops",
      domain: "delete-me.myshopify.com",
      plan: "free",
    };
    mockDb.shop.findUnique.mockResolvedValue(existingShop);
    mockDb.session.deleteMany.mockResolvedValue({ count: 0 });
    mockDb.opsEvent.deleteMany.mockResolvedValue({ count: 3 });
    mockDb.shop.delete.mockResolvedValue(existingShop);

    await deleteShopData("delete-me.myshopify.com");

    expect(mockDb.opsEvent.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { key: "delete-me.myshopify.com" },
          { metadata: { path: ["shop"], equals: "delete-me.myshopify.com" } },
          { metadata: { path: ["shopDomain"], equals: "delete-me.myshopify.com" } },
          { metadata: { path: ["shopId"], equals: "shop-gdpr-ops" } },
        ],
      },
    });
  });

  it("removes page_visit OpsEvent rows keyed on the domain via the key clause", async () => {
    // Cross-check that binds page_visit's WRITE contract to the redact clause:
    // app/routes/app.tsx writes page_visit as { eventType: PAGE_VISIT, key: <domain> }.
    // We shape an event exactly like that write and assert deleteShopData's OR
    // predicate for this domain contains a clause matching THAT event's key. This
    // FAILS if page_visit were ever keyed on something other than the domain
    // (e.g. an internal shopId), which the domain-key clause would not reach.
    const domain = "delete-me.myshopify.com";
    const existingShop = {
      id: "shop-gdpr-pv",
      domain,
      plan: "free",
    };
    mockDb.shop.findUnique.mockResolvedValue(existingShop);
    mockDb.session.deleteMany.mockResolvedValue({ count: 0 });
    mockDb.opsEvent.deleteMany.mockResolvedValue({ count: 7 });
    mockDb.shop.delete.mockResolvedValue(existingShop);

    await deleteShopData(domain);

    // An event shaped like the ACTUAL page_visit write.
    const pageVisitEvent = { eventType: OPS_EVENT_TYPES.PAGE_VISIT, key: domain };
    const opsWhere = mockDb.opsEvent.deleteMany.mock.calls[0][0].where;
    // The redact OR must target the SAME key page_visit is written with.
    expect(pageVisitEvent.eventType).toBe(OPS_EVENT_TYPES.PAGE_VISIT);
    expect(opsWhere.OR).toContainEqual({ key: pageVisitEvent.key });
  });

  it("purges scan_signal OpsEvent rows via the internal shopId clause (they carry no domain)", async () => {
    // scan_signal events key on scanId and store the internal shop cuid in
    // metadata.shopId (not the domain), so only the shopId OR-clause reaches
    // them — the domain-based clauses never would. This asserts that clause is
    // present so scan_signal rows are erased on shop/redact (GDPR).
    const existingShop = {
      id: "shop-gdpr-signal",
      domain: "delete-me.myshopify.com",
      plan: "free",
    };
    mockDb.shop.findUnique.mockResolvedValue(existingShop);
    mockDb.session.deleteMany.mockResolvedValue({ count: 0 });
    mockDb.opsEvent.deleteMany.mockResolvedValue({ count: 5 });
    mockDb.shop.delete.mockResolvedValue(existingShop);

    await deleteShopData("delete-me.myshopify.com");

    const opsWhere = mockDb.opsEvent.deleteMany.mock.calls[0][0].where;
    expect(opsWhere.OR).toContainEqual({
      metadata: { path: ["shopId"], equals: "shop-gdpr-signal" },
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

// ---------------------------------------------------------------------------
// markShopUninstalled
// ---------------------------------------------------------------------------

describe("markShopUninstalled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes sessions and stamps uninstalledAt in a single transaction", async () => {
    mockDb.session.deleteMany.mockResolvedValue({ count: 2 });
    mockDb.shop.updateMany.mockResolvedValue({ count: 1 });

    await markShopUninstalled("bye.myshopify.com");

    expect(mockDb.$transaction).toHaveBeenCalledOnce();
    expect(mockDb.session.deleteMany).toHaveBeenCalledWith({
      where: { shop: "bye.myshopify.com" },
    });
    const updateArg = mockDb.shop.updateMany.mock.calls[0][0];
    expect(updateArg.where).toEqual({ domain: "bye.myshopify.com" });
    expect(updateArg.data.uninstalledAt).toBeInstanceOf(Date);
  });

  it("does NOT hard-delete the shop (keeps data for the shop/redact grace window)", async () => {
    mockDb.session.deleteMany.mockResolvedValue({ count: 1 });
    mockDb.shop.updateMany.mockResolvedValue({ count: 1 });

    await markShopUninstalled("bye.myshopify.com");

    expect(mockDb.shop.delete).not.toHaveBeenCalled();
  });

  it("returns found: true when a shop row was updated", async () => {
    mockDb.session.deleteMany.mockResolvedValue({ count: 0 });
    mockDb.shop.updateMany.mockResolvedValue({ count: 1 });

    const result = await markShopUninstalled("bye.myshopify.com");

    expect(result).toEqual({ found: true });
  });

  it("returns found: false (idempotent) when the shop row is already gone", async () => {
    mockDb.session.deleteMany.mockResolvedValue({ count: 0 });
    mockDb.shop.updateMany.mockResolvedValue({ count: 0 });

    const result = await markShopUninstalled("already-gone.myshopify.com");

    expect(result).toEqual({ found: false });
    // updateMany never throws on a missing row — no findUnique guard needed.
    expect(mockDb.shop.updateMany).toHaveBeenCalledOnce();
  });

  it("propagates a $transaction error", async () => {
    mockDb.$transaction.mockRejectedValueOnce(new Error("Transaction rolled back"));

    await expect(markShopUninstalled("err.myshopify.com")).rejects.toThrow(
      "Transaction rolled back",
    );
  });
});

// ---------------------------------------------------------------------------
// markShopUninstalledWithEvent (shared webhook + reconciler path, gc-dyt)
// ---------------------------------------------------------------------------

describe("markShopUninstalledWithEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.opsEvent.create.mockResolvedValue(undefined);
    mockDb.session.deleteMany.mockResolvedValue({ count: 0 });
    mockDb.shop.updateMany.mockResolvedValue({ count: 1 });
  });

  it("records a SHOP_UNINSTALLED OpsEvent (keyed on domain, with source metadata) then marks", async () => {
    const result = await markShopUninstalledWithEvent("bye.myshopify.com", {
      source: "reconciler",
      message: "reconciler-detected uninstall",
    });

    const createArg = mockDb.opsEvent.create.mock.calls[0][0];
    expect(createArg.data).toMatchObject({
      eventType: OPS_EVENT_TYPES.SHOP_UNINSTALLED,
      key: "bye.myshopify.com",
      message: "reconciler-detected uninstall",
      metadata: { source: "reconciler" },
    });
    // Delegates the mark to markShopUninstalled → returns its found result.
    expect(mockDb.shop.updateMany).toHaveBeenCalledOnce();
    expect(result).toEqual({ found: true });
  });

  it("carries source=webhook for the webhook caller and reports found:false when the row is gone", async () => {
    mockDb.shop.updateMany.mockResolvedValue({ count: 0 });

    const result = await markShopUninstalledWithEvent("gone.myshopify.com", {
      source: "webhook",
      message: "app/uninstalled",
    });

    expect(mockDb.opsEvent.create.mock.calls[0][0].data.metadata).toEqual({ source: "webhook" });
    expect(result).toEqual({ found: false });
  });
});

// ---------------------------------------------------------------------------
// reactivateShop
// ---------------------------------------------------------------------------

describe("reactivateShop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clears uninstalledAt AND nulls planReconciledAt via updateMany keyed on domain", async () => {
    mockDb.shop.updateMany.mockResolvedValue({ count: 1 });

    await reactivateShop("re-install.myshopify.com");

    expect(mockDb.shop.updateMany).toHaveBeenCalledWith({
      where: { domain: "re-install.myshopify.com" },
      // planReconciledAt is nulled so the next load treats the plan as stale and
      // forces a fresh reconcile — otherwise a fast uninstall -> reinstall inside
      // the 1h freshness window would keep a stale (possibly paid) plan (gc-bbb).
      data: { uninstalledAt: null, planReconciledAt: null },
    });
    // updateMany (not update) so a missing row is a safe no-op, not a throw.
    expect(mockDb.shop.update).not.toHaveBeenCalled();
  });

  it("nulls planReconciledAt so a reinstall forces a fresh plan reconcile", async () => {
    mockDb.shop.updateMany.mockResolvedValue({ count: 1 });

    await reactivateShop("re-install.myshopify.com");

    const callArg = mockDb.shop.updateMany.mock.calls[0][0];
    expect(callArg.data.planReconciledAt).toBeNull();
  });

  it("is a safe no-op (does not throw) when the shop row is absent", async () => {
    mockDb.shop.updateMany.mockResolvedValue({ count: 0 });

    await expect(reactivateShop("gone.myshopify.com")).resolves.toBeUndefined();
    expect(mockDb.shop.updateMany).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// isLastSeenStale
// ---------------------------------------------------------------------------

describe("isLastSeenStale", () => {
  const now = new Date("2026-06-17T12:00:00Z");

  it("treats null (never stamped) as stale", () => {
    expect(isLastSeenStale(null, now)).toBe(true);
  });

  it("is fresh within the freshness window", () => {
    const recent = new Date(now.getTime() - (LAST_SEEN_FRESHNESS_MS - 1000));
    expect(isLastSeenStale(recent, now)).toBe(false);
  });

  it("is stale at/after the freshness window", () => {
    const old = new Date(now.getTime() - LAST_SEEN_FRESHNESS_MS);
    expect(isLastSeenStale(old, now)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// touchShopLastSeen
// ---------------------------------------------------------------------------

describe("touchShopLastSeen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stamps lastSeenAt to a Date via updateMany keyed on the internal id", async () => {
    mockDb.shop.updateMany.mockResolvedValue({ count: 1 });

    await touchShopLastSeen("shop-123");

    const callArg = mockDb.shop.updateMany.mock.calls[0][0];
    expect(callArg.where).toEqual({ id: "shop-123" });
    expect(callArg.data.lastSeenAt).toBeInstanceOf(Date);
    // updateMany (not update) so a missing row is a safe no-op, not a throw.
    expect(mockDb.shop.update).not.toHaveBeenCalled();
  });

  it("is a safe no-op (does not throw) when the shop row is absent", async () => {
    mockDb.shop.updateMany.mockResolvedValue({ count: 0 });

    await expect(touchShopLastSeen("gone")).resolves.toBeUndefined();
  });
});

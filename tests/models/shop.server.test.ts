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
    count: vi.fn(),
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
  merchantFeedback: {
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

import { NUDGE_FUNNEL_EVENT_TYPES, OPS_EVENT_TYPES } from "../../app/models/ops-event.server";
import {
  getOrCreateShopMetadata,
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
  claimShopStamp,
  claimPromptSlot,
  recordUpgradeReturnDismissal,
  startUpgradeReturnEpisode,
} from "../../app/models/shop.server";
import {
  NUDGE_KEYS,
  recordNudgeClicked,
  recordNudgeConverted,
  recordNudgeDismissed,
  recordNudgeNotShown,
  recordNudgeShown,
} from "../../app/services/nudge-telemetry.server";

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
        // gc-97k.4: lets the scan page skip the `shown` claim once it is stamped.
        upgradePreviewShownAt: true,
        // gc-97k.3: the home loader's feedback-nudge gate and shown pre-check.
        feedbackNudgeShownAt: true,
        feedbackNudgeDismissedAt: true,
        feedbackSubmittedAt: true,
        // gc-dpm.1: loaders skip the milestone claim once it is stamped.
        firstOpenedAt: true,
        firstResultsViewedAt: true,
        lastPromptKey: true,
        lastPromptShownAt: true,
        // gc-97k.7: the scan page's once-ever review popup gate.
        reviewPopupRequestedAt: true,
        // gc-97k.9: the return-visit banner's episode + dismissal gates and
        // its shown pre-check.
        upgradeReturnLastShownAt: true,
        upgradeReturnLastDismissedAt: true,
        upgradeReturnDismissCount: true,
        upgradeReturnShownAt: true,
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
// getOrCreateShopMetadata (gc-bj4)
// ---------------------------------------------------------------------------

describe("getOrCreateShopMetadata", () => {
  const DOMAIN = "race-shop.myshopify.com";
  const ROW = { id: "shop-race", domain: DOMAIN, plan: "free", uninstalledAt: null };

  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks keeps implementations; reset the two this block drives.
    mockDb.shop.findUnique.mockReset();
    mockDb.shop.upsert.mockReset();
  });

  it("returns the existing row WITHOUT upserting (reinstall path stays on reactivateShop)", async () => {
    mockDb.shop.findUnique.mockResolvedValue(ROW);

    const result = await getOrCreateShopMetadata(DOMAIN);

    expect(result).toEqual(ROW);
    expect(mockDb.shop.upsert).not.toHaveBeenCalled();
    expect(mockDb.shop.findUnique).toHaveBeenCalledOnce();
  });

  it("creates the row when absent and returns the re-read metadata", async () => {
    mockDb.shop.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(ROW);
    mockDb.shop.upsert.mockResolvedValue(ROW);

    const result = await getOrCreateShopMetadata(DOMAIN);

    expect(result).toEqual(ROW);
    expect(mockDb.shop.upsert).toHaveBeenCalledWith({
      where: { domain: DOMAIN },
      create: { domain: DOMAIN },
      update: { uninstalledAt: null },
    });
    expect(mockDb.shop.findUnique).toHaveBeenCalledTimes(2);
  });

  it("swallows a unique-constraint race (P2002) and returns the row the other request created", async () => {
    mockDb.shop.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(ROW);
    mockDb.shop.upsert.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed on the fields: (`domain`)"), {
        code: "P2002",
      }),
    );

    await expect(getOrCreateShopMetadata(DOMAIN)).resolves.toEqual(ROW);
  });

  it("rethrows any non-unique-constraint upsert error", async () => {
    mockDb.shop.findUnique.mockResolvedValue(null);
    mockDb.shop.upsert.mockRejectedValue(new Error("connection refused"));

    await expect(getOrCreateShopMetadata(DOMAIN)).rejects.toThrow("connection refused");
  });

  it("two concurrent first loads (parent + child loader) both resolve to the same row", async () => {
    // Stateful fake: both reads miss, the first upsert creates the row, the
    // second upsert loses the race with P2002. Neither caller may throw.
    let created: typeof ROW | null = null;
    let upserts = 0;
    mockDb.shop.findUnique.mockImplementation(async () => created);
    mockDb.shop.upsert.mockImplementation(async () => {
      upserts += 1;
      // Yield so both callers finish their initial (missing) read first.
      await Promise.resolve();
      if (created) {
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      }
      created = ROW;
      return ROW;
    });

    const [parent, child] = await Promise.all([
      getOrCreateShopMetadata(DOMAIN),
      getOrCreateShopMetadata(DOMAIN),
    ]);

    expect(upserts).toBe(2);
    expect(parent).toEqual(ROW);
    expect(child).toEqual(ROW);
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

  it("purges nudge-funnel rows for the redacted domain and leaves other shops' rows (gc-97k.1)", async () => {
    // Bind the REAL emitter write shape to the redact predicate: record every
    // nudge stage for two shops through the actual emitters, capture the rows
    // they write, then evaluate deleteShopData's OR clause against them the way
    // Postgres would (key equality + metadata JSON-path equality).
    const target = "delete-me.myshopify.com";
    const other = "keep-me.myshopify.com";
    for (const domain of [target, other]) {
      for (const key of Object.values(NUDGE_KEYS)) {
        await recordNudgeShown(key, domain);
        await recordNudgeClicked(key, domain);
        await recordNudgeDismissed(key, domain);
        await recordNudgeConverted(key, domain);
        await recordNudgeNotShown(key, domain, "cooldown-period");
      }
    }
    const written = mockDb.opsEvent.create.mock.calls.map(
      (c) => c[0].data as { eventType: string; key: string; metadata: Record<string, unknown> },
    );
    const perShop = Object.values(NUDGE_KEYS).length * NUDGE_FUNNEL_EVENT_TYPES.length;
    expect(written).toHaveLength(2 * perShop);

    const existingShop = { id: "shop-gdpr-nudge", domain: target, plan: "free" };
    mockDb.shop.findUnique.mockResolvedValue(existingShop);
    mockDb.session.deleteMany.mockResolvedValue({ count: 0 });
    mockDb.opsEvent.deleteMany.mockResolvedValue({ count: 8 });
    mockDb.shop.delete.mockResolvedValue(existingShop);

    await deleteShopData(target);

    type Clause = { key?: string; metadata?: { path: string[]; equals: string } };
    const opsWhere = mockDb.opsEvent.deleteMany.mock.calls[0][0].where as { OR: Clause[] };
    const matchesRedact = (row: (typeof written)[number]) =>
      opsWhere.OR.some((c) =>
        c.key !== undefined
          ? row.key === c.key
          : c.metadata !== undefined && row.metadata?.[c.metadata.path[0]] === c.metadata.equals,
      );

    const purged = written.filter(matchesRedact);
    expect(purged).toHaveLength(perShop);
    expect(purged.every((r) => r.key === target)).toBe(true);
    expect(new Set(purged.map((r) => r.eventType))).toEqual(new Set(NUDGE_FUNNEL_EVENT_TYPES));
    expect(written.filter((r) => r.key === other).some(matchesRedact)).toBe(false);
  });

  it("deletes the shop's MerchantFeedback rows by shopId inside the same transaction (gc-97k.3)", async () => {
    const existingShop = { id: "shop-gdpr-fb", domain: "delete-me.myshopify.com", plan: "free" };
    mockDb.shop.findUnique.mockResolvedValue(existingShop);
    mockDb.session.deleteMany.mockResolvedValue({ count: 0 });
    mockDb.opsEvent.deleteMany.mockResolvedValue({ count: 0 });
    mockDb.merchantFeedback.deleteMany.mockResolvedValue({ count: 2 });
    mockDb.shop.delete.mockResolvedValue(existingShop);

    await deleteShopData("delete-me.myshopify.com");

    expect(mockDb.merchantFeedback.deleteMany).toHaveBeenCalledTimes(1);
    expect(mockDb.merchantFeedback.deleteMany).toHaveBeenCalledWith({
      where: { shopId: "shop-gdpr-fb" },
    });
    // Staged in the one atomic transaction, before the shop delete.
    const staged = mockDb.$transaction.mock.calls[0][0] as unknown[];
    expect(staged).toHaveLength(4);
    const feedbackDeleteOrder = mockDb.merchantFeedback.deleteMany.mock.invocationCallOrder[0];
    const shopDeleteOrder = mockDb.shop.delete.mock.invocationCallOrder[0];
    expect(feedbackDeleteOrder).toBeLessThan(shopDeleteOrder);
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

  it("deletes sessions and stamps uninstalledAt in a single transaction (guarded on uninstalledAt: null)", async () => {
    mockDb.session.deleteMany.mockResolvedValue({ count: 2 });
    mockDb.shop.updateMany.mockResolvedValue({ count: 1 });

    await markShopUninstalled("bye.myshopify.com");

    expect(mockDb.$transaction).toHaveBeenCalledOnce();
    expect(mockDb.session.deleteMany).toHaveBeenCalledWith({
      where: { shop: "bye.myshopify.com" },
    });
    const updateArg = mockDb.shop.updateMany.mock.calls[0][0];
    // The where-clause requires uninstalledAt: null so a re-mark is a true no-op
    // (no re-stamp) rather than stamping a fresh timestamp on an already-uninstalled shop.
    expect(updateArg.where).toEqual({ domain: "bye.myshopify.com", uninstalledAt: null });
    expect(updateArg.data.uninstalledAt).toBeInstanceOf(Date);
  });

  it("does NOT hard-delete the shop (keeps data for the shop/redact grace window)", async () => {
    mockDb.session.deleteMany.mockResolvedValue({ count: 1 });
    mockDb.shop.updateMany.mockResolvedValue({ count: 1 });

    await markShopUninstalled("bye.myshopify.com");

    expect(mockDb.shop.delete).not.toHaveBeenCalled();
  });

  it("returns newlyMarked+found true when a shop row was newly marked (no extra count query)", async () => {
    mockDb.session.deleteMany.mockResolvedValue({ count: 0 });
    mockDb.shop.updateMany.mockResolvedValue({ count: 1 });

    const result = await markShopUninstalled("bye.myshopify.com");

    expect(result).toEqual({ newlyMarked: true, found: true });
    // The newly-marked path is trivially found — no existence check needed.
    expect(mockDb.shop.count).not.toHaveBeenCalled();
  });

  it("is a no-op (no re-stamp) for an ALREADY-uninstalled shop: newlyMarked false, found true", async () => {
    // updateMany matches 0 rows (uninstalledAt already set) but the row still exists.
    mockDb.session.deleteMany.mockResolvedValue({ count: 0 });
    mockDb.shop.updateMany.mockResolvedValue({ count: 0 });
    mockDb.shop.count.mockResolvedValue(1);

    const result = await markShopUninstalled("already-uninstalled.myshopify.com");

    // Not a new mark, but the row exists — the caller must NOT warn "not found".
    expect(result).toEqual({ newlyMarked: false, found: true });
    // Existence check runs ONLY on the no-op path, exactly once.
    expect(mockDb.shop.count).toHaveBeenCalledOnce();
    expect(mockDb.shop.count).toHaveBeenCalledWith({
      where: { domain: "already-uninstalled.myshopify.com" },
    });
  });

  it("returns newlyMarked+found false (idempotent) when the shop row is absent", async () => {
    mockDb.session.deleteMany.mockResolvedValue({ count: 0 });
    mockDb.shop.updateMany.mockResolvedValue({ count: 0 });
    mockDb.shop.count.mockResolvedValue(0);

    const result = await markShopUninstalled("already-gone.myshopify.com");

    expect(result).toEqual({ newlyMarked: false, found: false });
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

  it("marks FIRST then records a SHOP_UNINSTALLED OpsEvent (keyed on domain, with source metadata) on a NEW mark", async () => {
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
    // Delegates the mark to markShopUninstalled → returns its full result.
    expect(mockDb.shop.updateMany).toHaveBeenCalledOnce();
    expect(result).toEqual({ newlyMarked: true, found: true });
  });

  it("carries source=webhook for the webhook caller on a new mark", async () => {
    const result = await markShopUninstalledWithEvent("bye.myshopify.com", {
      source: "webhook",
      message: "app/uninstalled",
    });

    expect(mockDb.opsEvent.create.mock.calls[0][0].data.metadata).toEqual({ source: "webhook" });
    expect(result).toEqual({ newlyMarked: true, found: true });
  });

  it("records NO event and does NOT re-stamp for an ALREADY-uninstalled shop (redelivery/retry no-op)", async () => {
    // updateMany matches 0 rows (uninstalledAt already set); the row still exists.
    mockDb.shop.updateMany.mockResolvedValue({ count: 0 });
    mockDb.shop.count.mockResolvedValue(1);

    const result = await markShopUninstalledWithEvent("already.myshopify.com", {
      source: "webhook",
      message: "app/uninstalled",
    });

    // The core fix: no duplicate SHOP_UNINSTALLED event on a redelivery/retry, so
    // the operator digest cannot double-count uninstalls.
    expect(mockDb.opsEvent.create).not.toHaveBeenCalled();
    expect(result).toEqual({ newlyMarked: false, found: true });
  });

  it("records NO event when the row is absent and reports found:false", async () => {
    mockDb.shop.updateMany.mockResolvedValue({ count: 0 });
    mockDb.shop.count.mockResolvedValue(0);

    const result = await markShopUninstalledWithEvent("gone.myshopify.com", {
      source: "webhook",
      message: "app/uninstalled",
    });

    expect(mockDb.opsEvent.create).not.toHaveBeenCalled();
    expect(result).toEqual({ newlyMarked: false, found: false });
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

// ---------------------------------------------------------------------------
// claimShopStamp (shared once-per-merchant stamp claim: nudges gc-97k.4 / gc-97k.3,
// journey milestones gc-dpm.1)
// ---------------------------------------------------------------------------

describe("claimShopStamp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stamps only the given column, only while it is null, keyed on the domain", async () => {
    mockDb.shop.updateMany.mockResolvedValue({ count: 1 });

    await expect(claimShopStamp("s.myshopify.com", "feedbackNudgeShownAt")).resolves.toBe(true);

    const call = mockDb.shop.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ domain: "s.myshopify.com", feedbackNudgeShownAt: null });
    expect(Object.keys(call.data)).toEqual(["feedbackNudgeShownAt"]);
    expect(call.data.feedbackNudgeShownAt).toBeInstanceOf(Date);
  });

  it("returns false when the column is already stamped or the shop is missing (count 0)", async () => {
    mockDb.shop.updateMany.mockResolvedValue({ count: 0 });

    await expect(claimShopStamp("s.myshopify.com", "feedbackSubmittedAt")).resolves.toBe(false);
  });

  it("adds extraWhere preconditions without letting them override domain or the null guard", async () => {
    mockDb.shop.updateMany.mockResolvedValue({ count: 1 });

    await claimShopStamp("s.myshopify.com", "upgradePreviewConvertedAt", {
      upgradePreviewClickedAt: { not: null },
      domain: "other.myshopify.com",
      upgradePreviewConvertedAt: { not: null },
    });

    expect(mockDb.shop.updateMany.mock.calls[0][0].where).toEqual({
      domain: "s.myshopify.com",
      upgradePreviewConvertedAt: null,
      upgradePreviewClickedAt: { not: null },
    });
  });

  it.each(["firstOpenedAt", "firstResultsViewedAt"] as const)(
    "claims the %s journey milestone with the same once-only null guard (gc-dpm.1)",
    async (column) => {
      mockDb.shop.updateMany.mockResolvedValue({ count: 1 });

      await expect(claimShopStamp("s.myshopify.com", column)).resolves.toBe(true);

      const call = mockDb.shop.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ domain: "s.myshopify.com", [column]: null });
      expect(Object.keys(call.data)).toEqual([column]);
      expect(call.data[column]).toBeInstanceOf(Date);
    },
  );
});

// ---------------------------------------------------------------------------
// claimPromptSlot (cross-prompt frequency cap, gc-97k.6)
// ---------------------------------------------------------------------------

describe("claimPromptSlot", () => {
  const NOW = new Date("2026-09-26T12:00:00Z");

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes the new key and now, keyed on the domain AND the previous state (compare-and-set)", async () => {
    mockDb.shop.updateMany.mockResolvedValue({ count: 1 });
    const prevAt = new Date("2026-09-24T09:00:00Z");

    await expect(
      claimPromptSlot(
        "s.myshopify.com",
        "review_banner",
        { lastPromptKey: "feedback", lastPromptShownAt: prevAt },
        NOW,
      ),
    ).resolves.toBe(true);

    expect(mockDb.shop.updateMany).toHaveBeenCalledWith({
      where: { domain: "s.myshopify.com", lastPromptKey: "feedback", lastPromptShownAt: prevAt },
      data: { lastPromptKey: "review_banner", lastPromptShownAt: NOW },
    });
  });

  it("matches a never-prompted shop on explicit nulls", async () => {
    mockDb.shop.updateMany.mockResolvedValue({ count: 1 });

    await claimPromptSlot(
      "s.myshopify.com",
      "feedback",
      { lastPromptKey: null, lastPromptShownAt: null },
      NOW,
    );

    expect(mockDb.shop.updateMany.mock.calls[0][0].where).toEqual({
      domain: "s.myshopify.com",
      lastPromptKey: null,
      lastPromptShownAt: null,
    });
  });

  it("returns false when the state changed underneath or the shop is missing (count 0)", async () => {
    mockDb.shop.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      claimPromptSlot(
        "s.myshopify.com",
        "feedback",
        { lastPromptKey: null, lastPromptShownAt: null },
        NOW,
      ),
    ).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Return-visit upgrade nudge episode writes (gc-97k.9)
// ---------------------------------------------------------------------------

describe("startUpgradeReturnEpisode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is a plain update of upgradeReturnLastShownAt keyed on the domain", async () => {
    const now = new Date("2026-09-26T12:00:00Z");
    mockDb.shop.updateMany.mockResolvedValue({ count: 1 });

    await startUpgradeReturnEpisode("s.myshopify.com", now);

    expect(mockDb.shop.updateMany).toHaveBeenCalledWith({
      where: { domain: "s.myshopify.com" },
      data: { upgradeReturnLastShownAt: now },
    });
  });

  it("is a safe no-op for a missing shop row", async () => {
    mockDb.shop.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      startUpgradeReturnEpisode("gone.myshopify.com", new Date()),
    ).resolves.toBeUndefined();
  });
});

describe("recordUpgradeReturnDismissal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("increments the count atomically in SQL and stamps the dismissal in one statement", async () => {
    const now = new Date("2026-09-26T12:00:00Z");
    mockDb.shop.updateMany.mockResolvedValue({ count: 1 });

    await recordUpgradeReturnDismissal("s.myshopify.com", now);

    expect(mockDb.shop.updateMany).toHaveBeenCalledTimes(1);
    expect(mockDb.shop.updateMany).toHaveBeenCalledWith({
      where: { domain: "s.myshopify.com" },
      data: { upgradeReturnDismissCount: { increment: 1 }, upgradeReturnLastDismissedAt: now },
    });
  });

  it("propagates a DB error (the service logs it)", async () => {
    mockDb.shop.updateMany.mockRejectedValue(new Error("db down"));

    await expect(recordUpgradeReturnDismissal("s.myshopify.com", new Date())).rejects.toThrow(
      "db down",
    );
  });
});

/**
 * Tests for app/routes/app.tsx loader — focused on the on-load plan
 * reconciliation hook (CMP-2 / GC-fur).
 *
 * Strategy:
 *   - Mock authenticate.admin() to control session + admin context.
 *   - Mock the shop model and the billing reconciler so we can assert when
 *     reconciliation runs, is skipped (freshness guard), and that a thrown
 *     reconcile never breaks the loader.
 */

import type { LoaderFunctionArgs } from "react-router";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (hoisted)
// ---------------------------------------------------------------------------

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: vi.fn(),
  },
}));

vi.mock("../../app/models/shop.server", () => ({
  getShopMetadata: vi.fn(),
  upsertShop: vi.fn(),
}));

vi.mock("../../app/services/billing-reconciler.server", () => ({
  isPlanReconcileStale: vi.fn(),
  reconcileShopPlan: vi.fn(),
}));

vi.mock("../../app/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { logger } from "../../app/lib/logger.server";
import { getShopMetadata, upsertShop } from "../../app/models/shop.server";
import { loader } from "../../app/routes/app";
import {
  isPlanReconcileStale,
  reconcileShopPlan,
} from "../../app/services/billing-reconciler.server";
import { authenticate } from "../../app/shopify.server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockAdminAuth = authenticate.admin as ReturnType<typeof vi.fn>;
const mockGetShop = getShopMetadata as ReturnType<typeof vi.fn>;
const mockUpsert = upsertShop as ReturnType<typeof vi.fn>;
const mockIsStale = isPlanReconcileStale as ReturnType<typeof vi.fn>;
const mockReconcile = reconcileShopPlan as ReturnType<typeof vi.fn>;

const fakeAdmin = { graphql: vi.fn() };

function makeShop(overrides: Record<string, unknown> = {}) {
  return {
    id: "shop-1",
    domain: "test-shop.myshopify.com",
    plan: "free",
    planReconciledAt: null,
    installedAt: new Date("2026-01-01T00:00:00Z"),
    lastThemePublishAt: null,
    hasSeenReviewPrompt: false,
    ...overrides,
  };
}

function runLoader() {
  return loader({
    request: new Request("https://example.com/app"),
    params: {},
    context: {},
  } as unknown as LoaderFunctionArgs);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("app.tsx loader — plan reconciliation hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SHOPIFY_API_KEY = "test-api-key";
    mockAdminAuth.mockResolvedValue({
      session: { shop: "test-shop.myshopify.com" },
      admin: fakeAdmin,
    });
    mockReconcile.mockResolvedValue({ status: "matched", plan: "free" });
  });

  it("runs reconciliation when the stored plan is stale", async () => {
    mockGetShop.mockResolvedValue(makeShop({ plan: "Standard", planReconciledAt: null }));
    mockIsStale.mockReturnValue(true);

    const result = await runLoader();

    expect(mockReconcile).toHaveBeenCalledWith(fakeAdmin, {
      domain: "test-shop.myshopify.com",
      plan: "Standard",
    });
    expect(result).toEqual({ apiKey: "test-api-key" });
  });

  it("skips reconciliation when the stored plan is fresh", async () => {
    mockGetShop.mockResolvedValue(
      makeShop({ plan: "Standard", planReconciledAt: new Date("2026-06-17T11:30:00Z") }),
    );
    mockIsStale.mockReturnValue(false);

    await runLoader();

    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it("creates the shop on first visit then reconciles the freshly created record", async () => {
    // First lookup misses, upsert creates, second lookup returns the record.
    mockGetShop.mockResolvedValueOnce(null).mockResolvedValueOnce(makeShop());
    mockUpsert.mockResolvedValue(makeShop());
    mockIsStale.mockReturnValue(true);

    await runLoader();

    expect(mockUpsert).toHaveBeenCalledWith("test-shop.myshopify.com");
    expect(mockReconcile).toHaveBeenCalledOnce();
  });

  it("does not break the loader when reconciliation throws", async () => {
    mockGetShop.mockResolvedValue(makeShop());
    mockIsStale.mockReturnValue(true);
    mockReconcile.mockRejectedValue(new Error("boom"));

    const result = await runLoader();

    expect(result).toEqual({ apiKey: "test-api-key" });
    expect(logger.error).toHaveBeenCalledWith(
      "billing-reconcile-loader-failed",
      expect.objectContaining({ shop: "test-shop.myshopify.com", error: "boom" }),
    );
  });
});

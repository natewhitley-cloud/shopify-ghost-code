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
  getOrCreateShopMetadata: vi.fn(),
  reactivateShop: vi.fn(),
  isLastSeenStale: vi.fn(),
  touchShopLastSeen: vi.fn(),
}));

vi.mock("../../app/models/ops-event.server", () => ({
  recordPageVisit: vi.fn(),
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
import { recordPageVisit } from "../../app/models/ops-event.server";
import {
  getOrCreateShopMetadata,
  isLastSeenStale,
  reactivateShop,
  touchShopLastSeen,
} from "../../app/models/shop.server";
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
// The loader reads the shop through get-or-create (gc-bj4); the create-when-
// absent and P2002-race behavior is covered in tests/models/shop.server.test.ts.
const mockGetShop = getOrCreateShopMetadata as ReturnType<typeof vi.fn>;
const mockReactivate = reactivateShop as ReturnType<typeof vi.fn>;
const mockIsStale = isPlanReconcileStale as ReturnType<typeof vi.fn>;
const mockReconcile = reconcileShopPlan as ReturnType<typeof vi.fn>;
const mockIsLastSeenStale = isLastSeenStale as ReturnType<typeof vi.fn>;
const mockTouchLastSeen = touchShopLastSeen as ReturnType<typeof vi.fn>;
const mockRecordPageVisit = recordPageVisit as ReturnType<typeof vi.fn>;

const fakeAdmin = { graphql: vi.fn() };

function makeShop(overrides: Record<string, unknown> = {}) {
  return {
    id: "shop-1",
    domain: "test-shop.myshopify.com",
    plan: "free",
    planReconciledAt: null,
    installedAt: new Date("2026-01-01T00:00:00Z"),
    uninstalledAt: null,
    lastSeenAt: null,
    lastThemePublishAt: null,
    hasSeenReviewPrompt: false,
    ...overrides,
  };
}

function runLoader(url = "https://example.com/app") {
  return loader({
    request: new Request(url),
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
    // Telemetry defaults: quiet unless a test opts in.
    mockIsLastSeenStale.mockReturnValue(false);
    mockTouchLastSeen.mockResolvedValue(undefined);
    mockRecordPageVisit.mockResolvedValue(undefined);
  });

  it("runs reconciliation when the stored plan is stale (no plan_handle → recordEvent false)", async () => {
    mockGetShop.mockResolvedValue(makeShop({ plan: "Standard", planReconciledAt: null }));
    mockIsStale.mockReturnValue(true);

    const result = await runLoader();

    expect(mockReconcile).toHaveBeenCalledWith(
      fakeAdmin,
      { domain: "test-shop.myshopify.com", plan: "Standard" },
      { recordEvent: false },
    );
    expect(result).toEqual({ apiKey: "test-api-key" });
  });

  it("skips reconciliation when the stored plan is fresh and there is no plan_handle", async () => {
    mockGetShop.mockResolvedValue(
      makeShop({ plan: "Standard", planReconciledAt: new Date("2026-06-17T11:30:00Z") }),
    );
    mockIsStale.mockReturnValue(false);

    await runLoader();

    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it("forces reconciliation when plan_handle is present even if the plan is fresh (redirect fast-path)", async () => {
    mockGetShop.mockResolvedValue(
      makeShop({ plan: "free", planReconciledAt: new Date("2026-06-17T11:30:00Z") }),
    );
    mockIsStale.mockReturnValue(false);

    await runLoader("https://example.com/app?plan_handle=standard&shop=test-shop.myshopify.com");

    // Fresh plan would normally skip; plan_handle presence forces the reconcile.
    expect(mockIsStale).not.toHaveBeenCalled();
    expect(mockReconcile).toHaveBeenCalledWith(
      fakeAdmin,
      { domain: "test-shop.myshopify.com", plan: "free" },
      { recordEvent: true },
    );
  });

  it("get-or-creates the shop on first visit then reconciles the freshly created record", async () => {
    // get-or-create returns the freshly created row (uninstalledAt null).
    mockGetShop.mockResolvedValue(makeShop());
    mockIsStale.mockReturnValue(true);

    await runLoader();

    expect(mockGetShop).toHaveBeenCalledWith("test-shop.myshopify.com");
    expect(mockReconcile).toHaveBeenCalledOnce();
    expect(mockReactivate).not.toHaveBeenCalled();
  });

  it("reactivates an existing shop that is still flagged uninstalled (reinstall)", async () => {
    mockGetShop.mockResolvedValue(makeShop({ uninstalledAt: new Date("2026-06-01T00:00:00Z") }));
    mockIsStale.mockReturnValue(false);

    await runLoader();

    expect(mockReactivate).toHaveBeenCalledWith("test-shop.myshopify.com");
  });

  it("does NOT reactivate an existing active shop (uninstalledAt null)", async () => {
    mockGetShop.mockResolvedValue(makeShop({ uninstalledAt: null }));
    mockIsStale.mockReturnValue(false);

    await runLoader();

    expect(mockReactivate).not.toHaveBeenCalled();
  });

  it("skips reconcile and telemetry stamps gracefully when the shop is still missing", async () => {
    mockGetShop.mockResolvedValue(null);
    mockIsStale.mockReturnValue(true);

    const result = await runLoader();

    expect(result).toEqual({ apiKey: "test-api-key" });
    expect(mockReconcile).not.toHaveBeenCalled();
    expect(mockReactivate).not.toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// Activity telemetry (last-seen + page_visit)
// ---------------------------------------------------------------------------

describe("app.tsx loader — activity telemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SHOPIFY_API_KEY = "test-api-key";
    mockAdminAuth.mockResolvedValue({
      session: { shop: "test-shop.myshopify.com" },
      admin: fakeAdmin,
    });
    mockReconcile.mockResolvedValue({ status: "matched", plan: "free" });
    mockGetShop.mockResolvedValue(makeShop());
    mockIsStale.mockReturnValue(false);
    mockIsLastSeenStale.mockReturnValue(false);
    mockTouchLastSeen.mockResolvedValue(undefined);
    mockRecordPageVisit.mockResolvedValue(undefined);
  });

  it("records a page_visit for the domain + concrete request path on a normal /app load", async () => {
    await runLoader("https://example.com/app/scans");

    // Dedupe (gc-0lo) lives inside recordPageVisit; see ops-event.server tests.
    expect(mockRecordPageVisit).toHaveBeenCalledWith("test-shop.myshopify.com", "/app/scans");
  });

  it("does NOT record activity for operator /app/admin pages", async () => {
    mockIsLastSeenStale.mockReturnValue(true);

    await runLoader("https://example.com/app/admin/metrics");

    expect(mockRecordPageVisit).not.toHaveBeenCalled();
    expect(mockTouchLastSeen).not.toHaveBeenCalled();
  });

  it("stamps lastSeenAt when it is stale", async () => {
    mockGetShop.mockResolvedValue(makeShop({ lastSeenAt: null }));
    mockIsLastSeenStale.mockReturnValue(true);

    await runLoader("https://example.com/app");

    expect(mockIsLastSeenStale).toHaveBeenCalledWith(null);
    expect(mockTouchLastSeen).toHaveBeenCalledWith("shop-1");
  });

  it("does NOT re-stamp lastSeenAt when it is fresh (within the window)", async () => {
    mockGetShop.mockResolvedValue(makeShop({ lastSeenAt: new Date("2026-06-17T11:59:00Z") }));
    mockIsLastSeenStale.mockReturnValue(false);

    await runLoader("https://example.com/app");

    expect(mockTouchLastSeen).not.toHaveBeenCalled();
    // A fresh last-seen still records the page_visit — the freshness guard only
    // throttles the durable stamp, not the per-navigation event.
    expect(mockRecordPageVisit).toHaveBeenCalledOnce();
  });

  it("does not break the loader when the lastSeenAt stamp throws", async () => {
    mockIsLastSeenStale.mockReturnValue(true);
    mockTouchLastSeen.mockRejectedValue(new Error("db down"));

    const result = await runLoader("https://example.com/app");

    expect(result).toEqual({ apiKey: "test-api-key" });
    expect(logger.error).toHaveBeenCalledWith(
      "last-seen-touch-failed",
      expect.objectContaining({ shop: "test-shop.myshopify.com", error: "db down" }),
    );
    // The page_visit is still recorded despite the stamp failure.
    expect(mockRecordPageVisit).toHaveBeenCalledOnce();
  });

  it("passes the concrete scan path so different scans are separate pages (gc-0lo)", async () => {
    await runLoader("https://example.com/app/scans/scan-abc?index");

    expect(mockRecordPageVisit).toHaveBeenCalledWith(
      "test-shop.myshopify.com",
      "/app/scans/scan-abc",
    );
  });

  it("never blocks the loader on the page_visit write (fire-and-forget, gc-0lo)", async () => {
    // A dedupe read + insert that never settles must not hold the response.
    mockRecordPageVisit.mockReturnValue(new Promise(() => {}));

    const result = await runLoader("https://example.com/app/scans/scan-abc");

    expect(result).toEqual({ apiKey: "test-api-key" });
    expect(mockRecordPageVisit).toHaveBeenCalledOnce();
  });
});

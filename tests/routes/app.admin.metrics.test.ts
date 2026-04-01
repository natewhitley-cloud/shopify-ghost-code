/**
 * Tests for app/routes/app.admin.metrics.tsx (admin metrics dashboard)
 *
 * Strategy:
 *   - Mock authenticate.admin() to control session.
 *   - Mock getShopMetadata and isAdminShop to control admin gate.
 *   - Mock metric-snapshot model functions.
 *   - Test loader: admin allowed, admin denied, missing shop, data shapes.
 *   - Test action: admin allowed refreshes snapshot, admin denied 403.
 */

import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: vi.fn(),
  },
}));

vi.mock("../../app/db.server", () => ({
  default: {},
}));

vi.mock("../../app/models/shop.server", () => ({
  getShopMetadata: vi.fn(),
}));

vi.mock("../../app/lib/admin-gate.server", () => ({
  isAdminShop: vi.fn(),
}));

vi.mock("../../app/models/metric-snapshot.server", () => ({
  getLatestSnapshot: vi.fn(),
  getSnapshotHistory: vi.fn(),
  computeCurrentMetrics: vi.fn(),
  createMetricSnapshot: vi.fn(),
}));

vi.mock("../../app/lib/logger.server", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../../app/lib/format", () => ({
  formatDate: vi.fn().mockReturnValue("Apr 1, 2026"),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { isAdminShop } from "../../app/lib/admin-gate.server";
import {
  getLatestSnapshot,
  getSnapshotHistory,
  computeCurrentMetrics,
  createMetricSnapshot,
} from "../../app/models/metric-snapshot.server";
import { getShopMetadata } from "../../app/models/shop.server";
import { loader, action } from "../../app/routes/app.admin.metrics";
import { authenticate } from "../../app/shopify.server";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockAuthenticateAdmin = authenticate.admin as ReturnType<typeof vi.fn>;
const mockGetShopMetadata = getShopMetadata as ReturnType<typeof vi.fn>;
const mockIsAdminShop = isAdminShop as ReturnType<typeof vi.fn>;
const mockGetLatestSnapshot = getLatestSnapshot as ReturnType<typeof vi.fn>;
const mockGetSnapshotHistory = getSnapshotHistory as ReturnType<typeof vi.fn>;
const mockComputeCurrentMetrics = computeCurrentMetrics as ReturnType<typeof vi.fn>;
const mockCreateMetricSnapshot = createMetricSnapshot as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_SHOP = {
  id: "shop-1",
  domain: "admin.myshopify.com",
  plan: "professional",
  installedAt: new Date(),
  lastThemePublishAt: null,
  hasSeenReviewPrompt: false,
};

const SAMPLE_SNAPSHOT = {
  id: "snap-1",
  snapshotDate: new Date("2026-04-01T00:00:00.000Z"),
  totalShops: 10,
  activeShops: 7,
  shopsByPlan: { free: 5, professional: 3, business: 2 },
  totalScans: 100,
  scansLast7d: 20,
  scansLast30d: 80,
  completionRate: 0.9,
  totalFindings: 500,
  avgFindingsPerScan: 5.0,
  createdAt: new Date(),
};

function makeRequest(method = "GET") {
  return new Request("https://app.alpenglowsoftware.com/app/admin/metrics", { method });
}

// ---------------------------------------------------------------------------
// Setup defaults
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  mockAuthenticateAdmin.mockResolvedValue({
    session: { shop: "admin.myshopify.com" },
  });
  mockGetShopMetadata.mockResolvedValue(SAMPLE_SHOP);
  mockIsAdminShop.mockReturnValue(true);
  mockGetLatestSnapshot.mockResolvedValue(SAMPLE_SNAPSHOT);
  mockGetSnapshotHistory.mockResolvedValue([SAMPLE_SNAPSHOT]);
});

// ---------------------------------------------------------------------------
// Loader tests
// ---------------------------------------------------------------------------

describe("loader — admin allowed", () => {
  it("returns shopDomain from session", async () => {
    const result = await loader({ request: makeRequest() } as LoaderFunctionArgs);

    expect(result.shopDomain).toBe("admin.myshopify.com");
  });

  it("returns latestSnapshot from getLatestSnapshot", async () => {
    const result = await loader({ request: makeRequest() } as LoaderFunctionArgs);

    expect(result.latestSnapshot).toEqual(SAMPLE_SNAPSHOT);
  });

  it("returns snapshotHistory from getSnapshotHistory", async () => {
    const history = [SAMPLE_SNAPSHOT, { ...SAMPLE_SNAPSHOT, id: "snap-2" }];
    mockGetSnapshotHistory.mockResolvedValue(history);

    const result = await loader({ request: makeRequest() } as LoaderFunctionArgs);

    expect(result.snapshotHistory).toEqual(history);
  });

  it("returns null latestSnapshot when no snapshots exist yet", async () => {
    mockGetLatestSnapshot.mockResolvedValue(null);

    const result = await loader({ request: makeRequest() } as LoaderFunctionArgs);

    expect(result.latestSnapshot).toBeNull();
  });

  it("returns empty snapshotHistory when none exist", async () => {
    mockGetSnapshotHistory.mockResolvedValue([]);

    const result = await loader({ request: makeRequest() } as LoaderFunctionArgs);

    expect(result.snapshotHistory).toEqual([]);
  });
});

describe("loader — admin denied", () => {
  it("throws 403 when isAdminShop returns false", async () => {
    mockIsAdminShop.mockReturnValue(false);

    await expect(loader({ request: makeRequest() } as LoaderFunctionArgs)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("throws 403 when shop is not found in DB", async () => {
    mockGetShopMetadata.mockResolvedValue(null);

    await expect(loader({ request: makeRequest() } as LoaderFunctionArgs)).rejects.toMatchObject({
      status: 403,
    });
  });
});

// ---------------------------------------------------------------------------
// Action tests
// ---------------------------------------------------------------------------

describe("action — admin allowed", () => {
  it("calls computeCurrentMetrics", async () => {
    const metrics = { ...SAMPLE_SNAPSHOT };
    mockComputeCurrentMetrics.mockResolvedValue(metrics);
    mockCreateMetricSnapshot.mockResolvedValue(SAMPLE_SNAPSHOT);

    await action({ request: makeRequest("POST") } as ActionFunctionArgs);

    expect(mockComputeCurrentMetrics).toHaveBeenCalledOnce();
  });

  it("calls createMetricSnapshot with the computed metrics", async () => {
    const metrics = { ...SAMPLE_SNAPSHOT };
    mockComputeCurrentMetrics.mockResolvedValue(metrics);
    mockCreateMetricSnapshot.mockResolvedValue(SAMPLE_SNAPSHOT);

    await action({ request: makeRequest("POST") } as ActionFunctionArgs);

    expect(mockCreateMetricSnapshot).toHaveBeenCalledWith(metrics);
  });

  it("returns { ok: true } on success", async () => {
    mockComputeCurrentMetrics.mockResolvedValue(SAMPLE_SNAPSHOT);
    mockCreateMetricSnapshot.mockResolvedValue(SAMPLE_SNAPSHOT);

    const result = await action({ request: makeRequest("POST") } as ActionFunctionArgs);

    expect(result).toEqual({ ok: true });
  });
});

describe("action — admin denied", () => {
  it("throws 403 when isAdminShop returns false", async () => {
    mockIsAdminShop.mockReturnValue(false);

    await expect(
      action({ request: makeRequest("POST") } as ActionFunctionArgs),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("does not compute metrics when denied", async () => {
    mockIsAdminShop.mockReturnValue(false);

    try {
      await action({ request: makeRequest("POST") } as ActionFunctionArgs);
    } catch {
      // Expected 403
    }

    expect(mockComputeCurrentMetrics).not.toHaveBeenCalled();
  });
});

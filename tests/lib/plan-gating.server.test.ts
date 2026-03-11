/**
 * Tests for app/lib/plan-gating.server.ts
 *
 * Strategy:
 *   - Pure getter functions (canViewFindingDetails, canUseMultipleThemes,
 *     canUseAutoRescan, canUseScanDiffing) need no mocks — they delegate
 *     to getPlanFeatures which is itself a pure switch.
 *   - canStartScan requires two mocks:
 *       1. db.server (Prisma) — for the active-scan guard (db.scan.findFirst)
 *       2. scan.server.countScansForShopSince — for the free-tier monthly count
 *
 * Note on vi.mock hoisting: vi.mock factory functions run before any top-level
 * variable initializations. Use vi.hoisted() for objects referenced inside a
 * vi.mock factory.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockDb = vi.hoisted(() => ({
  scan: {
    findFirst: vi.fn(),
  },
}));

const mockCountScansForShopSince = vi.hoisted(() => vi.fn());

vi.mock("../../app/db.server", () => ({
  default: mockDb,
}));

vi.mock("../../app/models/scan.server", () => ({
  countScansForShopSince: mockCountScansForShopSince,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  canStartScan,
  canViewFindingDetails,
  canUseMultipleThemes,
  canUseAutoRescan,
  canUseScanDiffing,
} from "../../app/lib/plan-gating.server";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const SHOP_ID = "shop-abc";

// ---------------------------------------------------------------------------
// canViewFindingDetails — pure, plan-tier tests
// ---------------------------------------------------------------------------

describe("canViewFindingDetails", () => {
  it("returns false for free plan", () => {
    expect(canViewFindingDetails("free")).toBe(false);
  });

  it("returns true for Standard plan", () => {
    expect(canViewFindingDetails("Standard")).toBe(true);
  });

  it("returns true for Professional plan", () => {
    expect(canViewFindingDetails("Professional")).toBe(true);
  });

  it("defaults to free-tier behavior for unknown plan names", () => {
    expect(canViewFindingDetails("unknown-plan")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// canUseMultipleThemes — pure, plan-tier tests
// ---------------------------------------------------------------------------

describe("canUseMultipleThemes", () => {
  it("returns false for free plan (maxThemes = 1)", () => {
    expect(canUseMultipleThemes("free")).toBe(false);
  });

  it("returns false for Standard plan (maxThemes = 1)", () => {
    expect(canUseMultipleThemes("Standard")).toBe(false);
  });

  it("returns true for Professional plan (maxThemes = Infinity)", () => {
    expect(canUseMultipleThemes("Professional")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// canUseAutoRescan — pure, plan-tier tests
// ---------------------------------------------------------------------------

describe("canUseAutoRescan", () => {
  it("returns false for free plan", () => {
    expect(canUseAutoRescan("free")).toBe(false);
  });

  it("returns false for Standard plan", () => {
    expect(canUseAutoRescan("Standard")).toBe(false);
  });

  it("returns true for Professional plan", () => {
    expect(canUseAutoRescan("Professional")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// canUseScanDiffing — pure, plan-tier tests
// ---------------------------------------------------------------------------

describe("canUseScanDiffing", () => {
  it("returns false for free plan", () => {
    expect(canUseScanDiffing("free")).toBe(false);
  });

  it("returns false for Standard plan", () => {
    expect(canUseScanDiffing("Standard")).toBe(false);
  });

  it("returns true for Professional plan", () => {
    expect(canUseScanDiffing("Professional")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// canStartScan — active scan guard (applies to all plans)
// ---------------------------------------------------------------------------

describe("canStartScan — active scan guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns allowed: false with reason when a PENDING scan already exists", async () => {
    mockDb.scan.findFirst.mockResolvedValue({ id: "active-scan", status: "PENDING" });

    const result = await canStartScan(SHOP_ID, "Professional");

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("already in progress");
    // Should not bother checking monthly counts since we short-circuit early.
    expect(mockCountScansForShopSince).not.toHaveBeenCalled();
  });

  it("returns allowed: false with reason when an IN_PROGRESS scan already exists", async () => {
    mockDb.scan.findFirst.mockResolvedValue({ id: "active-scan", status: "IN_PROGRESS" });

    const result = await canStartScan(SHOP_ID, "Standard");

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("already in progress");
  });

  it("queries for both PENDING and IN_PROGRESS statuses in the active-scan check", async () => {
    mockDb.scan.findFirst.mockResolvedValue(null);
    mockCountScansForShopSince.mockResolvedValue(0);

    await canStartScan(SHOP_ID, "Standard");

    const callArg = mockDb.scan.findFirst.mock.calls[0][0];
    expect(callArg.where.status.in).toContain("PENDING");
    expect(callArg.where.status.in).toContain("IN_PROGRESS");
  });
});

// ---------------------------------------------------------------------------
// canStartScan — Standard plan (unlimited scans)
// ---------------------------------------------------------------------------

describe("canStartScan — Standard plan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.scan.findFirst.mockResolvedValue(null); // no active scan
  });

  it("returns allowed: true without checking monthly count for Standard plan", async () => {
    const result = await canStartScan(SHOP_ID, "Standard");

    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
    // Standard has unlimited scans — no need to count monthly usage.
    expect(mockCountScansForShopSince).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// canStartScan — Professional plan (unlimited scans)
// ---------------------------------------------------------------------------

describe("canStartScan — Professional plan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.scan.findFirst.mockResolvedValue(null);
  });

  it("returns allowed: true without checking monthly count for Professional plan", async () => {
    const result = await canStartScan(SHOP_ID, "Professional");

    expect(result.allowed).toBe(true);
    expect(mockCountScansForShopSince).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// canStartScan — Free plan (1 scan per month)
// ---------------------------------------------------------------------------

describe("canStartScan — Free plan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.scan.findFirst.mockResolvedValue(null); // no active scan
  });

  it("returns allowed: true when the shop has used 0 scans this month", async () => {
    mockCountScansForShopSince.mockResolvedValue(0);

    const result = await canStartScan(SHOP_ID, "free");

    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("returns allowed: false when the shop has already used 1 scan this month (at limit)", async () => {
    mockCountScansForShopSince.mockResolvedValue(1);

    const result = await canStartScan(SHOP_ID, "free");

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Free plan limit");
    expect(result.reason).toContain("Upgrade");
  });

  it("returns allowed: false when the shop has used more than the monthly limit", async () => {
    mockCountScansForShopSince.mockResolvedValue(3);

    const result = await canStartScan(SHOP_ID, "free");

    expect(result.allowed).toBe(false);
  });

  it("passes the first day of the current month as the 'since' date", async () => {
    mockCountScansForShopSince.mockResolvedValue(0);

    const before = new Date();
    await canStartScan(SHOP_ID, "free");
    const after = new Date();

    const sinceArg: Date = mockCountScansForShopSince.mock.calls[0][1];
    expect(sinceArg.getDate()).toBe(1);
    expect(sinceArg.getMonth()).toBeGreaterThanOrEqual(before.getMonth());
    expect(sinceArg.getMonth()).toBeLessThanOrEqual(after.getMonth());
    expect(sinceArg.getFullYear()).toBeGreaterThanOrEqual(before.getFullYear());
  });

  it("passes the shop ID to countScansForShopSince", async () => {
    mockCountScansForShopSince.mockResolvedValue(0);

    await canStartScan(SHOP_ID, "free");

    expect(mockCountScansForShopSince).toHaveBeenCalledWith(
      SHOP_ID,
      expect.any(Date),
    );
  });

  it("propagates a database error from countScansForShopSince", async () => {
    mockCountScansForShopSince.mockRejectedValue(new Error("DB timeout"));

    await expect(canStartScan(SHOP_ID, "free")).rejects.toThrow("DB timeout");
  });
});

// ---------------------------------------------------------------------------
// canStartScan — unknown plan treated as free
// ---------------------------------------------------------------------------

describe("canStartScan — unknown plan defaults to free-tier limits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.scan.findFirst.mockResolvedValue(null);
  });

  it("applies free-tier monthly limit for unrecognised plan names", async () => {
    mockCountScansForShopSince.mockResolvedValue(1);

    const result = await canStartScan(SHOP_ID, "legacy-plan");

    // Unknown plan falls through to free tier in getPlanFeatures.
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Free plan limit");
  });

  it("allows the scan when usage is under the free-tier limit for unknown plan", async () => {
    mockCountScansForShopSince.mockResolvedValue(0);

    const result = await canStartScan(SHOP_ID, "legacy-plan");

    expect(result.allowed).toBe(true);
  });
});

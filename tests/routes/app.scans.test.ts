/**
 * Tests for app/routes/app.scans._index.tsx (scan history)
 *
 * Strategy:
 *   - Mock authenticate.admin() to control the session.
 *   - Mock getShopMetadata and getScansForShop to verify pagination logic.
 *   - Verify the loader returns scans and correct pagination cursors.
 */

import type { LoaderFunctionArgs } from "react-router";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (hoisted by Vitest)
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

vi.mock("../../app/models/scan.server", () => ({
  getScansForShop: vi.fn(),
  getDistinctThemesForShop: vi.fn(),
}));

vi.mock("../../app/lib/format", () => ({
  formatDate: vi.fn().mockReturnValue("2026-03-22"),
  statusTone: vi.fn().mockReturnValue("info"),
  statusLabel: vi.fn().mockReturnValue("Completed"),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { getScansForShop, getDistinctThemesForShop } from "../../app/models/scan.server";
import { getShopMetadata } from "../../app/models/shop.server";
import { loader } from "../../app/routes/app.scans._index";
import { authenticate } from "../../app/shopify.server";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockAuthenticateAdmin = authenticate.admin as ReturnType<typeof vi.fn>;
const mockGetShopMetadata = getShopMetadata as ReturnType<typeof vi.fn>;
const mockGetScansForShop = getScansForShop as ReturnType<typeof vi.fn>;
const mockGetDistinctThemesForShop = getDistinctThemesForShop as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SHOP = {
  id: "shop-1",
  domain: "test-shop.myshopify.com",
  plan: "Free",
};

const PAGE_SIZE = 20;

function makeScan(id: string) {
  return {
    id,
    shopId: "shop-1",
    themeId: "gid://shopify/Theme/123",
    themeName: "Dawn",
    status: "COMPLETED",
    findingCount: 3,
    startedAt: new Date("2026-03-20T10:00:00Z"),
    completedAt: new Date("2026-03-20T10:05:00Z"),
    createdAt: new Date("2026-03-20T10:00:00Z"),
  };
}

function makeLoaderArgs(
  url = "https://test-shop.myshopify.com/app/scans",
  overrides?: Partial<LoaderFunctionArgs>,
): LoaderFunctionArgs {
  return {
    request: new Request(url),
    params: {},
    context: {},
    ...overrides,
  } as LoaderFunctionArgs;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();

  mockAuthenticateAdmin.mockResolvedValue({
    session: { shop: SHOP.domain },
  });

  mockGetShopMetadata.mockResolvedValue(SHOP);
  mockGetDistinctThemesForShop.mockResolvedValue(["Dawn"]);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("app.scans loader", () => {
  it("returns scans for the authenticated shop", async () => {
    const scans = [makeScan("scan-1"), makeScan("scan-2")];
    mockGetScansForShop.mockResolvedValue({ items: scans, hasNextPage: false });

    const result = (await loader(makeLoaderArgs())) as {
      scans: typeof scans;
      nextCursor: string | null;
    };

    expect(result.scans).toHaveLength(2);
    expect(result.nextCursor).toBeNull();
    expect(mockGetScansForShop).toHaveBeenCalledWith("shop-1", {
      limit: PAGE_SIZE,
      cursor: undefined,
      theme: undefined,
      status: undefined,
    });
  });

  it("handles empty scan list", async () => {
    mockGetScansForShop.mockResolvedValue({ items: [], hasNextPage: false });

    const result = (await loader(makeLoaderArgs())) as {
      scans: unknown[];
      nextCursor: string | null;
    };

    expect(result.scans).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
  });

  it("returns empty scans and null cursor when shop not found", async () => {
    mockGetShopMetadata.mockResolvedValue(null);

    const result = (await loader(makeLoaderArgs())) as {
      scans: unknown[];
      nextCursor: string | null;
    };

    expect(result.scans).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
    expect(mockGetScansForShop).not.toHaveBeenCalled();
  });

  describe("pagination", () => {
    it("returns hasMore=true via nextCursor when model signals next page", async () => {
      // The model now handles the over-fetch internally and returns { items, hasNextPage }.
      const scans = Array.from({ length: PAGE_SIZE }, (_, i) => makeScan(`scan-${i}`));
      mockGetScansForShop.mockResolvedValue({ items: scans, hasNextPage: true });

      const result = (await loader(makeLoaderArgs())) as {
        scans: unknown[];
        nextCursor: string | null;
      };

      expect(result.scans).toHaveLength(PAGE_SIZE);
      expect(result.nextCursor).toBe(`scan-${PAGE_SIZE - 1}`);
    });

    it("returns hasMore=false (null nextCursor) on last page", async () => {
      const scans = [makeScan("scan-1"), makeScan("scan-2")];
      mockGetScansForShop.mockResolvedValue({ items: scans, hasNextPage: false });

      const result = (await loader(makeLoaderArgs())) as {
        scans: unknown[];
        nextCursor: string | null;
      };

      expect(result.scans).toHaveLength(2);
      expect(result.nextCursor).toBeNull();
    });

    it("boundary: exactly PAGE_SIZE results with hasNextPage false means no more pages", async () => {
      const scans = Array.from({ length: PAGE_SIZE }, (_, i) => makeScan(`scan-${i}`));
      mockGetScansForShop.mockResolvedValue({ items: scans, hasNextPage: false });

      const result = (await loader(makeLoaderArgs())) as {
        scans: unknown[];
        nextCursor: string | null;
      };

      expect(result.scans).toHaveLength(PAGE_SIZE);
      expect(result.nextCursor).toBeNull();
    });

    it("passes cursor from URL search params to getScansForShop", async () => {
      mockGetScansForShop.mockResolvedValue({ items: [], hasNextPage: false });

      await loader(makeLoaderArgs("https://test-shop.myshopify.com/app/scans?cursor=scan-20"));

      expect(mockGetScansForShop).toHaveBeenCalledWith("shop-1", {
        limit: PAGE_SIZE,
        cursor: "scan-20",
        theme: undefined,
        status: undefined,
      });
    });
  });

  describe("filters", () => {
    it("passes the theme param through to getScansForShop", async () => {
      mockGetScansForShop.mockResolvedValue({ items: [], hasNextPage: false });

      const result = (await loader(
        makeLoaderArgs("https://test-shop.myshopify.com/app/scans?theme=Dawn"),
      )) as { theme: string; status: string };

      expect(mockGetScansForShop).toHaveBeenCalledWith(
        "shop-1",
        expect.objectContaining({ theme: "Dawn", status: undefined }),
      );
      expect(result.theme).toBe("Dawn");
    });

    it("passes a valid status param through to getScansForShop", async () => {
      mockGetScansForShop.mockResolvedValue({ items: [], hasNextPage: false });

      const result = (await loader(
        makeLoaderArgs("https://test-shop.myshopify.com/app/scans?status=COMPLETED"),
      )) as { status: string };

      expect(mockGetScansForShop).toHaveBeenCalledWith(
        "shop-1",
        expect.objectContaining({ status: "COMPLETED" }),
      );
      expect(result.status).toBe("COMPLETED");
    });

    it("ignores an unknown status param (treats it as no status filter)", async () => {
      mockGetScansForShop.mockResolvedValue({ items: [], hasNextPage: false });

      const result = (await loader(
        makeLoaderArgs("https://test-shop.myshopify.com/app/scans?status=BOGUS"),
      )) as { status: string };

      expect(mockGetScansForShop).toHaveBeenCalledWith(
        "shop-1",
        expect.objectContaining({ status: undefined }),
      );
      expect(result.status).toBe("");
    });

    it("passes both theme and status when both params are present", async () => {
      mockGetScansForShop.mockResolvedValue({ items: [], hasNextPage: false });

      await loader(
        makeLoaderArgs("https://test-shop.myshopify.com/app/scans?theme=Dawn&status=FAILED"),
      );

      expect(mockGetScansForShop).toHaveBeenCalledWith(
        "shop-1",
        expect.objectContaining({ theme: "Dawn", status: "FAILED" }),
      );
    });

    it("returns the distinct theme options for the dropdown", async () => {
      mockGetScansForShop.mockResolvedValue({ items: [], hasNextPage: false });
      mockGetDistinctThemesForShop.mockResolvedValue(["Craft", "Dawn"]);

      const result = (await loader(makeLoaderArgs())) as { themes: string[] };

      expect(mockGetDistinctThemesForShop).toHaveBeenCalledWith("shop-1");
      expect(result.themes).toEqual(["Craft", "Dawn"]);
    });

    it("returns empty theme options when the shop is not found", async () => {
      mockGetShopMetadata.mockResolvedValue(null);

      const result = (await loader(makeLoaderArgs())) as {
        themes: string[];
        theme: string;
        status: string;
      };

      expect(result.themes).toEqual([]);
      expect(result.theme).toBe("");
      expect(result.status).toBe("");
      expect(mockGetDistinctThemesForShop).not.toHaveBeenCalled();
    });
  });
});

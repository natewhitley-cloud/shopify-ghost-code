/**
 * Tests for app/routes/app.scans._index.tsx (scan history)
 *
 * Strategy:
 *   - Mock authenticate.admin() to control the session.
 *   - Mock getShopByDomain and getScansForShop to verify pagination logic.
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
  getShopByDomain: vi.fn(),
}));

vi.mock("../../app/models/scan.server", () => ({
  getScansForShop: vi.fn(),
}));

vi.mock("../../app/lib/format", () => ({
  formatDate: vi.fn().mockReturnValue("2026-03-22"),
  statusTone: vi.fn().mockReturnValue("info"),
  statusLabel: vi.fn().mockReturnValue("Completed"),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { getScansForShop } from "../../app/models/scan.server";
import { getShopByDomain } from "../../app/models/shop.server";
import { loader } from "../../app/routes/app.scans._index";
import { authenticate } from "../../app/shopify.server";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockAuthenticateAdmin = authenticate.admin as ReturnType<typeof vi.fn>;
const mockGetShopByDomain = getShopByDomain as ReturnType<typeof vi.fn>;
const mockGetScansForShop = getScansForShop as ReturnType<typeof vi.fn>;

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

  mockGetShopByDomain.mockResolvedValue(SHOP);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("app.scans loader", () => {
  it("returns scans for the authenticated shop", async () => {
    const scans = [makeScan("scan-1"), makeScan("scan-2")];
    mockGetScansForShop.mockResolvedValue(scans);

    const result = (await loader(makeLoaderArgs())) as {
      scans: typeof scans;
      nextCursor: string | null;
    };

    expect(result.scans).toHaveLength(2);
    expect(result.nextCursor).toBeNull();
    expect(mockGetScansForShop).toHaveBeenCalledWith("shop-1", {
      limit: PAGE_SIZE,
      cursor: undefined,
    });
  });

  it("handles empty scan list", async () => {
    mockGetScansForShop.mockResolvedValue([]);

    const result = (await loader(makeLoaderArgs())) as {
      scans: unknown[];
      nextCursor: string | null;
    };

    expect(result.scans).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
  });

  it("returns empty scans and null cursor when shop not found", async () => {
    mockGetShopByDomain.mockResolvedValue(null);

    const result = (await loader(makeLoaderArgs())) as {
      scans: unknown[];
      nextCursor: string | null;
    };

    expect(result.scans).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
    expect(mockGetScansForShop).not.toHaveBeenCalled();
  });

  describe("pagination", () => {
    it("returns hasMore=true via nextCursor when more results exist", async () => {
      // getScansForShop returns PAGE_SIZE + 1 rows to signal more pages
      const scans = Array.from({ length: PAGE_SIZE + 1 }, (_, i) => makeScan(`scan-${i}`));
      mockGetScansForShop.mockResolvedValue(scans);

      const result = (await loader(makeLoaderArgs())) as {
        scans: unknown[];
        nextCursor: string | null;
      };

      expect(result.scans).toHaveLength(PAGE_SIZE);
      expect(result.nextCursor).toBe(`scan-${PAGE_SIZE - 1}`);
    });

    it("returns hasMore=false (null nextCursor) on last page", async () => {
      const scans = [makeScan("scan-1"), makeScan("scan-2")];
      mockGetScansForShop.mockResolvedValue(scans);

      const result = (await loader(makeLoaderArgs())) as {
        scans: unknown[];
        nextCursor: string | null;
      };

      expect(result.scans).toHaveLength(2);
      expect(result.nextCursor).toBeNull();
    });

    it("boundary: exactly PAGE_SIZE results means no more pages", async () => {
      const scans = Array.from({ length: PAGE_SIZE }, (_, i) => makeScan(`scan-${i}`));
      mockGetScansForShop.mockResolvedValue(scans);

      const result = (await loader(makeLoaderArgs())) as {
        scans: unknown[];
        nextCursor: string | null;
      };

      // Exactly PAGE_SIZE rows means the server did NOT return the extra row,
      // so there are no more pages.
      expect(result.scans).toHaveLength(PAGE_SIZE);
      expect(result.nextCursor).toBeNull();
    });

    it("passes cursor from URL search params to getScansForShop", async () => {
      mockGetScansForShop.mockResolvedValue([]);

      await loader(makeLoaderArgs("https://test-shop.myshopify.com/app/scans?cursor=scan-20"));

      expect(mockGetScansForShop).toHaveBeenCalledWith("shop-1", {
        limit: PAGE_SIZE,
        cursor: "scan-20",
      });
    });
  });
});

/**
 * Tests for app/services/theme-health.server.ts (gc-i6du): what Home's theme
 * health checklist reads for the latest successful scan. The model is mocked;
 * nothing touches a database or the network.
 */
import { FindingType } from "@prisma/client";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../app/db.server", () => ({ default: {} }));
vi.mock("../../app/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../app/models/scan.server", () => ({
  getLatestScanFindingCountsByTheme: vi.fn(),
}));

import { logger } from "../../app/lib/logger.server";
import { getLatestScanFindingCountsByTheme } from "../../app/models/scan.server";
import { loadThemeHealth, type ThemeHealthScan } from "../../app/services/theme-health.server";

const mockCounts = getLatestScanFindingCountsByTheme as ReturnType<typeof vi.fn>;

const MAIN_ID = "gid://shopify/OnlineStoreTheme/1";
const ALL_TYPES = Object.values(FindingType);

const SCAN: ThemeHealthScan = {
  id: "scan-1",
  themeId: MAIN_ID,
  themeName: "Dawn - live",
  skippedCategories: [],
  cappedCategories: [],
  unreachableCategories: [],
  liveFindingTypes: ALL_TYPES,
  themeInfo: { name: "Dawn", version: "15.2.0", author: "Shopify", architecture: "os2" },
};

const THEMES = [
  { id: MAIN_ID, name: "Dawn - live", role: "MAIN", updatedAt: "2026-10-01T00:00:00Z" },
  { id: "t2", name: "Dawn - copy", role: "UNPUBLISHED", updatedAt: "2026-09-01T00:00:00Z" },
  { id: "t3", name: "Old Debut", role: "UNPUBLISHED", updatedAt: "2025-01-01T00:00:00Z" },
  { id: "t4", name: "CLI dev", role: "DEVELOPMENT", updatedAt: "2026-10-10T00:00:00Z" },
];

const NOW = new Date("2026-10-20T12:00:00Z");

function load(overrides: Partial<Parameters<typeof loadThemeHealth>[0]> = {}) {
  return loadThemeHealth({
    shop: { id: "shop-1", plan: "Professional" },
    scan: SCAN,
    typeCounts: {},
    mainThemeId: MAIN_ID,
    themes: THEMES,
    now: NOW,
    ...overrides,
  });
}

const rowOf = (rows: Awaited<ReturnType<typeof load>>, key: string) =>
  rows.find((r) => r.key === key);

beforeEach(() => {
  vi.resetAllMocks();
  mockCounts.mockResolvedValue(new Map());
});

describe("loadThemeHealth", () => {
  it("a clean, fully checked scan: every category Clean, the theme and the inventory", async () => {
    const rows = await load();
    expect(rows.map((r) => [r.key, r.statusLabel])).toEqual([
      ["malicious", "Clean"],
      ["shopper-visible", "Clean"],
      ["scripts-styles", "Clean"],
      ["snippets-sections", "Clean"],
      ["seo-ai", "Clean"],
      ["tracking", "Clean"],
      ["store-data", "Clean"],
      ["script-tag-deadline", "Clean"],
      ["theme", "Online Store 2.0"],
      ["unpublished-themes", "2 unpublished"],
    ]);
    expect(rowOf(rows, "theme")!.detail).toBe("Dawn 15.2.0 by Shopify");
  });

  it("looks up the last scans of the unpublished library themes only (not MAIN, not development)", async () => {
    mockCounts.mockResolvedValue(new Map([["t3", 14]]));
    const rows = await load();
    expect(mockCounts).toHaveBeenCalledTimes(1);
    expect(mockCounts).toHaveBeenCalledWith("shop-1", ["t2", "t3"]);
    expect(rowOf(rows, "unpublished-themes")!.detail).toBe(
      "Your store has 3 themes. Shopify allows 20 (more on Plus). In their last scans: Old Debut: 14 findings.",
    );
  });

  it("the theme list was not available: no inventory row, no lookup, the rest renders", async () => {
    const rows = await load({ themes: null });
    expect(mockCounts).not.toHaveBeenCalled();
    expect(rowOf(rows, "unpublished-themes")).toBeUndefined();
    expect(rowOf(rows, "theme")).toBeDefined();
  });

  it("a failed lookup never breaks Home: the row shows counts without leftovers, and it is logged", async () => {
    mockCounts.mockRejectedValue(new Error("db connection reset"));
    const rows = await load();
    expect(rowOf(rows, "unpublished-themes")).toMatchObject({
      statusLabel: "2 unpublished",
      detail: "Your store has 3 themes. Shopify allows 20 (more on Plus).",
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "theme health: unpublished theme scans unavailable",
      expect.objectContaining({ shopId: "shop-1", errorName: "Error" }),
    );
    // The message (which can echo values) is never logged.
    expect(JSON.stringify((logger.warn as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(
      "db connection reset",
    );
  });

  it("reads coverage from the scan row: storefront unreadable, a permission missing, a cap", async () => {
    const rows = await load({
      scan: {
        ...SCAN,
        unreachableCategories: ["SCRIPT_TAG_SUNSET", "LIQUID_ERROR_RENDERED"],
        skippedCategories: ["GHOST_TRANSLATION"],
      },
    });
    expect(rowOf(rows, "shopper-visible")).toMatchObject({ status: "partial" });
    expect(rowOf(rows, "store-data")).toMatchObject({
      status: "partial",
      detail:
        "Part of this needs a permission you haven't allowed yet. You can allow it in Settings.",
    });
  });

  it("the storefront flag is off (types absent from the live set): the deadline row is left out", async () => {
    const liveFindingTypes = ALL_TYPES.filter(
      (t) => t !== "SCRIPT_TAG_SUNSET" && t !== "LIQUID_ERROR_RENDERED" && t !== "APP_EMBED_OFF",
    );
    const rows = await load({ scan: { ...SCAN, liveFindingTypes } });
    expect(rowOf(rows, "script-tag-deadline")).toBeUndefined();
    expect(rowOf(rows, "shopper-visible")).toMatchObject({ status: "clean" });
  });

  it("a scan of an unpublished theme: storefront checks say so instead of Clean", async () => {
    const liveFindingTypes = ALL_TYPES.filter(
      (t) => t !== "SCRIPT_TAG_SUNSET" && t !== "LIQUID_ERROR_RENDERED",
    );
    const rows = await load({ scan: { ...SCAN, themeId: "t2", liveFindingTypes } });
    expect(rowOf(rows, "shopper-visible")).toMatchObject({
      status: "partial",
      detail: "This is only checked on your published theme.",
    });
  });

  it("the published theme is unknown: nothing is called 'unpublished'", async () => {
    const liveFindingTypes = ALL_TYPES.filter((t) => t !== "LIQUID_ERROR_RENDERED");
    const rows = await load({ mainThemeId: null, scan: { ...SCAN, liveFindingTypes } });
    expect(rowOf(rows, "shopper-visible")).toMatchObject({ status: "clean" });
  });

  it("a legacy scan (no live set, no theme info) still renders", async () => {
    const rows = await load({ scan: { ...SCAN, liveFindingTypes: null, themeInfo: null } });
    expect(rowOf(rows, "theme")).toMatchObject({ status: "not_checked" });
    expect(rowOf(rows, "malicious")).toMatchObject({ status: "clean" });
  });

  it("a vintage theme is flagged from the stored theme info", async () => {
    const rows = await load({
      scan: {
        ...SCAN,
        themeInfo: {
          name: "Debut",
          version: "17.14.0",
          author: "Shopify",
          architecture: "vintage",
        },
      },
    });
    expect(rowOf(rows, "theme")).toMatchObject({ status: "issues", statusLabel: "Vintage theme" });
  });

  it("the script tag deadline copy follows today's date", async () => {
    const before = await load({ typeCounts: { SCRIPT_TAG_SUNSET: 1 } });
    expect(rowOf(before, "script-tag-deadline")!.detail).toContain("Shopify stops running");
    const after = await load({
      typeCounts: { SCRIPT_TAG_SUNSET: 1 },
      now: new Date("2027-03-01T00:00:00Z"),
    });
    expect(rowOf(after, "script-tag-deadline")!.detail).toContain("Shopify stopped running");
  });

  describe("plan gating", () => {
    const COUNTS = { GHOST_SCRIPT: 3, GHOST_PIXEL: 2, LIQUID_ERROR_RENDERED: 1 };

    it("Free sees the same counts as a paid plan, linked to the scan page (not a filtered list)", async () => {
      const free = await load({ shop: { id: "shop-1", plan: "free" }, typeCounts: COUNTS });
      const pro = await load({ typeCounts: COUNTS });
      expect(free.map((r) => [r.key, r.count])).toEqual(pro.map((r) => [r.key, r.count]));
      expect(rowOf(free, "tracking")!.href).toBe("/app/scans/scan-1");
      expect(rowOf(pro, "tracking")!.href).toBe("/app/scans/scan-1?type=GHOST_PIXEL");
    });

    it("Free: the two plan-gated checks are named, never called Clean", async () => {
      const free = await load({ shop: { id: "shop-1", plan: "free" } });
      expect(rowOf(free, "shopper-visible")!.detail).toBe(
        "Broken links are checked on Standard and Professional.",
      );
      expect(rowOf(free, "snippets-sections")!.detail).toBe(
        "Old checkout code is checked on Standard and Professional.",
      );
      const standard = await load({ shop: { id: "shop-1", plan: "Standard" } });
      expect(rowOf(standard, "shopper-visible")).toMatchObject({ status: "clean" });
    });

    it.each(["free", "Standard", "Professional"])(
      "%s: rows hold counts and fixed copy only, nothing from a finding",
      async (plan) => {
        const rows = await load({ shop: { id: "shop-1", plan }, typeCounts: COUNTS });
        for (const row of rows) {
          expect(Object.keys(row).sort()).toEqual(
            ["checks", "count", "detail", "href", "key", "label", "status", "statusLabel"].sort(),
          );
        }
      },
    );
  });
});

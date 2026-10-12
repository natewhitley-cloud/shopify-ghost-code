/**
 * Home: theme health checklist (gc-i6du).
 *
 * Strategy: mock I/O (models, theme fetcher), run the REAL Home loader with the
 * REAL theme-health service and pure builder, then render the REAL Dashboard
 * with that loader data, so the assertions are on what each plan is sent and
 * what the merchant sees. No network, no database.
 */
import { FindingType } from "@prisma/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { LoaderFunctionArgs } from "react-router";
import { createRoutesStub } from "react-router";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: vi.fn() },
}));

vi.mock("../../app/db.server", () => ({ default: {} }));

vi.mock("../../app/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../app/models/shop.server", () => ({
  getShopMetadata: vi.fn(),
  getOrCreateShopMetadata: vi.fn(),
}));

vi.mock("../../app/models/scan.server", () => ({
  getScansForShop: vi.fn(),
  hasCompletedScans: vi.fn(),
  getCompletedScansForShop: vi.fn(),
  getFirstSuccessfulScanCompletedAt: vi.fn(),
  getLatestSuccessfulScanNonMaliciousCount: vi.fn(),
  // The checklist's one query: the unpublished themes' latest scans.
  getLatestScanFindingCountsByTheme: vi.fn(),
}));

vi.mock("../../app/services/nudge-stage.server", () => ({
  recordNudgeStageOnce: vi.fn(),
}));

vi.mock("../../app/services/journey-milestone.server", () => ({
  recordJourneyMilestoneOnce: vi.fn(),
  recordScanResultsViewOnce: vi.fn(),
}));

vi.mock("../../app/services/scan-dispatch.server", () => ({
  dispatchScan: vi.fn(),
}));

vi.mock("../../app/models/app-removal.server", () => ({
  getRemovalNoticeRows: vi.fn(async () => []),
}));

vi.mock("../../app/models/finding.server", () => ({
  getSeverityCountsForScans: vi.fn(),
  getTypeCountsForScan: vi.fn(),
}));

vi.mock("../../app/models/ignored-finding.server", () => ({
  getIgnoredFindingsForShop: vi.fn(),
}));

vi.mock("../../app/services/finding-aggregation.server", () => ({
  getFilteredFindingSummaryAndKept: vi.fn(),
}));

vi.mock("../../app/services/top-findings.server", () => ({
  getFullListTopFindings: vi.fn().mockResolvedValue([]),
  getFreeTopFindings: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../app/services/theme-fetcher.server", () => ({
  fetchMainTheme: vi.fn(),
  fetchAllThemes: vi.fn(),
}));

vi.mock("../../app/lib/plan-gating.server", () => ({
  canStartScan: vi.fn(),
  canUseMultipleThemes: vi.fn(),
  canUseScanDiffing: vi.fn(),
  getScanUsage: vi.fn(),
  getWeekStartUTC: vi.fn(),
}));

vi.mock("../../inngest/client", () => ({
  inngest: { send: vi.fn() },
}));

import { THEME_HEALTH_HEADING } from "../../app/components/ThemeHealthChecklist";
import { logger } from "../../app/lib/logger.server";
import {
  canUseMultipleThemes,
  canUseScanDiffing,
  getScanUsage,
} from "../../app/lib/plan-gating.server";
import type { HealthRow } from "../../app/lib/theme-health";
import { getSeverityCountsForScans, getTypeCountsForScan } from "../../app/models/finding.server";
import { getIgnoredFindingsForShop } from "../../app/models/ignored-finding.server";
import {
  getCompletedScansForShop,
  getLatestScanFindingCountsByTheme,
  getScansForShop,
  hasCompletedScans,
} from "../../app/models/scan.server";
import { getOrCreateShopMetadata } from "../../app/models/shop.server";
import Dashboard, { loader } from "../../app/routes/app._index";
import { resetThemeCaches } from "../../app/services/theme-cache.server";
import { fetchAllThemes, fetchMainTheme } from "../../app/services/theme-fetcher.server";
import { getFreeTopFindings, getFullListTopFindings } from "../../app/services/top-findings.server";
import { authenticate } from "../../app/shopify.server";

const mockAuth = authenticate.admin as ReturnType<typeof vi.fn>;
const mockGetOrCreate = getOrCreateShopMetadata as ReturnType<typeof vi.fn>;
const mockScans = getScansForShop as ReturnType<typeof vi.fn>;
const mockTypeCounts = getTypeCountsForScan as ReturnType<typeof vi.fn>;
const mockFetchAllThemes = fetchAllThemes as ReturnType<typeof vi.fn>;
const mockThemeCounts = getLatestScanFindingCountsByTheme as ReturnType<typeof vi.fn>;

const DOMAIN = "paw-naturals-llc.myshopify.com";
const MAIN_ID = "gid://shopify/OnlineStoreTheme/1";

const SHOP = {
  id: "shop-1",
  domain: DOMAIN,
  plan: "free",
  planReconciledAt: null,
  installedAt: new Date(),
  uninstalledAt: null,
  lastSeenAt: null,
  lastThemePublishAt: null,
  upgradePreviewShownAt: null,
  feedbackNudgeShownAt: null,
  feedbackNudgeDismissedAt: null,
  feedbackSubmittedAt: null,
  lastPromptKey: null,
  lastPromptShownAt: null,
};

/** A successful scan of the published theme, as the Scan row holds it. */
const SCAN = {
  id: "scan-1",
  shopId: SHOP.id,
  themeId: MAIN_ID,
  themeName: "Dawn - live",
  status: "COMPLETED",
  findingCount: 7,
  startedAt: new Date("2026-10-18T10:00:05Z"),
  completedAt: new Date("2026-10-18T10:01:00Z"),
  createdAt: new Date("2026-10-18T10:00:00Z"),
  viewedOnHomeAt: new Date("2026-10-18T10:02:00Z"),
  skippedCategories: [] as string[],
  cappedCategories: [] as string[],
  unreachableCategories: [] as string[],
  liveFindingTypes: Object.values(FindingType) as string[],
  themeInfo: { name: "Dawn", version: "15.2.0", author: "Shopify", architecture: "os2" },
};

const TYPE_COUNTS = { GHOST_SCRIPT: 3, GHOST_STYLE: 1, GHOST_PIXEL: 2, LIQUID_ERROR_RENDERED: 1 };

const THEMES = [
  { id: MAIN_ID, name: "Dawn - live", role: "MAIN", updatedAt: "2026-10-01T00:00:00Z" },
  { id: "t2", name: "Dawn - copy", role: "UNPUBLISHED", updatedAt: "2026-09-01T00:00:00Z" },
  { id: "t3", name: "Old Debut", role: "UNPUBLISHED", updatedAt: "2025-01-01T00:00:00Z" },
];

function runLoader() {
  return loader({
    request: new Request(`https://example.com/app`),
    params: {},
    context: {},
  } as unknown as LoaderFunctionArgs);
}

/** Render the real Dashboard with the given loader data, as the merchant sees it. */
function renderDashboard(loaderData: unknown): string {
  const Stub = createRoutesStub([
    { id: "dashboard", path: "/app", Component: Dashboard as never, loader: () => loaderData },
  ]);
  return renderToStaticMarkup(
    <Stub initialEntries={["/app"]} hydrationData={{ loaderData: { dashboard: loaderData } }} />,
  );
}

function setPlan(plan: string) {
  mockGetOrCreate.mockResolvedValue({ ...SHOP, plan });
}

const rowOf = (rows: HealthRow[], key: string) => rows.find((r) => r.key === key);

beforeEach(() => {
  vi.resetAllMocks();
  (getFullListTopFindings as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (getFreeTopFindings as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  resetThemeCaches();
  mockAuth.mockResolvedValue({ session: { shop: DOMAIN }, admin: { graphql: vi.fn() } });
  (fetchMainTheme as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: MAIN_ID,
    name: "Dawn - live",
  });
  mockFetchAllThemes.mockResolvedValue(THEMES);
  (canUseMultipleThemes as ReturnType<typeof vi.fn>).mockReturnValue(false);
  (canUseScanDiffing as ReturnType<typeof vi.fn>).mockReturnValue(false);
  (getScanUsage as ReturnType<typeof vi.fn>).mockResolvedValue({
    used: 1,
    limit: 1,
    period: "month",
    periodStart: new Date("2026-10-01T00:00:00Z"),
  });
  mockScans.mockResolvedValue({ items: [SCAN], hasNextPage: false });
  (getCompletedScansForShop as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (hasCompletedScans as ReturnType<typeof vi.fn>).mockResolvedValue(true);
  (getSeverityCountsForScans as ReturnType<typeof vi.fn>).mockResolvedValue(
    new Map([["scan-1", { HIGH: 3, MEDIUM: 3, LOW: 1 }]]),
  );
  mockTypeCounts.mockResolvedValue(TYPE_COUNTS);
  (getIgnoredFindingsForShop as ReturnType<typeof vi.fn>).mockResolvedValue({
    fingerprints: new Set(),
    appNames: new Set(),
  });
  mockThemeCounts.mockResolvedValue(new Map([["t3", 14]]));
  setPlan("free");
});

describe("Home loader: theme health checklist (gc-i6du)", () => {
  it.each(["free", "Standard", "Professional"])(
    "%s: the same categories and counts, from the latest successful scan",
    async (plan) => {
      setPlan(plan);
      const { themeHealth } = await runLoader();
      expect(themeHealth.map((r) => [r.key, r.statusLabel])).toEqual([
        ["malicious", "Clean"],
        // Free does not run the broken-link and old-checkout checks.
        ["shopper-visible", "1 issue"],
        ["scripts-styles", "4 issues"],
        ["snippets-sections", plan === "free" ? "None found" : "Clean"],
        ["seo-ai", "Clean"],
        ["tracking", "2 issues"],
        ["store-data", "Clean"],
        ["script-tag-deadline", "Clean"],
        ["theme", "Online Store 2.0"],
        ["unpublished-themes", "2 unpublished"],
      ]);
      expect(rowOf(themeHealth, "shopper-visible")!.detail).toBe(
        "1 Liquid error shoppers can read on your homepage.",
      );
      expect(rowOf(themeHealth, "scripts-styles")!.detail).toBe(
        "4 extra requests to apps you removed, on every page that loads them.",
      );
      expect(rowOf(themeHealth, "theme")!.detail).toBe("Dawn 15.2.0 by Shopify");
      expect(rowOf(themeHealth, "unpublished-themes")!.detail).toBe(
        "Your store has 3 themes. Shopify allows 20 (more on Plus). In their last scans: Old Debut: 14 findings.",
      );
    },
  );

  it("Free gets counts only: rows carry nothing from a finding, and link to the scan page", async () => {
    const { themeHealth } = await runLoader();
    for (const row of themeHealth) {
      expect(Object.keys(row).sort()).toEqual(
        ["checks", "count", "detail", "href", "key", "label", "status", "statusLabel"].sort(),
      );
      if (row.href) expect(row.href).toBe("/app/scans/scan-1");
    }
    // No finding rows were read for it at all: only per-type counts.
    expect(getFreeTopFindings).toHaveBeenCalledTimes(1);
    const json = JSON.stringify(themeHealth);
    expect(json).not.toMatch(/\.liquid|snippets\/|sections\/|codeSnippet|lineNumber|appName/);
  });

  it("a paid plan links a one-type row into the filtered list", async () => {
    setPlan("Standard");
    const { themeHealth } = await runLoader();
    // Tracking holds only GHOST_PIXEL here; scripts mixes two types.
    expect(rowOf(themeHealth, "tracking")!.href).toBe("/app/scans/scan-1?type=GHOST_PIXEL");
    expect(rowOf(themeHealth, "scripts-styles")!.href).toBe("/app/scans/scan-1");
  });

  it("Free reads the theme list once for the checklist, and the picker's list stays empty", async () => {
    const data = await runLoader();
    expect(mockFetchAllThemes).toHaveBeenCalledTimes(1);
    expect(data.allThemes).toEqual([]);
    expect(data.showMultiThemeNudge).toBe(false);
    expect(mockThemeCounts).toHaveBeenCalledWith("shop-1", ["t2", "t3"]);
  });

  it("a paid plan reuses the picker's theme list (one read)", async () => {
    setPlan("Standard");
    const data = await runLoader();
    expect(mockFetchAllThemes).toHaveBeenCalledTimes(1);
    expect(data.allThemes).toEqual(THEMES);
  });

  it("Free: the theme list fails to load: the checklist renders without the inventory row", async () => {
    mockFetchAllThemes.mockRejectedValue(new Error("THROTTLED"));
    const { themeHealth } = await runLoader();
    expect(rowOf(themeHealth, "unpublished-themes")).toBeUndefined();
    expect(rowOf(themeHealth, "theme")).toBeDefined();
    expect(mockThemeCounts).not.toHaveBeenCalled();
    // Logged by error name only (a message can echo values), never swallowed silently.
    expect(logger.warn).toHaveBeenCalledWith("theme health: theme list unavailable", {
      shop: DOMAIN,
      errorName: "Error",
    });
  });

  it.each(["PENDING", "IN_PROGRESS", "FAILED"])(
    "latest scan %s: no checklist, and nothing is read for it (the 3s poll stays cheap)",
    async (status) => {
      mockScans.mockResolvedValue({
        items: [{ ...SCAN, status, completedAt: null }],
        hasNextPage: false,
      });
      const data = await runLoader();
      expect(data.themeHealth).toEqual([]);
      expect(mockFetchAllThemes).not.toHaveBeenCalled();
      expect(mockThemeCounts).not.toHaveBeenCalled();
    },
  );

  it("no scan yet: no checklist", async () => {
    mockScans.mockResolvedValue({ items: [], hasNextPage: false });
    (hasCompletedScans as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    expect((await runLoader()).themeHealth).toEqual([]);
  });

  it("the shop row is missing: the fallback carries an empty checklist", async () => {
    mockGetOrCreate.mockResolvedValue(null);
    expect((await runLoader()).themeHealth).toEqual([]);
  });

  it("an unreadable storefront is never shown as Clean", async () => {
    mockScans.mockResolvedValue({
      items: [{ ...SCAN, unreachableCategories: ["SCRIPT_TAG_SUNSET", "LIQUID_ERROR_RENDERED"] }],
      hasNextPage: false,
    });
    mockTypeCounts.mockResolvedValue({ GHOST_SCRIPT: 1 });
    setPlan("Standard");
    const { themeHealth } = await runLoader();
    expect(rowOf(themeHealth, "shopper-visible")).toMatchObject({
      statusLabel: "None found",
      detail:
        "Your storefront homepage couldn't be read, for example because it has a password, so this wasn't checked.",
    });
  });

  it("a vintage theme is flagged", async () => {
    mockScans.mockResolvedValue({
      items: [
        {
          ...SCAN,
          themeInfo: {
            name: "Debut",
            version: "17.14.0",
            author: "Shopify",
            architecture: "vintage",
          },
        },
      ],
      hasNextPage: false,
    });
    const { themeHealth } = await runLoader();
    expect(rowOf(themeHealth, "theme")).toMatchObject({
      status: "issues",
      statusLabel: "Vintage theme",
    });
  });
});

describe("Home render: theme health checklist (gc-i6du)", () => {
  it("renders the section after the lanes, with each row's status and cost", async () => {
    const html = renderDashboard(await runLoader());
    expect(html).toContain(`>${THEME_HEALTH_HEADING}</h2>`);
    expect(html.indexOf("What it&#x27;s costing you")).toBeGreaterThan(-1);
    expect(html.indexOf(`>${THEME_HEALTH_HEADING}</h2>`)).toBeGreaterThan(
      html.indexOf("What it&#x27;s costing you"),
    );
    expect(html.indexOf(`>${THEME_HEALTH_HEADING}</h2>`)).toBeLessThan(
      html.indexOf("Scan Actions"),
    );
    expect(html).toContain('<s-badge tone="caution">4 issues</s-badge>');
    expect(html).toContain('<s-badge tone="success">Clean</s-badge>');
    expect(html).toContain("1 Liquid error shoppers can read on your homepage.");
    expect(html).toContain("Dawn 15.2.0 by Shopify");
    expect(html).toContain("2 unpublished");
  });

  it("has ONE 'Theme health' heading and no score, grade or percentage anywhere on Home", async () => {
    const html = renderDashboard(await runLoader());
    expect(html.match(/theme health/gi)).toHaveLength(1);
    // The findings count keeps its own heading (gc-k2ub).
    expect(html).toContain('<h2 class="dashboard-section-title">Findings</h2>');
    expect(html).not.toMatch(/health score/i);
    expect(html).not.toMatch(/out of 100|\/ ?100/i);
    const section = html.slice(
      html.indexOf('<section aria-labelledby="theme-health-heading"'),
      html.indexOf("</section>", html.indexOf('<section aria-labelledby="theme-health-heading"')),
    );
    expect(section.length).toBeGreaterThan(0);
    expect(section).not.toMatch(/%|\bscore\b|\bgrade\b|\b\d+ of \d+\b/i);
  });

  it("no em dashes in the section", async () => {
    const html = renderDashboard(await runLoader());
    const start = html.indexOf('<section aria-labelledby="theme-health-heading"');
    expect(html.slice(start, html.indexOf("</section>", start))).not.toContain("—");
  });

  it("is absent while a scan is running", async () => {
    mockScans.mockResolvedValue({
      items: [{ ...SCAN, status: "IN_PROGRESS", completedAt: null }],
      hasNextPage: false,
    });
    expect(renderDashboard(await runLoader())).not.toContain("theme-health-heading");
  });

  it("adds no upgrade ask of its own (plan-gated checks are named, with no button or link)", async () => {
    const html = renderDashboard(await runLoader());
    const start = html.indexOf('<section aria-labelledby="theme-health-heading"');
    const section = html.slice(start, html.indexOf("</section>", start));
    expect(section).toContain("Old checkout code is checked on Standard and Professional.");
    expect(section).not.toMatch(/pricing_plans|<s-button|Upgrade|free trial/i);
  });
});

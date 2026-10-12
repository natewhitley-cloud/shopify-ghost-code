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
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

const FLAGS = [
  "SCRIPT_TAG_SUNSET_LIVE_ENABLED",
  "SETTINGS_DRIFT_LIVE_ENABLED",
  "APP_EMBED_LIVE_ENABLED",
] as const;

afterEach(() => {
  for (const flag of FLAGS) delete process.env[flag];
});

beforeEach(() => {
  vi.resetAllMocks();
  // Every soft-launched check is switched on NOW (as in production for the
  // storefront checks) unless a test turns one off.
  for (const flag of FLAGS) process.env[flag] = "true";
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
        ["liquid-errors", "1 issue"],
        // Free does not run the broken-link and old-checkout checks.
        ["shopper-visible", plan === "free" ? "None found" : "Clean"],
        ["scripts-styles", "4 issues"],
        ["snippets-sections", plan === "free" ? "None found" : "Clean"],
        ["seo-ai", "Clean"],
        ["tracking", "2 issues"],
        ["store-data", "Clean"],
        ["script-tag-deadline", "Clean"],
        ["theme", "Online Store 2.0"],
        ["unpublished-themes", "2 unpublished"],
      ]);
      expect(rowOf(themeHealth, "liquid-errors")!.detail).toBe(
        "Your homepage prints 1 Liquid error because your theme renders a snippet that no longer exists. It can be inside a menu or a hidden section.",
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
    expect(rowOf(themeHealth, "liquid-errors")).toMatchObject({
      statusLabel: "Not checked",
      detail:
        "Your storefront homepage couldn't be read, for example because it has a password, so this wasn't checked.",
    });
  });

  describe("a scan that did not run a check that is on now (HIGH audit finding)", () => {
    const preDeploy = (liveFindingTypes: string[] | null) =>
      mockScans.mockResolvedValue({
        items: [{ ...SCAN, liveFindingTypes }],
        hasNextPage: false,
      });

    it("a scan from before the Liquid error check: Home says Not checked and to run a new scan, never Clean", async () => {
      preDeploy(SCAN.liveFindingTypes.filter((t) => t !== "LIQUID_ERROR_RENDERED"));
      mockTypeCounts.mockResolvedValue({ GHOST_SCRIPT: 1 });
      setPlan("Professional");
      const data = await runLoader();
      expect(rowOf(data.themeHealth, "liquid-errors")).toMatchObject({
        status: "not_checked",
        statusLabel: "Not checked",
        detail: "This wasn't checked on your last scan. Run a new scan.",
      });
      const html = renderDashboard(data);
      expect(html).toMatch(
        /Liquid errors on your homepage<\/h3>(?:(?!<\/li>)[\s\S])*<s-badge tone="neutral">Not checked<\/s-badge>/,
      );
      expect(html).toContain("This wasn&#x27;t checked on your last scan. Run a new scan.");
      // And it is not folded into the "Clean:" group.
      const fold = html.slice(html.indexOf("<details"), html.indexOf("</details>"));
      expect(fold).toContain("<summary");
      expect(fold).not.toContain("Liquid errors on your homepage");
    });

    it("a scan that recorded nothing about what it ran: no category reads Clean", async () => {
      preDeploy(null);
      mockTypeCounts.mockResolvedValue({});
      setPlan("Professional");
      const { themeHealth } = await runLoader();
      const categories = themeHealth.filter(
        (r) => r.key !== "theme" && r.key !== "unpublished-themes",
      );
      expect(categories.length).toBe(9);
      for (const row of categories) expect(row.status, row.key).toBe("not_checked");
    });

    it("the check is off for everyone now: its row is simply not there", async () => {
      delete process.env.SCRIPT_TAG_SUNSET_LIVE_ENABLED;
      preDeploy(SCAN.liveFindingTypes.filter((t) => t !== "LIQUID_ERROR_RENDERED"));
      mockTypeCounts.mockResolvedValue({});
      const { themeHealth } = await runLoader();
      expect(rowOf(themeHealth, "liquid-errors")).toBeUndefined();
    });
  });

  it("a checklist failure never takes Home down: no section, the rest renders, one warning", async () => {
    const hostile = {
      architecture: "os2",
      get name(): string {
        throw new TypeError("boom");
      },
    };
    mockScans.mockResolvedValue({ items: [{ ...SCAN, themeInfo: hostile }], hasNextPage: false });
    const data = await runLoader();
    expect(data.themeHealth).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      "theme health: checklist unavailable",
      expect.objectContaining({ errorName: "TypeError" }),
    );
    const html = renderDashboard(data);
    expect(html).not.toContain("theme-health-heading");
    expect(html).toContain('<h2 class="dashboard-section-title">Findings</h2>');
    expect(html).toContain("Scan Actions");
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
    expect(html).toContain("Your homepage prints 1 Liquid error because your theme renders");
    expect(html).toContain("Dawn 15.2.0 by Shopify");
    expect(html).toContain("2 unpublished");
  });

  it("folds only the clean checks into a closed group that names them, after the visible rows", async () => {
    const html = renderDashboard(await runLoader());
    const start = html.indexOf('<section aria-labelledby="theme-health-heading"');
    const section = html.slice(start, html.indexOf("</section>", start));
    expect(section).toMatch(
      /<details[^>]*><summary[^>]*>Clean: SEO and AI tags, Store data left behind, Script tag deadline<\/summary>/,
    );
    expect(section).not.toMatch(/<details[^>]*\bopen\b/);
    const visible = section.slice(0, section.indexOf("<details"));
    const fold = section.slice(section.indexOf("<details"));
    // Free: eight rows stay in full (malicious is clean and still shown first).
    expect(visible.match(/<h3[^>]*>(?:<a[^>]*>)?([^<]+)/g)).toHaveLength(8);
    expect(visible).toMatch(
      /Known malicious code<\/h3>(?:(?!<\/li>)[\s\S])*<s-badge tone="success">Clean<\/s-badge>/,
    );
    expect(visible).toContain("Online Store 2.0");
    // The fold holds Clean badges only: no issue, gap or fact is hidden in it.
    expect(fold.match(/<li /g)).toHaveLength(3);
    expect([...fold.matchAll(/<s-badge tone="([a-z]+)">([^<]*)</g)].map((m) => m[2])).toEqual([
      "Clean",
      "Clean",
      "Clean",
    ]);
    // A row with findings links from its label; there is no separate link line.
    expect(section).toMatch(
      /<a[^>]*aria-label="View findings: Leftover scripts and styles"[^>]*>Leftover scripts and styles<\/a><\/h3>/,
    );
    expect(section).not.toContain(">View findings<");
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

  it.each(["free", "Standard", "Professional"])(
    "%s: the REAL checklist, with findings in every category, shows no score of any kind",
    async (plan) => {
      setPlan(plan);
      // A finding of every type, a vintage theme and unpublished themes: every
      // row and every piece of cost copy is on the page.
      mockTypeCounts.mockResolvedValue(
        Object.fromEntries(Object.values(FindingType).map((t, i) => [t, i + 1])),
      );
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
      const html = renderDashboard(await runLoader());
      const start = html.indexOf('<section aria-labelledby="theme-health-heading"');
      expect(start).toBeGreaterThan(-1);
      const section = html.slice(start, html.indexOf("</section>", start));
      // Really rendered, not mocked: all eleven rows are there.
      expect(section.match(/<li /g)).toHaveLength(11);
      expect(section).toContain("Vintage theme");
      for (const banned of ["/ 100", "/100", "out of 100", "%", "score", "grade"]) {
        expect(section.toLowerCase(), `the checklist must not contain "${banned}"`).not.toContain(
          banned,
        );
      }
      expect(section).not.toMatch(/\b\d+ of \d+\b/);
      // And nowhere else on Home either (gc-k2ub).
      expect(html).not.toMatch(/health score|out of 100|\/ ?100/i);
    },
  );

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

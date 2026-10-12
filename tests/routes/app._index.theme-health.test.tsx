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
import { getFilteredFindingSummaryAndKept } from "../../app/services/finding-aggregation.server";
import { resetThemeCaches } from "../../app/services/theme-cache.server";
import { fetchAllThemes, fetchMainTheme } from "../../app/services/theme-fetcher.server";
import { getFreeTopFindings, getFullListTopFindings } from "../../app/services/top-findings.server";
import { authenticate } from "../../app/shopify.server";

const mockAuth = authenticate.admin as ReturnType<typeof vi.fn>;
const mockGetOrCreate = getOrCreateShopMetadata as ReturnType<typeof vi.fn>;
const mockScans = getScansForShop as ReturnType<typeof vi.fn>;
const mockTypeCounts = getTypeCountsForScan as ReturnType<typeof vi.fn>;
const mockFiltered = getFilteredFindingSummaryAndKept as ReturnType<typeof vi.fn>;
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

/** The theme health section of a rendered Home, or "" when it is absent. */
function sectionOf(html: string): string {
  const start = html.indexOf('<section aria-labelledby="theme-health-heading"');
  return start === -1 ? "" : html.slice(start, html.indexOf("</section>", start));
}

/** The content of the group labelled `label` in the section, or null when absent. */
function groupOf(section: string, label: string): string | null {
  return section.match(new RegExp(`<dt[^>]*>${label}</dt><dd[^>]*>([\\s\\S]*?)</dd>`))?.[1] ?? null;
}

/** Every group label in the section, in order. */
function groupLabels(section: string): string[] {
  return [...section.matchAll(/<dt[^>]*>([^<]*)<\/dt>/g)].map((m) => m[1]);
}

/** The Clean line as text, or null when there is no Clean group. */
function cleanLine(section: string): string | null {
  const group = groupOf(section, "Clean");
  return group === null ? null : group.replace(/<[^>]+>/g, "");
}

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
    const data = await runLoader();
    const { themeHealth } = data;
    expect(rowOf(themeHealth, "liquid-errors")).toMatchObject({
      statusLabel: "Not checked",
      detail:
        "Your storefront homepage couldn't be read, for example because it has a password, so this wasn't checked.",
    });
    // As the merchant sees it: not on the Clean line, and listed with its reason.
    const section = sectionOf(renderDashboard(data));
    const clean = cleanLine(section);
    expect(clean).toBe(
      "Known malicious code, Broken links and leftover app text, Leftover snippets and sections, SEO and AI tags, Tracking still running, Store data left behind",
    );
    expect(clean).not.toContain("Liquid errors on your homepage");
    expect(clean).not.toContain("Script tag deadline");
    // The script tag row is partial (one of its two checks ran), so the group
    // is "Not fully checked", never "Not checked" and never Clean.
    expect(groupLabels(section)).toEqual(["Theme", "Clean", "Not fully checked"]);
    const gaps = groupOf(section, "Not fully checked")!;
    expect(gaps).toMatch(
      /Liquid errors on your homepage<\/div><div[^>]*>Your storefront homepage couldn&#x27;t be read, for example because it has a password, so this wasn&#x27;t checked\.<\/div>/,
    );
    expect(gaps).toMatch(
      /Script tag deadline<\/div><div[^>]*>Your storefront homepage couldn&#x27;t be read/,
    );
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
      const section = sectionOf(renderDashboard(data));
      // Under "Not checked", with its label directly above the reason.
      expect(groupLabels(section)).toEqual(["Theme", "Clean", "Not checked"]);
      expect(groupOf(section, "Not checked")).toMatch(
        /^<div><div[^>]*>Liquid errors on your homepage<\/div><div[^>]*>This wasn&#x27;t checked on your last scan\. Run a new scan\.<\/div><\/div>$/,
      );
      // And it is not named on the Clean line, which is there and names others.
      const clean = cleanLine(section);
      expect(clean).toContain("Known malicious code");
      expect(clean).not.toContain("Liquid errors on your homepage");
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

    it("a scan that recorded nothing about what it ran: Home has no Clean line at all", async () => {
      preDeploy(null);
      mockTypeCounts.mockResolvedValue({});
      setPlan("Professional");
      const section = sectionOf(renderDashboard(await runLoader()));
      expect(groupLabels(section)).toEqual(["Theme", "Not checked"]);
      expect(cleanLine(section)).toBeNull();
      const gaps = groupOf(section, "Not checked")!;
      expect(
        gaps.match(/This wasn&#x27;t checked on your last scan\. Run a new scan\./g),
      ).toHaveLength(9);
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
    const data = await runLoader();
    expect(rowOf(data.themeHealth, "theme")).toMatchObject({
      status: "issues",
      statusLabel: "Vintage theme",
    });
    // The lanes do not carry this, so the sentence shows in the Theme group.
    expect(groupOf(sectionOf(renderDashboard(data)), "Theme")).toContain(
      "Debut 17.14.0 by Shopify is a vintage theme, not Online Store 2.0. It can&#x27;t use app blocks,",
    );
  });
});

describe("Home render: theme health checklist (gc-i6du)", () => {
  it("renders the section after the lanes: the theme, the clean checks and the gaps", async () => {
    const html = renderDashboard(await runLoader());
    expect(html).toContain(`>${THEME_HEALTH_HEADING}</h2>`);
    expect(html.indexOf("What it&#x27;s costing you")).toBeGreaterThan(-1);
    expect(html.indexOf(`>${THEME_HEALTH_HEADING}</h2>`)).toBeGreaterThan(
      html.indexOf("What it&#x27;s costing you"),
    );
    expect(html.indexOf(`>${THEME_HEALTH_HEADING}</h2>`)).toBeLessThan(
      html.indexOf("Scan Actions"),
    );
    const section = sectionOf(html);
    expect(section).toContain("What your last scan checked, beyond the findings above.");
    // Free: two rows are partial (a plan-gated check each), so "Not fully checked".
    expect(groupLabels(section)).toEqual(["Theme", "Clean", "Not fully checked"]);
    expect(groupOf(section, "Theme")).toMatch(
      /^<div[^>]*>Dawn 15\.2\.0 by Shopify · Online Store 2\.0<\/div><div[^>]*>Your store has 3 themes\. Shopify allows 20 \(more on Plus\)\. In their last scans: Old Debut: 14 findings\.<\/div>$/,
    );
  });

  it("names only the clean checks under Clean, lists the gaps with their reasons, and leaves out every check that found something", async () => {
    const section = sectionOf(renderDashboard(await runLoader()));
    // Malicious code is clean here and is named, first. No digit, no count.
    const clean = cleanLine(section);
    expect(clean).toBe(
      "Known malicious code, SEO and AI tags, Store data left behind, Script tag deadline",
    );
    expect(clean).not.toMatch(/\d/);
    // Free: the two partly checked rows, each with its reason, in order.
    expect(groupOf(section, "Not fully checked")).toMatch(
      /^<div><div[^>]*>Broken links and leftover app text<\/div><div[^>]*>Broken links are checked on Standard and Professional\.<\/div><\/div><div[^>]*><div[^>]*>Leftover snippets and sections<\/div><div[^>]*>Old checkout code is checked on Standard and Professional\.<\/div><\/div>$/,
    );
    // The three checks with findings are the lanes' job: no label, count or cost.
    for (const gone of [
      "Liquid errors on your homepage",
      "Your homepage prints",
      "Leftover scripts and styles",
      "extra requests",
      "Tracking still running",
      "tracking pixel",
      "issue",
      "None found",
    ]) {
      expect(section, `"${gone}" must not be in the section`).not.toContain(gone);
    }
    // Quiet text: no badge, link, fold or row list.
    expect(section).not.toMatch(/<s-badge|<a |View findings|<details|<summary|<li |<h3/);
  });

  it.each(["Standard", "Professional"])(
    "%s: nothing is partly checked, so there is no gap group and the Clean line grows",
    async (plan) => {
      setPlan(plan);
      const section = sectionOf(renderDashboard(await runLoader()));
      expect(groupLabels(section)).toEqual(["Theme", "Clean"]);
      expect(cleanLine(section)).toBe(
        "Known malicious code, Broken links and leftover app text, Leftover snippets and sections, SEO and AI tags, Store data left behind, Script tag deadline",
      );
    },
  );

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
      const data = await runLoader();
      const html = renderDashboard(data);
      const section = sectionOf(html);
      // Really built, not mocked: all eleven rows, nine of them with findings.
      expect(data.themeHealth).toHaveLength(11);
      expect(data.themeHealth.filter((r) => r.status === "issues")).toHaveLength(10);
      // Rendered: every category found something, so only the theme facts show
      // (the vintage sentence and the theme library). No Clean line, no gaps.
      expect(groupLabels(section)).toEqual(["Theme"]);
      expect(section).toContain("Debut 17.14.0 by Shopify is a vintage theme");
      expect(section).toContain("Your store has 3 themes.");
      // Known malicious code is the one check with findings that still shows,
      // as a critical line with its count and a link (security is never hidden).
      const maliciousRow = data.themeHealth.find((r) => r.key === "malicious")!;
      expect(maliciousRow.status).toBe("issues");
      expect(maliciousRow.count).toBeGreaterThan(0);
      expect(section).toContain(`<s-badge tone="critical">${maliciousRow.statusLabel}</s-badge>`);
      expect(section).toContain(">Known malicious code</strong>");
      expect(section).toContain(maliciousRow.detail!);
      expect(section).toMatch(
        /<a aria-label="View findings: Known malicious code" href="\/app\/scans\/[^"]+"[^>]*>View findings<\/a>/,
      );
      // It is the ONLY check with findings in the section: one badge, one link,
      // and no other category's label.
      expect(section.match(/<s-badge/g)).toHaveLength(1);
      expect(section.match(/<a /g)).toHaveLength(1);
      for (const other of data.themeHealth.filter(
        (r) => r.status === "issues" && r.key !== "malicious" && r.key !== "theme",
      )) {
        expect(section, other.key).not.toContain(other.label);
      }
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

  // Reviewer L1 + L3: Home's malicious line is driven by what the scan FOUND
  // (ignored findings included, like the scan page's security alert), and is
  // built outside loadThemeHealth so a checklist failure cannot drop it.
  describe("known malicious code: ignores and checklist failures", () => {
    const MALICIOUS_DETAIL_2 =
      "2 pieces of code from a known malicious source are in your theme. It can steal shopper data or send your customers to other sites.";

    /** The shop has ignores; `kept` of the scan's malicious findings are NOT ignored. */
    function ignoreMalicious(found: number, kept: number) {
      // Unfiltered groupBy: what the scan found.
      mockTypeCounts.mockResolvedValue({ ...TYPE_COUNTS, MALICIOUS_SCRIPT: found });
      (getIgnoredFindingsForShop as ReturnType<typeof vi.fn>).mockResolvedValue({
        fingerprints: new Set(["fp-malicious"]),
        appNames: new Set(),
      });
      // Ignore-filtered summary, as getFilteredFindingSummaryAndKept returns it:
      // ignored findings are not counted in byType.
      mockFiltered.mockResolvedValue({
        summary: {
          total: 7 + kept,
          bySeverity: { HIGH: 3 + kept, MEDIUM: 3, LOW: 1 },
          byType: { ...TYPE_COUNTS, MALICIOUS_SCRIPT: kept },
        },
        keptFindings: [],
      });
    }

    function expectCriticalLine(section: string, statusLabel: string, detail: string) {
      expect(section).toContain(`<s-badge tone="critical">${statusLabel}</s-badge>`);
      expect(section).toContain(">Known malicious code</strong>");
      expect(section).toContain(detail);
      expect(section).toMatch(
        /<a aria-label="View findings: Known malicious code" href="\/app\/scans\/scan-1"[^>]*>View findings<\/a>/,
      );
      // First in the section: before the groups, when there are any.
      if (section.includes("<dl")) {
        expect(section.indexOf("<s-badge")).toBeLessThan(section.indexOf("<dl"));
      }
    }

    it.each(["free", "Standard", "Professional"])(
      "%s: every malicious finding ignored -> the critical line still renders, and Clean does not name it",
      async (plan) => {
        setPlan(plan);
        ignoreMalicious(2, 0);
        const data = await runLoader();
        expect(data.maliciousHealth).toMatchObject({
          key: "malicious",
          status: "issues",
          statusLabel: "2 issues",
          count: 2,
          detail: MALICIOUS_DETAIL_2,
          href: "/app/scans/scan-1",
        });
        // The checklist row agrees: never "Clean" for a scan that found some.
        expect(rowOf(data.themeHealth, "malicious")).toEqual(data.maliciousHealth);
        // Every OTHER row still uses the ignore-filtered counts.
        expect(rowOf(data.themeHealth, "scripts-styles")!.statusLabel).toBe("4 issues");
        const section = sectionOf(renderDashboard(data));
        expectCriticalLine(section, "2 issues", MALICIOUS_DETAIL_2);
        expect(cleanLine(section)).not.toBeNull();
        expect(cleanLine(section)).not.toContain("Known malicious code");
        expect(section.match(/Known malicious code/g)).toHaveLength(2); // label + link aria-label
        // The wording never claims the ignored findings are gone or ignored.
        expect(section).not.toMatch(/ignored/i);
      },
    );

    it("some malicious findings ignored -> the count is what the scan found, not what is left", async () => {
      setPlan("Standard");
      ignoreMalicious(2, 1);
      const data = await runLoader();
      expect(data.maliciousHealth).toMatchObject({ count: 2, statusLabel: "2 issues" });
      expectCriticalLine(sectionOf(renderDashboard(data)), "2 issues", MALICIOUS_DETAIL_2);
    });

    it.each(["free", "Professional"])(
      "%s: the checklist fails with a malicious finding -> the critical line still renders, alone",
      async (plan) => {
        setPlan(plan);
        mockTypeCounts.mockResolvedValue({ ...TYPE_COUNTS, MALICIOUS_SCRIPT: 1 });
        const hostile = {
          architecture: "os2",
          get name(): string {
            throw new TypeError("boom");
          },
        };
        mockScans.mockResolvedValue({
          items: [{ ...SCAN, themeInfo: hostile }],
          hasNextPage: false,
        });
        const data = await runLoader();
        expect(data.themeHealth).toEqual([]);
        expect(logger.warn).toHaveBeenCalledWith(
          "theme health: checklist unavailable",
          expect.objectContaining({ errorName: "TypeError" }),
        );
        expect(data.maliciousHealth).toMatchObject({ count: 1, statusLabel: "1 issue" });
        const section = sectionOf(renderDashboard(data));
        expectCriticalLine(
          section,
          "1 issue",
          "1 piece of code from a known malicious source is in your theme. It can steal shopper data or send your customers to other sites.",
        );
        expect(groupLabels(section)).toEqual([]);
      },
    );

    it.each(["free", "Standard", "Professional"])(
      "%s: no malicious findings -> no critical line, and Clean may name it",
      async (plan) => {
        setPlan(plan);
        const data = await runLoader();
        expect(data.maliciousHealth).toBeNull();
        const section = sectionOf(renderDashboard(data));
        expect(section).not.toContain("<s-badge");
        expect(section).not.toContain("View findings");
        expect(cleanLine(section)).toContain("Known malicious code");
      },
    );

    it("ignores on other findings only: malicious stays Clean and there is no critical line", async () => {
      ignoreMalicious(0, 0);
      const data = await runLoader();
      expect(data.maliciousHealth).toBeNull();
      expect(cleanLine(sectionOf(renderDashboard(data)))).toContain("Known malicious code");
    });

    // Reviewer LOW-4: lane counts leave out ignored findings, so with every
    // malicious finding ignored and nothing else found the lanes card used to
    // say the theme was clean right above the critical line.
    describe("the all-clear card", () => {
      const ALL_CLEAR = ["You&#x27;re all clear", "Your theme is clean"];

      /** A scan whose only findings are `found` malicious ones, `kept` of them not ignored. */
      function onlyMalicious(found: number, kept: number) {
        mockTypeCounts.mockResolvedValue(found > 0 ? { MALICIOUS_SCRIPT: found } : {});
        (getIgnoredFindingsForShop as ReturnType<typeof vi.fn>).mockResolvedValue({
          fingerprints: new Set(["fp-malicious"]),
          appNames: new Set(),
        });
        mockFiltered.mockResolvedValue({
          summary: {
            total: kept,
            bySeverity: { HIGH: kept, MEDIUM: 0, LOW: 0 },
            byType: kept > 0 ? { MALICIOUS_SCRIPT: kept } : {},
          },
          keptFindings: [],
        });
      }

      it.each(["free", "Standard", "Professional"])(
        "%s: every malicious finding ignored and nothing else found -> no all-clear text, critical line present",
        async (plan) => {
          setPlan(plan);
          onlyMalicious(2, 0);
          const data = await runLoader();
          expect(data.laneSummary).toEqual([]);
          expect(data.maliciousHealth).toMatchObject({ count: 2, statusLabel: "2 issues" });
          const html = renderDashboard(data);
          for (const text of ALL_CLEAR) expect(html, text).not.toContain(text);
          expect(html).not.toMatch(/all clear|is clean/i);
          expect(html).not.toContain("What it&#x27;s costing you");
          expectCriticalLine(sectionOf(html), "2 issues", MALICIOUS_DETAIL_2);
        },
      );

      it("a malicious finding that is NOT ignored keeps its lane, with no all-clear text", async () => {
        onlyMalicious(2, 2);
        const data = await runLoader();
        expect(data.laneSummary).not.toEqual([]);
        const html = renderDashboard(data);
        for (const text of ALL_CLEAR) expect(html, text).not.toContain(text);
        expect(html).toContain("What it&#x27;s costing you");
        expectCriticalLine(sectionOf(html), "2 issues", MALICIOUS_DETAIL_2);
      });

      it.each(["free", "Standard", "Professional"])(
        "%s: no malicious findings and nothing else found -> the all-clear text still renders",
        async (plan) => {
          setPlan(plan);
          onlyMalicious(0, 0);
          const data = await runLoader();
          expect(data.laneSummary).toEqual([]);
          expect(data.maliciousHealth).toBeNull();
          const html = renderDashboard(data);
          for (const text of ALL_CLEAR) expect(html, text).toContain(text);
          expect(sectionOf(html)).not.toContain("<s-badge");
        },
      );
    });

    it("adds no finding query: the count comes from the per-type counts already loaded", async () => {
      mockTypeCounts.mockResolvedValue({ ...TYPE_COUNTS, MALICIOUS_SCRIPT: 3 });
      const data = await runLoader();
      expect(data.maliciousHealth).toMatchObject({ count: 3 });
      expect(mockTypeCounts).toHaveBeenCalledTimes(1);
      expect(mockTypeCounts).toHaveBeenCalledWith("scan-1");
    });

    it("no successful latest scan: no malicious line and no per-type count query", async () => {
      mockScans.mockResolvedValue({
        items: [{ ...SCAN, status: "FAILED", completedAt: null }],
        hasNextPage: false,
      });
      const data = await runLoader();
      expect(data.maliciousHealth).toBeNull();
      expect(mockTypeCounts).not.toHaveBeenCalled();
    });
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

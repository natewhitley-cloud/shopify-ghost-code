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
import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from "vitest";

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

vi.mock("../../app/models/finding.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/models/finding.server")>();
  return {
    // Pure helpers, for the kill-switch test's real aggregation (gc-5nok).
    createZeroSeverityCounts: actual.createZeroSeverityCounts,
    createZeroTypeCounts: actual.createZeroTypeCounts,
    getFindingSummary: vi.fn(),
    getSeverityCountsForScans: vi.fn(),
    getTypeCountsForScan: vi.fn(),
    // gc-q5z8: the Security risk banners read malicious findings (none by default).
    getFindingsForScan: vi.fn().mockResolvedValue([]),
  };
});

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
import {
  advisoryDescription,
  APP_INCIDENT_ADVISORIES,
} from "../../app/data/app-incident-advisories.server";
import {
  homepageMaliciousDescription,
  KNOWN_MALICIOUS_DOMAINS,
  maliciousDescription,
} from "../../app/data/malicious-domains.server";
import { logger } from "../../app/lib/logger.server";
import {
  canUseMultipleThemes,
  canUseScanDiffing,
  getScanUsage,
} from "../../app/lib/plan-gating.server";
import type { HealthRow } from "../../app/lib/theme-health";
import {
  getFindingSummary,
  getFindingsForScan,
  getSeverityCountsForScans,
  getTypeCountsForScan,
} from "../../app/models/finding.server";
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
import { isSoftLaunchLive } from "../../app/services/soft-launch-flags.server";
import { resetThemeCaches } from "../../app/services/theme-cache.server";
import { fetchAllThemes, fetchMainTheme } from "../../app/services/theme-fetcher.server";
import { getFreeTopFindings, getFullListTopFindings } from "../../app/services/top-findings.server";
import { authenticate } from "../../app/shopify.server";
import { COLOR_SUCCESS, COLOR_WARNING, LANE_GREY_FILL } from "../../app/styles/shared";
import {
  actionOf,
  BODY,
  chipLines,
  chipsOf,
  greenLabels,
  themeText,
  verdictOf,
} from "../test-utils/theme-health-html";

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

const TYPE_COUNTS = {
  GHOST_SCRIPT: 3,
  GHOST_STYLE: 1,
  GHOST_PIXEL: 2,
  LIQUID_ERROR_RENDERED: 1,
  // getTypeCountsForScan zero-seeds every type (gc-7gjj.1 reads this one).
  MENU_INJECTION: 0,
};

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
  if (start === -1) return "";
  return html.slice(start, html.indexOf("</section>", start) + "</section>".length);
}

const UNREACHABLE =
  "We couldn't read your storefront homepage, for example because it has a password. Run a new scan once the homepage can be read.";
const NOT_RUN = "Not checked on your last scan. Run a new scan to try again.";
const MALICIOUS_UNCHECKED = "Some checks couldn't run, including the check for malicious code.";
const LIBRARY =
  "Your store has 3 themes. Shopify allows 20 (more on Plus). In their last scans: Old Debut: 14 findings.";

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
      detail: UNREACHABLE,
    });
    // As the merchant sees it: neither storefront check is a green chip.
    const section = sectionOf(renderDashboard(data));
    const green = greenLabels(section);
    expect(green).toEqual([
      "Known malicious code",
      "Broken links and leftover app text",
      "Leftover snippets and sections",
      "SEO and AI tags",
      "Tracking still running",
      "Store data left behind",
    ]);
    expect(green).not.toContain("Liquid errors on your homepage");
    expect(green).not.toContain("Script tag deadline");
    // The Liquid row did not run; the script tag row is partial (one of its
    // two checks ran). Both are amber, said in words, never green.
    expect(chipLines(section)).toContain("warn Not checked: Liquid errors on your homepage");
    expect(chipLines(section)).toContain("warn Partly checked: Script tag deadline");
    expect(verdictOf(section)).toEqual({
      tone: "warn",
      text: "No known malicious code found. Some checks couldn't run.",
    });
    // Both under the ONE reason, which is stated once.
    expect(actionOf(section)!.entries).toEqual([
      { names: "Liquid errors on your homepage, Script tag deadline", reason: UNREACHABLE },
    ]);
    expect(section.split("We couldn&#x27;t read your storefront homepage")).toHaveLength(2);
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
        detail: NOT_RUN,
      });
      const section = sectionOf(renderDashboard(data));
      // An amber "Not checked" chip, and its name directly above the reason.
      expect(chipLines(section)).toContain("warn Not checked: Liquid errors on your homepage");
      expect(actionOf(section)!.entries).toEqual([
        { names: "Liquid errors on your homepage", reason: NOT_RUN },
      ]);
      // And it is not a green chip, though there are green chips and they name others.
      const green = greenLabels(section);
      expect(green).toContain("Known malicious code");
      expect(green).not.toContain("Liquid errors on your homepage");
      expect(verdictOf(section)).toEqual({
        tone: "warn",
        text: "No known malicious code found. Some checks couldn't run.",
      });
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

    it("a scan that recorded nothing about what it ran: Home has no green chip and no all-clear at all", async () => {
      preDeploy(null);
      mockTypeCounts.mockResolvedValue({});
      setPlan("Professional");
      const section = sectionOf(renderDashboard(await runLoader()));
      expect(greenLabels(section)).toEqual([]);
      const chips = chipsOf(section);
      expect(chips).toHaveLength(9);
      for (const chip of chips) {
        expect(chip, chip.label).toMatchObject({ tone: "warn", prefix: "Not checked: " });
      }
      // The malicious check did not run either: the verdict says so, and never
      // says no known malicious code was found.
      expect(verdictOf(section)).toEqual({ tone: "warn", text: MALICIOUS_UNCHECKED });
      expect(section).not.toMatch(/no known malicious code found/i);
      // All nine checks under the one reason, stated once.
      const { entries } = actionOf(section)!;
      expect(entries).toEqual([{ names: chips.map((c) => c.label).join(", "), reason: NOT_RUN }]);
      expect(section.split(NOT_RUN)).toHaveLength(2);
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
    // The lanes do not carry this, so the sentence shows as the theme line.
    expect(themeText(sectionOf(renderDashboard(data)))[0]).toContain(
      "Debut 17.14.0 by Shopify is a vintage theme, not Online Store 2.0. It can't use app blocks,",
    );
  });
});

describe("Home render: theme health checklist (gc-i6du)", () => {
  it("renders the section after the lanes: the verdict, the chips, the gaps and the theme line", async () => {
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
    // Free: two rows are partial (a plan-gated check each), so "only partly ran".
    expect(verdictOf(section)).toEqual({
      tone: "warn",
      text: "No known malicious code found. Some checks only partly ran.",
    });
    expect(section.indexOf("No known malicious code found.")).toBeLessThan(section.indexOf("<ul"));
    expect(section.indexOf("<ul")).toBeLessThan(section.indexOf("Broken links are checked"));
    expect(section.indexOf("Broken links are checked")).toBeLessThan(
      section.indexOf("Dawn 15.2.0"),
    );
    expect(themeText(section)).toEqual([`Dawn 15.2.0 by Shopify · Online Store 2.0 · ${LIBRARY}`]);
  });

  it("only the clean checks are green chips, the gaps are amber with their reasons, and every check that found something is left out", async () => {
    const section = sectionOf(renderDashboard(await runLoader()));
    // Malicious code is clean here and is a green chip, first. No digit, no count.
    expect(chipLines(section)).toEqual([
      "ok Clean: Known malicious code",
      "warn Partly checked: Broken links and leftover app text",
      "warn Partly checked: Leftover snippets and sections",
      "ok Clean: SEO and AI tags",
      "ok Clean: Store data left behind",
      "ok Clean: Script tag deadline",
    ]);
    expect(chipLines(section).join(" ")).not.toMatch(/\d/);
    // Free: the two partly checked rows, each with its reason, in order.
    expect(actionOf(section)!.entries).toEqual([
      {
        names: "Broken links and leftover app text",
        reason: "Broken links are checked on Standard and Professional.",
      },
      {
        names: "Leftover snippets and sections",
        reason: "Old checkout code is checked on Standard and Professional.",
      },
    ]);
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
    // No badge, link, button or fold.
    expect(section).not.toMatch(
      /<s-badge|<a |View findings|<details|<summary|<button|<s-button|<h3/,
    );
  });

  it.each(["Standard", "Professional"])(
    "%s: every check ran and three found something, so the dot is grey (not green), with no action box and more green chips",
    async (plan) => {
      setPlan(plan);
      const data = await runLoader();
      // The lanes above the section list these findings: a green dot would overclaim.
      expect(data.themeHealth.filter((r) => r.status === "issues").map((r) => r.key)).toEqual([
        "liquid-errors",
        "scripts-styles",
        "tracking",
      ]);
      const section = sectionOf(renderDashboard(data));
      expect(verdictOf(section)).toEqual({
        tone: "neutral",
        text: "No known malicious code found.",
      });
      expect(section).toContain(`border-radius:5px;background:${LANE_GREY_FILL}`);
      expect(section).not.toContain(`background:${COLOR_SUCCESS}`);
      expect(actionOf(section)).toBeNull();
      expect(chipLines(section)).toEqual(
        [
          "Known malicious code",
          "Broken links and leftover app text",
          "Leftover snippets and sections",
          "SEO and AI tags",
          "Store data left behind",
          "Script tag deadline",
        ].map((label) => `ok Clean: ${label}`),
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
      // The advisory and menu findings are shown only while their flags are
      // on (read-time kill switches, gc-5nok and gc-7gjj.1).
      process.env.APP_INCIDENT_ADVISORY_LIVE_ENABLED = "true";
      process.env.MENU_INJECTION_LIVE_ENABLED = "true";
      onTestFinished(() => {
        delete process.env.APP_INCIDENT_ADVISORY_LIVE_ENABLED;
        delete process.env.MENU_INJECTION_LIVE_ENABLED;
      });
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
      // Really built, not mocked: all eleven rows, nine of them with findings,
      // plus the App security advisories check (gc-q5z8) and the Menu labels
      // check (gc-7gjj.1), which each found something.
      expect(data.themeHealth).toHaveLength(13);
      expect(data.themeHealth.filter((r) => r.status === "issues")).toHaveLength(12);
      // Rendered: every category found something, so only the theme facts show
      // (the vintage sentence and the theme library). No action box, and no
      // verdict line: the malicious line below is the verdict. The one chip is
      // the failed advisory check (a security risk is never hidden).
      expect(chipsOf(section)).toEqual([
        { tone: "critical", glyph: "\u26a0", prefix: "Found: ", label: "Menu labels" },
        { tone: "critical", glyph: "\u26a0", prefix: "Found: ", label: "App security advisories" },
      ]);
      expect(actionOf(section)).toBeNull();
      expect(verdictOf(section)).toBeNull();
      expect(themeText(section)).toEqual([
        expect.stringContaining("Debut 17.14.0 by Shopify is a vintage theme"),
        LIBRARY,
      ]);
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
        (r) =>
          r.status === "issues" &&
          r.key !== "malicious" &&
          r.key !== "theme" &&
          r.key !== "app-advisories" &&
          r.key !== "menu-labels",
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
      // First in the section: before the chips and the rest, when there are any.
      if (section.includes(BODY)) {
        expect(section.indexOf("<s-badge")).toBeLessThan(section.indexOf(BODY));
      }
      // The red line is the verdict: never a second one, never an all-clear.
      expect(verdictOf(section)).toBeNull();
      expect(section).not.toMatch(/no known malicious code found/i);
      expect(chipsOf(section).map((c) => c.label)).not.toContain("Known malicious code");
      // The same, read from the text alone: no chip prefix sits before its name.
      expect(section).not.toMatch(/(?:Clean|checked): <\/span>Known malicious code/);
    }

    it.each(["free", "Standard", "Professional"])(
      "%s: every malicious finding ignored -> the critical line still renders, and no green chip names it",
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
        expect(greenLabels(section).length).toBeGreaterThan(0);
        expect(greenLabels(section)).not.toContain("Known malicious code");
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
        expect(section).not.toContain(BODY);
        expect(chipsOf(section)).toEqual([]);
      },
    );

    it.each(["free", "Standard", "Professional"])(
      "%s: no malicious findings -> no critical line, a green chip names it and the verdict says so",
      async (plan) => {
        setPlan(plan);
        const data = await runLoader();
        expect(data.maliciousHealth).toBeNull();
        const section = sectionOf(renderDashboard(data));
        expect(section).not.toContain("<s-badge");
        expect(section).not.toContain("View findings");
        expect(greenLabels(section)).toContain("Known malicious code");
        expect(verdictOf(section)!.text).toMatch(/^No known malicious code found\./);
      },
    );

    it("ignores on other findings only: malicious stays Clean and there is no critical line", async () => {
      ignoreMalicious(0, 0);
      const data = await runLoader();
      expect(data.maliciousHealth).toBeNull();
      expect(greenLabels(sectionOf(renderDashboard(data)))).toContain("Known malicious code");
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
          const section = sectionOf(html);
          expect(section).not.toContain("<s-badge");
          // Nothing found anywhere: the dot is green once every check ran in
          // full (Free's two plan-gated checks keep it amber).
          expect(verdictOf(section)).toEqual(
            plan === "free"
              ? {
                  tone: "warn",
                  text: "No known malicious code found. Some checks only partly ran.",
                }
              : { tone: "ok", text: "No known malicious code found." },
          );
          expect(section).toContain(
            `border-radius:5px;background:${plan === "free" ? COLOR_WARNING : COLOR_SUCCESS}`,
          );
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

// gc-j8xq: the findings tile sat green at 0 right above the critical "Known
// malicious code" line once every malicious finding was ignored. The tile now
// counts known malicious code whether or not it was ignored, and is never
// green while the scan found any.
describe("Home findings tile: known malicious code counts regardless of ignores (gc-j8xq)", () => {
  type Counts = Record<string, number>;
  const sum = (c: Counts) => Object.values(c).reduce((a, b) => a + b, 0);
  const PREV = { ...SCAN, id: "scan-0", createdAt: new Date("2026-10-11T10:00:00Z") };

  /**
   * Per scan id: `found` is what the scan stored per type; `kept` is what is
   * left after the shop's ignores (null = the shop has no ignores at all).
   */
  function scans(state: Record<string, { found: Counts; kept: Counts }>, hasIgnores = true) {
    (getSeverityCountsForScans as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Map(
        Object.entries(state).map(([id, s]) => [id, { HIGH: sum(s.found), MEDIUM: 0, LOW: 0 }]),
      ),
    );
    mockTypeCounts.mockImplementation(async (id: string) => state[id].found);
    (getIgnoredFindingsForShop as ReturnType<typeof vi.fn>).mockResolvedValue({
      fingerprints: new Set(hasIgnores ? ["fp-ignored"] : []),
      appNames: new Set(),
    });
    mockFiltered.mockImplementation(async (id: string) => ({
      summary: {
        total: sum(state[id].kept),
        bySeverity: { HIGH: sum(state[id].kept), MEDIUM: 0, LOW: 0 },
        byType: state[id].kept,
      },
      keptFindings: [],
    }));
  }

  /** The tile as rendered: its tone classes, its number and its noun. */
  function tileOf(html: string) {
    const tile = html.match(/class="health-score-tile health-score-tile--(\w+)"/);
    const number = html.match(/class="health-score-number health-score-number--(\w+)">(\d+)</);
    const noun = html.match(/class="health-score-subtitle">([^<]*)</);
    const delta = html.match(/class="health-score-delta"[^>]*>([^<]*)</);
    return {
      tileTone: tile?.[1],
      numberTone: number?.[1],
      total: Number(number?.[2]),
      noun: noun?.[1],
      delta: delta?.[1] ?? null,
    };
  }

  it.each(["free", "Standard", "Professional"])(
    "%s (a): 2 malicious, both ignored, nothing else -> 2, not green",
    async (plan) => {
      setPlan(plan);
      scans({ "scan-1": { found: { MALICIOUS_SCRIPT: 2 }, kept: {} } });
      const data = await runLoader();
      expect(data.findingsTile).toMatchObject({ total: 2, tone: "critical" });
      const html = renderDashboard(data);
      expect(tileOf(html)).toMatchObject({
        tileTone: "critical",
        numberTone: "critical",
        total: 2,
        noun: "findings, 2 security risks",
      });
      // (The class names also sit in the page's <style> block: match attributes.)
      expect(html).not.toMatch(/class="[^"]*health-score-(tile|number)--success/);
      // The tile agrees with the critical line under it.
      expect(data.maliciousHealth).toMatchObject({ count: 2 });
    },
  );

  it("(b): 2 malicious (1 ignored) plus 3 others (1 ignored) -> 4, counted once each", async () => {
    scans({
      "scan-1": {
        found: { MALICIOUS_SCRIPT: 2, GHOST_SCRIPT: 3 },
        kept: { MALICIOUS_SCRIPT: 1, GHOST_SCRIPT: 2 },
      },
    });
    const data = await runLoader();
    expect(data.findingsTile).toMatchObject({ total: 4, tone: "critical" });
    expect(tileOf(renderDashboard(data))).toMatchObject({ tileTone: "critical", total: 4 });
  });

  it("malicious findings that are not ignored are not counted twice", async () => {
    scans({
      "scan-1": {
        found: { MALICIOUS_SCRIPT: 2, GHOST_SCRIPT: 3 },
        kept: { MALICIOUS_SCRIPT: 2, GHOST_SCRIPT: 3 },
      },
    });
    const data = await runLoader();
    expect(data.findingsTile).toMatchObject({ total: 5, tone: "critical" });
  });

  it("malicious code with no ignores at all: the stored total, not green", async () => {
    scans({ "scan-1": { found: { MALICIOUS_SCRIPT: 1 }, kept: {} } }, false);
    const data = await runLoader();
    expect(mockFiltered).not.toHaveBeenCalled();
    expect(data.findingsTile).toMatchObject({ total: 1, tone: "critical" });
    expect(tileOf(renderDashboard(data))).toMatchObject({
      tileTone: "critical",
      total: 1,
      noun: "finding, 1 security risk",
    });
  });

  it("(c): no malicious, everything ignored -> 0 and green, as before", async () => {
    scans({ "scan-1": { found: { GHOST_SCRIPT: 3 }, kept: {} } });
    const data = await runLoader();
    expect(data.findingsTile).toMatchObject({ total: 0, tone: "success" });
    expect(tileOf(renderDashboard(data))).toMatchObject({
      tileTone: "success",
      numberTone: "success",
      total: 0,
    });
  });

  it("(d): no malicious, normal findings -> unchanged, with and without ignores", async () => {
    // No ignores: the seeded scan's 7 findings.
    let data = await runLoader();
    expect(data.findingsTile).toMatchObject({ total: 7, tone: "warning" });
    expect(tileOf(renderDashboard(data))).toMatchObject({
      tileTone: "warning",
      numberTone: "warning",
      total: 7,
    });

    // With ignores: the ignore-filtered total.
    scans({ "scan-1": { found: { GHOST_SCRIPT: 3, GHOST_PIXEL: 2 }, kept: { GHOST_SCRIPT: 2 } } });
    data = await runLoader();
    expect(data.findingsTile).toMatchObject({ total: 2, tone: "warning" });
    expect(tileOf(renderDashboard(data))).toMatchObject({ tileTone: "warning", total: 2 });
  });

  describe("the change since the last scan, under the tile", () => {
    beforeEach(() => {
      mockScans.mockResolvedValue({ items: [SCAN, PREV], hasNextPage: false });
    });

    it("the same ignored malicious code in both scans reads as no change, not as more", async () => {
      scans({
        "scan-1": { found: { MALICIOUS_SCRIPT: 2 }, kept: {} },
        "scan-0": { found: { MALICIOUS_SCRIPT: 2 }, kept: {} },
      });
      const data = await runLoader();
      expect(data.findingsTile).toMatchObject({ total: 2, tone: "critical" });
      expect(data.findingTrend).toEqual({ direction: "stable", previousTotal: 2 });
      expect(tileOf(renderDashboard(data)).delta).toBe("No change from last scan");
    });

    it("counts both scans the same way: 5 before (2 ignored malicious + 3), 2 now -> 3 fewer", async () => {
      scans({
        "scan-1": { found: { MALICIOUS_SCRIPT: 2 }, kept: {} },
        "scan-0": { found: { MALICIOUS_SCRIPT: 2, GHOST_SCRIPT: 3 }, kept: { GHOST_SCRIPT: 3 } },
      });
      const data = await runLoader();
      expect(data.findingTrend).toEqual({ direction: "improving", previousTotal: 5 });
      expect(tileOf(renderDashboard(data)).delta).toBe("▼ 3 fewer than last scan");
    });

    it("ignored malicious code that is new on this scan reads as more", async () => {
      scans({
        "scan-1": { found: { MALICIOUS_SCRIPT: 2 }, kept: {} },
        "scan-0": { found: {}, kept: {} },
      });
      const data = await runLoader();
      expect(data.findingTrend).toEqual({ direction: "declining", previousTotal: 0 });
      expect(tileOf(renderDashboard(data)).delta).toBe("▲ 2 more than last scan");
    });

    // gc-j8xq audit: the previous scan is read whenever the shop has ignores,
    // not only when the LATEST scan has ignored malicious code (see the
    // counterexample below).
    it("a shop with ignores: the previous scan's types are read, once", async () => {
      scans({
        "scan-1": { found: { GHOST_SCRIPT: 3 }, kept: { GHOST_SCRIPT: 2 } },
        "scan-0": { found: { GHOST_SCRIPT: 5 }, kept: { GHOST_SCRIPT: 4 } },
      });
      const data = await runLoader();
      expect(data.findingTrend).toEqual({ direction: "improving", previousTotal: 4 });
      expect(mockTypeCounts).toHaveBeenCalledTimes(2);
      expect(mockTypeCounts).toHaveBeenCalledWith("scan-1");
      expect(mockTypeCounts).toHaveBeenCalledWith("scan-0");
    });

    it("a shop with no ignores: the previous scan's types are not read", async () => {
      scans(
        {
          "scan-1": { found: { MALICIOUS_SCRIPT: 1, GHOST_SCRIPT: 2 }, kept: {} },
          "scan-0": { found: { MALICIOUS_SCRIPT: 1, GHOST_SCRIPT: 4 }, kept: {} },
        },
        false,
      );
      const data = await runLoader();
      expect(data.findingTrend).toEqual({ direction: "improving", previousTotal: 5 });
      expect(mockTypeCounts).toHaveBeenCalledTimes(1);
      expect(mockTypeCounts).toHaveBeenCalledWith("scan-1");
    });

    it("ignored malicious code only on the PREVIOUS scan: 4 before (1 ignored malicious + 3), 3 now -> 1 fewer", async () => {
      scans({
        "scan-1": { found: { GHOST_SCRIPT: 3 }, kept: { GHOST_SCRIPT: 3 } },
        "scan-0": { found: { MALICIOUS_SCRIPT: 1, GHOST_SCRIPT: 3 }, kept: { GHOST_SCRIPT: 3 } },
      });
      const data = await runLoader();
      expect(data.findingsTile).toMatchObject({ total: 3, tone: "warning" });
      expect(data.findingTrend).toEqual({ direction: "improving", previousTotal: 4 });
      expect(tileOf(renderDashboard(data)).delta).toBe("▼ 1 fewer than last scan");
    });
  });
});

// gc-14x5: an affected-app advisory is NOT known malicious code. On Home it is
// a normal finding: it never turns the findings tile critical, never raises the
// critical "Known malicious code" line, honours ignores (nothing is added
// back), and counts in its lane like any other finding.
// gc-q5z8 (Nathan, 2026-10-19): an advisory is now shown as a SECURITY RISK on
// Home (red tile, banner, red theme health verdict and failed chip). It is
// still not malicious code: no "Known malicious code" line, and it honours
// ignores. The round 2/3 tests below are updated to the new decision.
describe("Home: an affected-app advisory is a security risk, not malicious code (gc-14x5, gc-q5z8)", () => {
  type Counts = Record<string, number>;
  const sum = (c: Counts) => Object.values(c).reduce((a, b) => a + b, 0);
  const ADVISORY_FLAG = "APP_INCIDENT_ADVISORY_LIVE_ENABLED";

  // The check is live only while a list entry is unexpired, so the clock is
  // pinned to a day on which the entry is active. (A day before any real run
  // of this suite: the SHOP fixture's `installedAt` is the real clock, and a
  // pinned date after it would make the shop look long installed.)
  beforeEach(() => {
    process.env[ADVISORY_FLAG] = "true";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-11T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    delete process.env[ADVISORY_FLAG];
  });

  /** `found` = what the scan stored; `kept` = after ignores (null = no ignores). */
  function scan(found: Counts, kept: Counts | null = null) {
    (getSeverityCountsForScans as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Map([["scan-1", { HIGH: sum(found), MEDIUM: 0, LOW: 0 }]]),
    );
    mockTypeCounts.mockResolvedValue(found);
    (getIgnoredFindingsForShop as ReturnType<typeof vi.fn>).mockResolvedValue({
      fingerprints: new Set(kept ? ["fp-ignored"] : []),
      appNames: new Set(),
    });
    mockFiltered.mockImplementation(async () => ({
      summary: {
        total: sum(kept ?? found),
        bySeverity: { HIGH: sum(kept ?? found), MEDIUM: 0, LOW: 0 },
        byType: kept ?? found,
      },
      keptFindings: [],
      ignoredMalicious: 0,
    }));
  }

  function tileOf(html: string) {
    const tile = html.match(/class="health-score-tile health-score-tile--(\w+)"/);
    const number = html.match(/class="health-score-number health-score-number--(\w+)">(\d+)</);
    return { tileTone: tile?.[1], numberTone: number?.[1], total: Number(number?.[2]) };
  }

  it.each(["free", "Standard", "Professional"])(
    "%s: an advisory alone is a CRITICAL tile counting 1, labelled with its security risk",
    async (plan) => {
      setPlan(plan);
      scan({ APP_INCIDENT_ADVISORY: 1 });

      const data = await runLoader();

      expect(data.findingsTile).toEqual({ total: 1, tone: "critical", securityRisks: 1 });
      const html = renderDashboard(data);
      expect(tileOf(html)).toEqual({ tileTone: "critical", numberTone: "critical", total: 1 });
      expect(html).toContain('class="health-score-subtitle">finding, 1 security risk<');
    },
  );

  it("never raises the critical 'Known malicious code' line; theme health turns red for the advisory", async () => {
    scan({ APP_INCIDENT_ADVISORY: 1 });

    const data = await runLoader();

    expect(data.maliciousHealth).toBeNull();
    const rows = data.themeHealth as HealthRow[];
    expect(rowOf(rows, "malicious")).toMatchObject({ status: "clean", count: 0 });
    // Still in no category row (scripts stay clean); its own check failed.
    expect(rowOf(rows, "scripts-styles")).toMatchObject({ status: "clean", count: 0 });
    expect(rowOf(rows, "app-advisories")).toMatchObject({ status: "issues", count: 1 });
    const section = sectionOf(renderDashboard(data));
    expect(section).not.toContain('<s-badge tone="critical">');
    // Never the green verdict while an advisory is open.
    expect(section).not.toContain("No known malicious code found.");
    expect(verdictOf(section)).toEqual({
      tone: "critical",
      text: "An app named in a security incident is in your theme.",
    });
    expect(chipsOf(section)[0]).toEqual({
      tone: "critical",
      glyph: "\u26a0",
      prefix: "Found: ",
      label: "App security advisories",
    });
    // Malicious code is still a clean check beside it.
    expect(chipsOf(section)).toContainEqual(
      expect.objectContaining({ tone: "ok", label: "Known malicious code" }),
    );
  });

  it("an ignored advisory leaves a green zero: nothing is added back, unlike ignored malicious code", async () => {
    scan({ APP_INCIDENT_ADVISORY: 1 }, {});

    const data = await runLoader();

    expect(data.findingsTile).toMatchObject({ total: 0, tone: "success" });
    expect(tileOf(renderDashboard(data))).toMatchObject({ tileTone: "success", total: 0 });
    expect(data.maliciousHealth).toBeNull();
  });

  it("control: ignored malicious code beside it is still added back and critical", async () => {
    scan({ APP_INCIDENT_ADVISORY: 1, MALICIOUS_SCRIPT: 1 }, {});

    const data = await runLoader();

    // Only the malicious finding is added back: 1, not 2.
    expect(data.findingsTile).toMatchObject({ total: 1, tone: "critical" });
    expect(data.maliciousHealth).toMatchObject({ count: 1 });
  });

  describe("no consequence lane (round 2)", () => {
    type LaneData = {
      laneSummary: Array<{ lane: string; label: string; count: number }>;
      dominant: string | null;
      startHere: string | null;
      findingsTile: { total: number; tone: string };
    };

    it("an advisory alone: no lane rows, no dominant lane, no start-here lane; the tile still counts it", async () => {
      scan({ APP_INCIDENT_ADVISORY: 1 });

      const data = (await runLoader()) as unknown as LaneData;

      expect(data.laneSummary).toEqual([]);
      expect(data.dominant).toBeNull();
      expect(data.startHere).toBeNull();
      expect(data.findingsTile).toMatchObject({ total: 1, tone: "critical" });
    });

    it("an advisory alone renders no lanes card, no 'all clear', and none of the lane copy", async () => {
      scan({ APP_INCIDENT_ADVISORY: 1 });

      const html = renderDashboard(await runLoader());

      expect(html).not.toContain("You&#x27;re all clear");
      expect(html).not.toContain("No leftover code found. Your theme is clean.");
      expect(html).not.toContain("What it&#x27;s costing you");
      expect(html).not.toContain("Most of the damage is in");
      expect(html).not.toContain("Still tracking you");
      expect(html).not.toContain("A removed app is still collecting");
      expect(html).not.toMatch(/leftover items? from apps you/);
    });

    it("an advisory beside other findings: the lanes count only the others", async () => {
      scan({ APP_INCIDENT_ADVISORY: 1, GHOST_SCRIPT: 2 });

      const data = (await runLoader()) as unknown as LaneData;

      expect(data.laneSummary).toEqual([
        expect.objectContaining({ lane: "speed", label: "Speed", count: 2 }),
      ]);
      expect(data.dominant).toBe("speed");
      // The tile counts all three, and is red (gc-q5z8).
      expect(data.findingsTile).toMatchObject({ total: 3, tone: "critical", securityRisks: 1 });

      const html = renderDashboard(data);
      expect(html).toContain("What it&#x27;s costing you");
      // "leftover items" counts the laned findings only: 2, not 3.
      expect(html).toContain("1 app security advisory, 2 leftover items.");
      expect(html).not.toMatch(/3 leftover items/);
      expect(html).toContain("(2 findings)");
      expect(html).not.toContain("Still tracking you");
    });

    it("an advisory beside one privacy-lane finding does not inflate that lane", async () => {
      scan({ APP_INCIDENT_ADVISORY: 1, GHOST_PIXEL: 1 });

      const data = (await runLoader()) as unknown as LaneData;

      expect(data.laneSummary).toEqual([expect.objectContaining({ lane: "privacy", count: 1 })]);
      expect(renderDashboard(data)).toContain("1 app security advisory, 1 leftover item.");
    });

    const ADVISORY_ROW = {
      id: "adv",
      scanId: "scan-1",
      findingType: "APP_INCIDENT_ADVISORY",
      severity: "HIGH",
      filename: "layout/theme.liquid",
      lineNumber: 42,
      appName: null,
      codeSnippet: '<script src="https://productoption.hulkapps.com/hulkcode.js"></script>',
      description: "Loads code from Hulk Product Options",
      createdAt: new Date("2026-10-12T10:00:00Z"),
    };

    it("Start here leads with the advisory; the lanes' own 'start here' chip falls back to the lane ranking", async () => {
      scan({ APP_INCIDENT_ADVISORY: 1, GHOST_SCRIPT: 2 });
      (getFreeTopFindings as ReturnType<typeof vi.fn>).mockResolvedValue([ADVISORY_ROW]);

      const data = (await runLoader()) as unknown as LaneData & {
        topFindings: Array<{ id: string; lane: string | null; cost: string; href: string }>;
      };

      expect(data.topFindings).toEqual([
        expect.objectContaining({
          id: "adv",
          lane: null,
          typeLabel: "App Security Advisories",
          location: "layout/theme.liquid, line 42",
          // gc-q5z8: neutral for a description no entry produces.
          cost: "A security incident report names this app.",
          href: "/app/scans/scan-1#finding-adv",
        }),
      ]);
      // The advisory has no lane, so the chip goes to the most urgent real lane.
      expect(data.startHere).toBe("speed");
    });

    it("the Start here row renders its label, location, cost line and link, and no lane wording", async () => {
      scan({ APP_INCIDENT_ADVISORY: 1 });
      (getFreeTopFindings as ReturnType<typeof vi.fn>).mockResolvedValue([ADVISORY_ROW]);

      const data = (await runLoader()) as unknown as LaneData;
      const html = renderDashboard(data);
      const start = html.indexOf('<section aria-labelledby="top-findings-heading"');
      const block = html.slice(start, html.indexOf("</section>", start));

      expect(data.startHere).toBeNull();
      // Round 3: the card's headline, not the type label (gc-q5z8: neutral
      // for a description no list entry produces).
      expect(block).toContain(">An app in your theme was named in a security incident report</h3>");
      expect(block).not.toContain("App Security Advisories");
      // gc-g034: one finding, so its severity is said once in the intro, and
      // the card is a red "Security risk" card (it has no lane).
      expect(block).toContain("Fix this first. It&#x27;s high severity.");
      expect(block).not.toContain("<s-badge");
      expect(block).toContain(">Security risk</span>");
      expect(block).toContain("layout/theme.liquid, line 42");
      expect(block).toContain("A security incident report names this app.");
      expect(block).toMatch(
        /<a aria-label="See what to check: An app in your theme was named in a security incident report, layout\/theme\.liquid, line 42"[^>]*href="\/app\/scans\/scan-1#finding-adv"[^>]*><s-button variant="secondary">See what to check<\/s-button><\/a>/,
      );
      expect(block).not.toContain("See how to fix");
      expect(block).not.toMatch(/Still tracking you|removed app|leftover|malicious/i);
    });

    it("control: a truly clean scan still says all clear", async () => {
      scan({});

      const html = renderDashboard(await runLoader());

      expect(html).toContain("You&#x27;re all clear");
      expect(html).toContain("No leftover code found. Your theme is clean.");
    });

    it("an ignored advisory alone is a clean scan again: all clear", async () => {
      scan({ APP_INCIDENT_ADVISORY: 1 }, {});

      const html = renderDashboard(await runLoader());

      expect(html).toContain("You&#x27;re all clear");
    });
  });

  it("FLIPPING THE FLAG changes no category row for a scan taken before the flip; only the advisory check appears, Not checked", async () => {
    // The scan recorded its live set BEFORE the flip: the advisory type is not
    // in it. Off, then on: the category rows must be identical, and the
    // scripts row must not turn into "None found ... Run a new scan". The one
    // difference (gc-q5z8) is the App security advisories check: absent while
    // the check is dark, "Not checked" once it is live (a new scan runs it).
    const liveBefore = Object.values(FindingType).filter((t) => t !== "APP_INCIDENT_ADVISORY");
    mockScans.mockResolvedValue({
      items: [{ ...SCAN, liveFindingTypes: liveBefore }],
      hasNextPage: false,
    });
    scan({ GHOST_PIXEL: 1 });

    delete process.env[ADVISORY_FLAG];
    const off = await runLoader();
    process.env[ADVISORY_FLAG] = "true";
    const on = await runLoader();

    // Non-vacuous: the flag really is read differently in the two loads.
    expect(isSoftLaunchLive(FindingType.APP_INCIDENT_ADVISORY)).toBe(true);
    const categories = (rows: unknown) =>
      (rows as HealthRow[]).filter((r) => r.key !== "app-advisories");
    expect(categories(on.themeHealth)).toEqual(categories(off.themeHealth));
    expect(rowOf(off.themeHealth as HealthRow[], "app-advisories")).toBeUndefined();
    expect(rowOf(on.themeHealth as HealthRow[], "app-advisories")).toMatchObject({
      status: "not_checked",
      detail: "Not checked on your last scan. Run a new scan to try again.",
    });
    expect(rowOf(on.themeHealth as HealthRow[], "scripts-styles")).toMatchObject({
      status: "clean",
      statusLabel: "Clean",
      detail: null,
    });
    expect(sectionOf(renderDashboard(off))).not.toContain("Not checked on your last scan");
    expect(sectionOf(renderDashboard(off))).not.toContain("App security advisories");
  });

  it("gc-q5z8: a scan that ran the live advisory check and found nothing shows a green advisory chip", async () => {
    scan({ GHOST_PIXEL: 1 });

    const data = await runLoader();

    expect(rowOf(data.themeHealth as HealthRow[], "app-advisories")).toMatchObject({
      status: "clean",
    });
    expect(chipsOf(sectionOf(renderDashboard(data)))).toContainEqual(
      expect.objectContaining({ tone: "ok", label: "App security advisories" }),
    );
  });

  describe("Security risk banner at the top of Home (gc-q5z8)", () => {
    const SELLEASY = APP_INCIDENT_ADVISORIES.find((a) => a.appName === "Selleasy")!;
    const SELLEASY_ROW = {
      id: "adv-sell",
      scanId: "scan-1",
      findingType: "APP_INCIDENT_ADVISORY",
      severity: "HIGH",
      filename: "config/settings_data.json",
      lineNumber: 1,
      appName: null,
      codeSnippet: '"x": {"type": "shopify://apps/selleasy/blocks/app-embed/1", "disabled": false}',
      description: advisoryDescription({
        advisory: SELLEASY,
        embedHandle: "shopify://apps/selleasy/blocks/app-embed",
      }),
      createdAt: new Date("2026-10-11T10:00:00Z"),
    };
    const serve = (rows: Array<typeof SELLEASY_ROW>) =>
      (getFindingsForScan as ReturnType<typeof vi.fn>).mockImplementation(
        async (_id: string, f?: { findingType?: string }) =>
          rows.filter((r) => !f?.findingType || r.findingType === f.findingType),
      );
    const bannerOf = (html: string) => {
      const start = html.indexOf('<section aria-labelledby="finding-');
      return start === -1 ? "" : html.slice(start, html.indexOf("</section>", start));
    };

    it.each(["free", "Standard", "Professional"])(
      "%s: the banner is first on the ground, names the app and links to the scan page's banner",
      async (plan) => {
        setPlan(plan);
        scan({ APP_INCIDENT_ADVISORY: 1, GHOST_SCRIPT: 2 });
        serve([SELLEASY_ROW]);

        const data = await runLoader();
        const html = renderDashboard(data);
        const banner = bannerOf(html);

        expect(
          (data as unknown as { securityRisks: Array<{ appName: string }> }).securityRisks,
        ).toEqual([expect.objectContaining({ kind: "advisory", appName: "Selleasy" })]);
        expect(banner).toContain(
          "Selleasy is in your theme, and its developer reported a security incident",
        );
        expect(banner).toContain("sent shoppers to a phishing page");
        expect(banner).not.toContain("fake checkout");
        expect(banner).toMatch(
          /<a href="\/app\/scans\/scan-1#finding-adv-sell"[^>]*><s-button variant="primary">See what to check<\/s-button><\/a>/,
        );
        expect(banner).toContain("shown on every plan");
        // At the very top: before the findings tile and everything else.
        expect(html.indexOf(banner)).toBeLessThan(html.indexOf('health-score-tile--critical"'));
        expect(html.indexOf(banner)).toBeLessThan(html.indexOf("Start here"));
      },
    );

    it("an ignored advisory: no banner, no read", async () => {
      scan({ APP_INCIDENT_ADVISORY: 1, GHOST_SCRIPT: 2 }, { GHOST_SCRIPT: 2 });
      serve([SELLEASY_ROW]);

      const data = await runLoader();

      expect((data as unknown as { securityRisks: unknown[] }).securityRisks).toEqual([]);
      expect(renderDashboard(data)).not.toContain(">Security risk<");
      expect(getFindingsForScan).not.toHaveBeenCalled();
    });

    it("no security risk: no banner and no read", async () => {
      scan({ GHOST_SCRIPT: 2 });

      const data = await runLoader();

      expect((data as unknown as { securityRisks: unknown[] }).securityRisks).toEqual([]);
      expect(getFindingsForScan).not.toHaveBeenCalled();
    });

    it("a failed read never takes Home down: no banner, the tile and theme health still say it", async () => {
      scan({ APP_INCIDENT_ADVISORY: 1 });
      (getFindingsForScan as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db down"));

      const data = await runLoader();

      expect((data as unknown as { securityRisks: unknown[] }).securityRisks).toEqual([]);
      expect(data.findingsTile).toMatchObject({ tone: "critical", securityRisks: 1 });
      expect(rowOf(data.themeHealth as HealthRow[], "app-advisories")?.status).toBe("issues");
    });

    it("Free: the Start here row names the app with its own wording (the preview is untouched)", async () => {
      setPlan("free");
      scan({ APP_INCIDENT_ADVISORY: 1, GHOST_SCRIPT: 2 });
      serve([SELLEASY_ROW]);
      (getFreeTopFindings as ReturnType<typeof vi.fn>).mockResolvedValue([SELLEASY_ROW]);

      const data = (await runLoader()) as unknown as {
        topFindings: Array<{ title?: string; cost: string; location: string }>;
      };

      expect(data.topFindings[0]).toMatchObject({
        title: "Selleasy is in your theme and was named in a security incident",
        location: "config/settings_data.json · app embed turned on",
      });
      expect(data.topFindings[0].cost).toContain("phishing page");
    });
  });

  // gc-q5z8: the summary line replaces round 3's "N app security advisories
  // to review" link (and the leftover-items lead while a risk is present).
  // gc-5nok: APP_INCIDENT_ADVISORY_LIVE_ENABLED is the kill switch for what
  // is already stored, too. Runs the REAL ignore-aggregation choke point.
  describe("kill switch: flag off hides a stored advisory everywhere on Home (gc-5nok)", () => {
    const SELLEASY = APP_INCIDENT_ADVISORIES.find((a) => a.appName === "Selleasy")!;
    const base = {
      scanId: "scan-1",
      severity: "HIGH",
      lineNumber: 1,
      createdAt: new Date("2026-10-11T10:00:00Z"),
    };
    const ROWS = [
      {
        ...base,
        id: "adv-sell",
        findingType: "APP_INCIDENT_ADVISORY",
        filename: "config/settings_data.json",
        appName: null,
        codeSnippet: "shopify://apps/selleasy/blocks/app-embed\n{}",
        description: advisoryDescription({
          advisory: SELLEASY,
          embedHandle: "shopify://apps/selleasy/blocks/app-embed",
        }),
      },
      ...[1, 2].map((i) => ({
        ...base,
        id: `s${i}`,
        findingType: "GHOST_SCRIPT",
        filename: `snippets/s${i}.liquid`,
        appName: "OldApp",
        codeSnippet: `<script src="https://old.example/${i}.js"></script>`,
        description: "Leftover script",
      })),
    ];

    beforeEach(async () => {
      scan({ APP_INCIDENT_ADVISORY: 1, GHOST_SCRIPT: 2 });
      const real = await vi.importActual<
        typeof import("../../app/services/finding-aggregation.server")
      >("../../app/services/finding-aggregation.server");
      mockFiltered.mockImplementation(real.getFilteredFindingSummaryAndKept as never);
      (getFindingSummary as ReturnType<typeof vi.fn>).mockResolvedValue({
        total: 3,
        bySeverity: { HIGH: 3, MEDIUM: 0, LOW: 0 },
        byType: { APP_INCIDENT_ADVISORY: 1, GHOST_SCRIPT: 2 },
      });
      (getFindingsForScan as ReturnType<typeof vi.fn>).mockImplementation(
        async (_id: string, f?: { findingType?: string }) =>
          ROWS.filter((r) => !f?.findingType || r.findingType === f.findingType),
      );
    });

    type KillData = {
      securityRisks: unknown[];
      advisoryCount: number;
      findingsTile: { total: number; tone: string; securityRisks: number };
      themeHealth: HealthRow[];
    };

    it.each(["free", "Standard", "Professional"])(
      "%s: no banner, tile not critical and not counting it, no chip, no red verdict, no line, not in Start here",
      async (plan) => {
        setPlan(plan);
        delete process.env[ADVISORY_FLAG];

        const data = (await runLoader()) as unknown as KillData;
        const html = renderDashboard(data);
        const section = sectionOf(html);

        expect(data.securityRisks).toEqual([]);
        expect(html).not.toContain(">Security risk<");
        expect(html).not.toContain("Selleasy");
        expect(data.advisoryCount).toBe(0);
        expect(data.findingsTile.total).toBe(2);
        expect(data.findingsTile.securityRisks).toBe(0);
        expect(data.findingsTile.tone).not.toBe("critical");
        expect(tileOf(html).tileTone).not.toBe("critical");
        expect(html).not.toMatch(/security risk|app security advisor/i);
        expect(rowOf(data.themeHealth, "app-advisories")).toBeUndefined();
        expect(chipsOf(section).map((c) => c.label)).not.toContain("App security advisories");
        expect(verdictOf(section)?.text).not.toBe(
          "An app named in a security incident is in your theme.",
        );
        // Start here ranks from the kept rows, which leave the advisory out.
        const topCalls = [
          ...(getFullListTopFindings as ReturnType<typeof vi.fn>).mock.calls,
          ...(getFreeTopFindings as ReturnType<typeof vi.fn>).mock.calls,
        ];
        expect(topCalls).toHaveLength(1);
        const kept = topCalls[0].find(Array.isArray) as Array<{ id: string }>;
        expect(kept.map((r) => r.id)).toEqual(["s1", "s2"]);
      },
    );

    it("flag on: the same stored rows are a security risk, unchanged", async () => {
      const data = (await runLoader()) as unknown as KillData;
      const html = renderDashboard(data);

      expect(data.securityRisks).toEqual([
        expect.objectContaining({ kind: "advisory", appName: "Selleasy" }),
      ]);
      expect(data.findingsTile).toEqual({ total: 3, tone: "critical", securityRisks: 1 });
      expect(rowOf(data.themeHealth, "app-advisories")?.status).toBe("issues");
      expect(html).toContain("1 app security advisory, 2 leftover items.");
      // No ignores and the flag on: the lean path, no full read for counts.
      expect(mockFiltered).not.toHaveBeenCalled();
    });
  });

  // gc-7gjj.1 audit fix: MENU_INJECTION_LIVE_ENABLED is the read-time kill
  // switch for stored menu findings, like the advisory flag above. Runs the
  // REAL ignore-aggregation choke point.
  describe("kill switch: flag off hides a stored menu finding everywhere on Home (gc-7gjj.1)", () => {
    const MENU_FLAG = "MENU_INJECTION_LIVE_ENABLED";
    const base = {
      scanId: "scan-1",
      severity: "HIGH",
      lineNumber: 0,
      createdAt: new Date("2026-10-11T10:00:00Z"),
    };
    const ROWS = [
      {
        ...base,
        id: "menu-1",
        findingType: "MENU_INJECTION",
        filename: "menus/1/items/2/0badc0de",
        appName: null,
        codeSnippet: "Main menu > Shop\nLabel: Shop<img src=x onerror=alert(1)>",
        description: "A menu item's label contains code that runs when the label is shown.",
      },
      ...[1, 2].map((i) => ({
        ...base,
        id: `s${i}`,
        findingType: "GHOST_SCRIPT",
        filename: `snippets/s${i}.liquid`,
        appName: "OldApp",
        codeSnippet: `<script src="https://old.example/${i}.js"></script>`,
        description: "Leftover script",
      })),
    ];

    beforeEach(async () => {
      scan({ MENU_INJECTION: 1, GHOST_SCRIPT: 2 });
      const real = await vi.importActual<
        typeof import("../../app/services/finding-aggregation.server")
      >("../../app/services/finding-aggregation.server");
      mockFiltered.mockImplementation(real.getFilteredFindingSummaryAndKept as never);
      (getFindingSummary as ReturnType<typeof vi.fn>).mockResolvedValue({
        total: 3,
        bySeverity: { HIGH: 3, MEDIUM: 0, LOW: 0 },
        byType: { MENU_INJECTION: 1, GHOST_SCRIPT: 2 },
      });
      (getFindingsForScan as ReturnType<typeof vi.fn>).mockImplementation(
        async (_id: string, f?: { findingType?: string }) =>
          ROWS.filter((r) => !f?.findingType || r.findingType === f.findingType),
      );
    });
    afterEach(() => {
      delete process.env[MENU_FLAG];
    });

    type KillData = {
      securityRisks: unknown[];
      findingsTile: { total: number; tone: string; securityRisks: number };
    };

    it.each(["free", "Standard", "Professional"])(
      "%s, flag off: no menu banner, tile not counting it, not in Start here",
      async (plan) => {
        setPlan(plan);
        delete process.env[MENU_FLAG];

        const data = (await runLoader()) as unknown as KillData;
        const html = renderDashboard(data);

        expect(data.securityRisks).toEqual([]);
        expect(html).not.toContain("onerror");
        expect(html).not.toContain("Main menu &gt; Shop");
        expect(data.findingsTile.total).toBe(2);
        expect(data.findingsTile.securityRisks).toBe(0);
        expect(data.findingsTile.tone).not.toBe("critical");
        const topCalls = [
          ...(getFullListTopFindings as ReturnType<typeof vi.fn>).mock.calls,
          ...(getFreeTopFindings as ReturnType<typeof vi.fn>).mock.calls,
        ];
        expect(topCalls).toHaveLength(1);
        const kept = topCalls[0].find(Array.isArray) as Array<{ id: string }>;
        expect(kept.map((r) => r.id)).toEqual(["s1", "s2"]);
      },
    );

    it("flag on: the same stored row is a security risk", async () => {
      process.env[MENU_FLAG] = "true";
      const data = (await runLoader()) as unknown as KillData;

      expect(data.securityRisks).toEqual([
        expect.objectContaining({
          kind: "menu",
          items: [expect.objectContaining({ menuPath: "Main menu > Shop" })],
        }),
      ]);
      expect(data.findingsTile).toEqual({ total: 3, tone: "critical", securityRisks: 1 });
    });
  });

  describe("top card: one summary line for security risks (gc-q5z8)", () => {
    const topCard = (html: string) => {
      const start = html.indexOf('<div class="health-read">');
      return start === -1 ? "" : html.slice(start, html.indexOf("</div></div></div>", start));
    };
    const SEE_ALL = /<a[^>]*href="\/app\/scans\/scan-1"[^>]*>See all<\/a>/;

    it("an advisory alone: the card holds the one line and See all", async () => {
      scan({ APP_INCIDENT_ADVISORY: 1 });

      const data = await runLoader();
      const card = topCard(renderDashboard(data));

      expect((data as unknown as { advisoryCount: number }).advisoryCount).toBe(1);
      expect(card).toContain("1 app security advisory.");
      expect(card).toMatch(SEE_ALL);
      // Nothing else in the read: no damage line, no leftover sentence.
      expect(card).not.toContain("Most of the damage is in");
      expect(card).not.toMatch(/leftover item/);
    });

    it("two advisories pluralise", async () => {
      scan({ APP_INCIDENT_ADVISORY: 2 });

      expect(topCard(renderDashboard(await runLoader()))).toContain("2 app security advisories.");
    });

    it("beside other findings: one line, and its parts account for the tile", async () => {
      scan({ APP_INCIDENT_ADVISORY: 1, GHOST_SCRIPT: 2 });

      const data = await runLoader();
      const card = topCard(renderDashboard(data));

      expect(data.findingsTile).toMatchObject({ total: 3, tone: "critical" });
      expect(card).toContain("1 app security advisory, 2 leftover items.");
      expect(card).toMatch(SEE_ALL);
      expect(card).not.toMatch(/leftover items from apps you/);
    });

    it("kept and ignored malicious code beside an advisory are named once each", async () => {
      scan(
        { APP_INCIDENT_ADVISORY: 1, MALICIOUS_SCRIPT: 2, GHOST_SCRIPT: 1 },
        { APP_INCIDENT_ADVISORY: 1, MALICIOUS_SCRIPT: 1, GHOST_SCRIPT: 1 },
      );

      const data = await runLoader();

      // Tile: 3 kept + 1 ignored malicious added back = 4 = 2 + 1 + 1.
      expect(data.findingsTile).toMatchObject({ total: 4, securityRisks: 3 });
      expect(topCard(renderDashboard(data))).toContain(
        "2 pieces of known malicious code, 1 app security advisory, 1 leftover item.",
      );
    });

    it("an ignored advisory: no line", async () => {
      scan({ APP_INCIDENT_ADVISORY: 1 }, {});

      const data = await runLoader();

      expect((data as unknown as { advisoryCount: number }).advisoryCount).toBe(0);
      expect(renderDashboard(data)).not.toMatch(/app security advisor/);
    });

    it("no advisory: no line (unchanged card)", async () => {
      scan({ GHOST_SCRIPT: 2 });

      expect(renderDashboard(await runLoader())).not.toMatch(/app security advisor/);
    });

    // tile = leftover items + advisories + ignored malicious code added back.
    it.each([
      ["advisory only", { APP_INCIDENT_ADVISORY: 1 }, null, 0, 1, 1],
      ["advisory + 2 scripts", { APP_INCIDENT_ADVISORY: 1, GHOST_SCRIPT: 2 }, null, 2, 1, 3],
      [
        "2 advisories + pixel + 4 orphans",
        { APP_INCIDENT_ADVISORY: 2, GHOST_PIXEL: 1, ORPHAN_ASSET: 4 },
        null,
        5,
        2,
        7,
      ],
      [
        "advisory + ignored script",
        { APP_INCIDENT_ADVISORY: 1, GHOST_SCRIPT: 2 },
        { APP_INCIDENT_ADVISORY: 1, GHOST_SCRIPT: 1 },
        1,
        1,
        2,
      ],
      [
        "advisory + 2 ignored malicious",
        { APP_INCIDENT_ADVISORY: 1, MALICIOUS_SCRIPT: 2 },
        { APP_INCIDENT_ADVISORY: 1 },
        0,
        1,
        3,
      ],
      [
        "ignored advisory + script",
        { APP_INCIDENT_ADVISORY: 1, GHOST_SCRIPT: 1 },
        { GHOST_SCRIPT: 1 },
        1,
        0,
        1,
      ],
    ] as Array<[string, Counts, Counts | null, number, number, number]>)(
      "tile arithmetic on Home, %s",
      async (_label, found, kept, leftover, advisories, tileTotal) => {
        scan(found, kept);

        const data = (await runLoader()) as unknown as {
          laneSummary: Array<{ count: number }>;
          advisoryCount: number;
          findingsTile: { total: number };
        };

        const laned = data.laneSummary.reduce((n, row) => n + row.count, 0);
        expect(laned).toBe(leftover);
        expect(data.advisoryCount).toBe(advisories);
        expect(data.findingsTile.total).toBe(tileTotal);
        const addBack = (found.MALICIOUS_SCRIPT ?? 0) - ((kept ?? found).MALICIOUS_SCRIPT ?? 0);
        expect(data.findingsTile.total).toBe(laned + data.advisoryCount + addBack);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Home's scan control: the plan's manual-scan limit (gc-d0ui)
// ---------------------------------------------------------------------------

describe("Home scan control: manual-scan limit copy (gc-d0ui)", () => {
  /** The "New Scan" card of a rendered Home. */
  function scanCardOf(html: string): string {
    const start = html.indexOf("<s-heading>New Scan</s-heading>");
    expect(start).toBeGreaterThan(-1);
    return html.slice(start, html.indexOf("<s-heading>Scan History</s-heading>", start));
  }

  function usage(used: number, limit: number, period: "day" | "week" | "month", start: string) {
    (getScanUsage as ReturnType<typeof vi.fn>).mockResolvedValue({
      used,
      limit,
      period,
      periodStart: new Date(start),
    });
  }

  it("Professional under the cap: 'N of 5 used today', no upgrade link, never 'Unlimited scans'", async () => {
    setPlan("Professional");
    (canUseMultipleThemes as ReturnType<typeof vi.fn>).mockReturnValue(true);
    usage(4, 5, "day", "2026-10-19T00:00:00Z");

    const card = scanCardOf(renderDashboard(await runLoader()));

    expect(card).toContain("4 of 5 used today");
    expect(card).not.toMatch(/unlimited/i);
    expect(card).not.toContain("Upgrade for more scans");
    expect(card).not.toMatch(/<s-button[^>]*disabled/);
  });

  it("Professional at the cap: disabled, the next-available time, and no upsell", async () => {
    setPlan("Professional");
    (canUseMultipleThemes as ReturnType<typeof vi.fn>).mockReturnValue(true);
    usage(5, 5, "day", "2026-10-19T00:00:00Z");

    const data = await runLoader();
    expect(data.scanUsage).toEqual({
      used: 5,
      limit: 5,
      period: "day",
      nextScanAt: "2026-10-20T00:00:00.000Z",
    });
    const card = scanCardOf(renderDashboard(data));

    expect(card).toContain("5 of 5 used today");
    expect(card).toMatch(
      /Your next scan is available <time[^>]*dateTime="2026-10-20T00:00:00.000Z"/,
    );
    expect(card).toMatch(/<s-button[^>]*disabled/);
    expect(card).not.toMatch(/upgrade|unlimited/i);
    expect(card).not.toContain('href="/app/settings"');
  });

  it("Standard at the weekly cap keeps its 'Upgrade for more scans' link", async () => {
    setPlan("Standard");
    usage(1, 1, "week", "2026-10-19T00:00:00Z");

    const card = scanCardOf(renderDashboard(await runLoader()));

    expect(card).toContain("1 of 1 used this week");
    expect(card).toContain("Upgrade for more scans");
    expect(card).not.toContain("Your next scan is available");
  });

  it("Free at the monthly cap: 'used this month' and the upgrade link", async () => {
    setPlan("free");
    usage(1, 1, "month", "2026-10-01T00:00:00Z");

    const card = scanCardOf(renderDashboard(await runLoader()));

    expect(card).toContain("1 of 1 used this month");
    expect(card).toContain("Upgrade for more scans");
  });
});

// gc-3y89 item 10: Home's homepage-aware wording, through the real loader and
// the rendered Dashboard (the lib tests cover the copy; this pins the wiring).
describe("Home: known malicious code seen on the live homepage (gc-0htk, gc-3y89 #10)", () => {
  const BILIING = KNOWN_MALICIOUS_DOMAINS.find((d) => d.domain === "biliing.top")!;
  const HOMEPAGE_ROW = {
    id: "mal-home",
    scanId: "scan-1",
    findingType: "MALICIOUS_SCRIPT",
    severity: "HIGH",
    filename: "storefront/homepage",
    lineNumber: 0,
    appName: null,
    codeSnippet: "biliing.top\nLoaded by a script tag an app added: www.biliing.top",
    description: homepageMaliciousDescription(BILIING),
    createdAt: new Date("2026-10-11T10:00:00Z"),
  };
  const THEME_ROW = {
    ...HOMEPAGE_ROW,
    id: "mal-theme",
    filename: "layout/theme.liquid",
    lineNumber: 12,
    codeSnippet: '<script src="https://biliing.top/x.js"></script>',
    description: maliciousDescription(BILIING),
  };
  const HOMEPAGE_DETAIL =
    "1 piece of code from a known malicious source was found in your theme or on your live homepage. It can steal shopper data or send your customers to other sites.";
  const THEME_DETAIL =
    "1 piece of code from a known malicious source is in your theme. It can steal shopper data or send your customers to other sites.";

  function serveMalicious(rows: Array<typeof HOMEPAGE_ROW>) {
    const found = { ...TYPE_COUNTS, MALICIOUS_SCRIPT: rows.length };
    mockTypeCounts.mockResolvedValue(found);
    (getIgnoredFindingsForShop as ReturnType<typeof vi.fn>).mockResolvedValue({
      fingerprints: new Set(),
      appNames: new Set(),
    });
    mockFiltered.mockResolvedValue({
      summary: {
        total: 7 + rows.length,
        bySeverity: { HIGH: 3, MEDIUM: 3, LOW: 1 },
        byType: found,
      },
      keptFindings: [],
      ignoredMalicious: 0,
    });
    (getFindingsForScan as ReturnType<typeof vi.fn>).mockImplementation(
      async (_id: string, f?: { findingType?: string }) =>
        rows.filter((r) => !f?.findingType || r.findingType === f.findingType),
    );
  }

  it.each(["free", "Standard", "Professional"])(
    "%s: a homepage hit never reads as 'in your theme', in the loader and on the page",
    async (plan) => {
      setPlan(plan);
      serveMalicious([HOMEPAGE_ROW]);
      const data = await runLoader();
      expect(data.maliciousHealth?.detail).toBe(HOMEPAGE_DETAIL);
      const html = renderDashboard(data);
      expect(sectionOf(html)).toContain(HOMEPAGE_DETAIL);
      expect(html).toContain(
        "Your live homepage uses biliing.top, a domain linked to malicious code",
      );
      expect(html).not.toContain("Your theme references biliing.top");
      expect(html).not.toContain("is in your theme. It can steal");
    },
  );

  it("a theme-file hit keeps the theme wording", async () => {
    setPlan("Standard");
    serveMalicious([THEME_ROW]);
    const data = await runLoader();
    expect(data.maliciousHealth?.detail).toBe(THEME_DETAIL);
    const html = renderDashboard(data);
    expect(sectionOf(html)).toContain(THEME_DETAIL);
    expect(html).toContain("Your theme references biliing.top, a domain linked to malicious code");
    expect(html).not.toContain("on your live homepage. It can steal");
  });
});

// gc-xtno items 2 and 3: Home's security risks during a rescan, and their unit.
describe("Home: security risks never vanish during a rescan, and count per banner (gc-xtno)", () => {
  const BILIING = KNOWN_MALICIOUS_DOMAINS.find((d) => d.domain === "biliing.top")!;
  const POLYFILL = KNOWN_MALICIOUS_DOMAINS.find((d) => d.domain === "polyfill.io")!;
  const line = (id: string, scanId: string, n: number, domain = BILIING) => ({
    id,
    scanId,
    findingType: "MALICIOUS_SCRIPT",
    severity: "HIGH",
    filename: "layout/theme.liquid",
    lineNumber: n,
    appName: null,
    codeSnippet: `<script src="https://${domain.domain}/x.js"></script>`,
    description: maliciousDescription(domain),
    createdAt: new Date("2026-10-11T10:00:00Z"),
  });
  /** Three lines on one domain in scan-1. */
  const THREE_LINES = [
    line("m1", "scan-1", 10),
    line("m2", "scan-1", 20),
    line("m3", "scan-1", 30),
  ];
  const RUNNING = {
    ...SCAN,
    id: "scan-2",
    status: "IN_PROGRESS",
    completedAt: null,
    createdAt: new Date("2026-10-19T09:00:00Z"),
    viewedOnHomeAt: null,
  };
  type Rows = ReturnType<typeof line>[];

  /** Serve `rows` per scan; `ignoredMalicious` lines of scan-1 are ignored. */
  function serve(rows: Rows, ignoredMalicious = 0) {
    const malicious = rows.filter((r) => r.scanId === "scan-1").length;
    const found = { ...TYPE_COUNTS, MALICIOUS_SCRIPT: malicious };
    const kept = { ...found, MALICIOUS_SCRIPT: malicious - ignoredMalicious };
    mockTypeCounts.mockResolvedValue(found);
    (getSeverityCountsForScans as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Map([["scan-1", { HIGH: 3 + malicious, MEDIUM: 3, LOW: 1 }]]),
    );
    (getIgnoredFindingsForShop as ReturnType<typeof vi.fn>).mockResolvedValue({
      fingerprints: new Set(ignoredMalicious > 0 ? ["fp-ignored"] : []),
      appNames: new Set(),
    });
    mockFiltered.mockImplementation(async (id: string) => ({
      summary: {
        total: id === "scan-1" ? 7 + malicious - ignoredMalicious : 0,
        bySeverity: { HIGH: 3 + malicious - ignoredMalicious, MEDIUM: 3, LOW: 1 },
        byType: id === "scan-1" ? kept : {},
      },
      keptFindings: ignoredMalicious > 0 ? [] : null,
      ignoredMalicious: id === "scan-1" ? ignoredMalicious : 0,
    }));
    (getFindingsForScan as ReturnType<typeof vi.fn>).mockImplementation(
      async (id: string, f?: { findingType?: string }) =>
        rows.filter((r) => r.scanId === id && (!f?.findingType || r.findingType === f.findingType)),
    );
  }

  type Data = {
    securityRisks: Array<{ kind: string; domain?: string; findings?: unknown[] }>;
    securityRiskSource: { scanId: string; scanDate: Date; earlierScan: string | null } | null;
    findingsTile: { total: number; tone: string; securityRisks: number } | null;
  };
  const load = async () => (await runLoader()) as unknown as Data;

  describe("item 3: 'k security risks' counts banners, not lines", () => {
    it.each(["free", "Standard", "Professional"])(
      "%s: three lines on one domain are 1 banner and '1 security risk'",
      async (plan) => {
        setPlan(plan);
        serve(THREE_LINES);

        const data = await load();
        const html = renderDashboard(data);

        expect(data.securityRisks).toHaveLength(1);
        expect(data.securityRisks[0].findings).toHaveLength(3);
        expect(data.findingsTile).toMatchObject({ tone: "critical", securityRisks: 1 });
        expect(html).toContain('class="health-score-subtitle">findings, 1 security risk<');
        expect(html).not.toContain("3 security risks");
        // The per-line detail stays inside the banner.
        expect(html).toContain("on 3 lines of your theme");
      },
    );

    it("two domains are 2 security risks", async () => {
      serve([...THREE_LINES, line("p1", "scan-1", 40, POLYFILL)]);

      const data = await load();

      expect(data.securityRisks).toHaveLength(2);
      expect(data.findingsTile).toMatchObject({ securityRisks: 2 });
      expect(renderDashboard(data)).toContain("findings, 2 security risks<");
    });
  });

  describe("item 2: a rescan never hides them", () => {
    it.each(["free", "Standard", "Professional"])(
      "%s: while a scan runs, the banners are the last completed scan's, dated and linked to it",
      async (plan) => {
        setPlan(plan);
        serve(THREE_LINES);
        mockScans.mockResolvedValue({ items: [RUNNING, SCAN], hasNextPage: false });

        const data = await load();
        const html = renderDashboard(data);

        expect(data.securityRisks).toEqual([
          expect.objectContaining({ kind: "malicious", domain: "biliing.top" }),
        ]);
        expect(data.securityRiskSource).toEqual({
          scanId: "scan-1",
          scanDate: SCAN.completedAt,
          earlierScan: "running",
        });
        // The previous scan is the fallback: no extra scan read.
        expect(getCompletedScansForShop).not.toHaveBeenCalledWith(SHOP.id, { limit: 1 });
        expect(html).toContain("Scanning your theme...");
        expect(html).toContain(
          "Your theme references biliing.top, a domain linked to malicious code",
        );
        expect(html).toContain("From your last completed scan on");
        expect(html).toContain(", while the new scan runs.");
        expect(html).toMatch(/href="\/app\/scans\/scan-1#security-risk-m1"/);
        expect(html).not.toContain("/app/scans/scan-2#");
      },
    );

    it("after a failed scan: the last completed scan's banners, saying the latest did not complete", async () => {
      serve(THREE_LINES);
      mockScans.mockResolvedValue({
        items: [{ ...RUNNING, status: "FAILED" }, SCAN],
        hasNextPage: false,
      });

      const data = await load();
      const html = renderDashboard(data);

      expect(data.securityRisks).toHaveLength(1);
      expect(data.securityRiskSource?.earlierScan).toBe("failed");
      expect(html).toContain(". Your latest scan did not complete.");
    });

    it("the two latest scans unsuccessful: reads the most recent successful scan", async () => {
      serve(THREE_LINES);
      mockScans.mockResolvedValue({
        items: [RUNNING, { ...RUNNING, id: "scan-3", status: "FAILED" }],
        hasNextPage: false,
      });
      (getCompletedScansForShop as ReturnType<typeof vi.fn>).mockImplementation(
        async (_shopId: string, opts?: { limit?: number }) =>
          opts?.limit === 1
            ? [{ id: "scan-1", completedAt: SCAN.completedAt, themeName: SCAN.themeName }]
            : [],
      );

      const data = await load();

      expect(getCompletedScansForShop).toHaveBeenCalledWith(SHOP.id, { limit: 1 });
      expect(data.securityRisks).toHaveLength(1);
      expect(data.securityRiskSource).toMatchObject({ scanId: "scan-1", earlierScan: "running" });
    });

    it("ignored malicious code in the last completed scan still shows during a rescan", async () => {
      serve(THREE_LINES, 3);
      mockScans.mockResolvedValue({ items: [RUNNING, SCAN], hasNextPage: false });

      const data = await load();

      expect(data.securityRisks).toEqual([
        expect.objectContaining({ kind: "malicious", domain: "biliing.top" }),
      ]);
      // The filtered summary the shop's ignores already read is reused.
      expect(mockFiltered.mock.calls.filter(([id]) => id === "scan-1")).toHaveLength(1);
    });

    it("the first scan running (nothing completed yet): no banner, no note", async () => {
      serve([]);
      mockScans.mockResolvedValue({ items: [RUNNING], hasNextPage: false });

      const data = await load();
      const html = renderDashboard(data);

      expect(data.securityRisks).toEqual([]);
      expect(html).not.toContain("From your last completed scan");
    });

    it("a clean last scan during a rescan: no banner, no note", async () => {
      serve([]);
      mockScans.mockResolvedValue({ items: [RUNNING, SCAN], hasNextPage: false });

      const data = await load();

      expect(data.securityRisks).toEqual([]);
      expect(renderDashboard(data)).not.toContain("From your last completed scan");
    });

    it("a failed read never takes Home down while a scan runs", async () => {
      serve(THREE_LINES);
      mockScans.mockResolvedValue({ items: [RUNNING, SCAN], hasNextPage: false });
      mockTypeCounts.mockRejectedValue(new Error("db down"));

      const data = await load();

      expect(data.securityRisks).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        "security risk: last successful scan unavailable",
        expect.objectContaining({ shopId: SHOP.id }),
      );
    });

    it("the latest scan succeeded: its own banners, and no note", async () => {
      serve(THREE_LINES);

      const data = await load();

      expect(data.securityRiskSource).toEqual({
        scanId: "scan-1",
        scanDate: SCAN.completedAt,
        earlierScan: null,
      });
      expect(renderDashboard(data)).not.toContain("From your last completed scan");
    });
  });

  // A4: the note's date is the fallback scan's own, never the running scan's.
  it("dates the banners by the fallback scan, even one with no completedAt", async () => {
    serve(THREE_LINES);
    const noCompletedAt = { ...SCAN, completedAt: null };
    mockScans.mockResolvedValue({ items: [RUNNING, noCompletedAt], hasNextPage: false });

    const data = await load();

    expect(data.securityRiskSource).toMatchObject({ scanId: "scan-1", scanDate: SCAN.createdAt });
    expect(data.securityRiskSource?.scanDate).not.toEqual(RUNNING.createdAt);
  });

  // A3: the in-progress poll runs every 3 s. Count the reads the banners'
  // fallback adds (the model and aggregation calls it can make).
  describe("the in-progress poll's cost", () => {
    const fallbackReads = () => ({
      typeCounts: mockTypeCounts.mock.calls.length,
      lookup: (getCompletedScansForShop as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([, opts]) => opts?.limit === 1,
      ).length,
      rows: (getFindingsForScan as ReturnType<typeof vi.fn>).mock.calls.length,
      filtered: mockFiltered.mock.calls.length,
      summary: (getFindingSummary as ReturnType<typeof vi.fn>).mock.calls.length,
    });

    afterEach(() => {
      delete process.env.APP_INCIDENT_ADVISORY_LIVE_ENABLED;
    });

    it("no security finding on the previous scan: ONE lean groupBy of the three security types", async () => {
      serve([]);
      mockScans.mockResolvedValue({ items: [RUNNING, SCAN], hasNextPage: false });

      const data = await load();

      expect(data.securityRisks).toEqual([]);
      expect(fallbackReads()).toEqual({
        typeCounts: 1,
        lookup: 0,
        rows: 0,
        filtered: 0,
        summary: 0,
      });
      expect(mockTypeCounts).toHaveBeenCalledWith("scan-1", [
        "MALICIOUS_SCRIPT",
        "APP_INCIDENT_ADVISORY",
        "MENU_INJECTION",
      ]);
    });

    it("a first scan (no successful scan yet): no read at all", async () => {
      serve([]);
      mockScans.mockResolvedValue({ items: [RUNNING], hasNextPage: false });
      (hasCompletedScans as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const data = await load();

      expect(data.securityRisks).toEqual([]);
      expect(fallbackReads()).toEqual({
        typeCounts: 0,
        lookup: 0,
        rows: 0,
        filtered: 0,
        summary: 0,
      });
    });

    it("advisory switch off with an advisory stored: ONE lean read, no rows, no banner", async () => {
      serve([]);
      mockTypeCounts.mockResolvedValue({
        ...TYPE_COUNTS,
        MALICIOUS_SCRIPT: 0,
        APP_INCIDENT_ADVISORY: 1,
      });
      mockScans.mockResolvedValue({ items: [RUNNING, SCAN], hasNextPage: false });

      const data = await load();

      expect(data.securityRisks).toEqual([]);
      expect(data.securityRiskSource).toBeNull();
      expect(fallbackReads()).toEqual({
        typeCounts: 1,
        lookup: 0,
        rows: 0,
        filtered: 0,
        summary: 0,
      });
    });

    it("advisory switch on: the stored advisory's banner still shows during a rescan", async () => {
      process.env.APP_INCIDENT_ADVISORY_LIVE_ENABLED = "true";
      const SELLEASY = APP_INCIDENT_ADVISORIES.find((a) => a.appName === "Selleasy")!;
      const advisory = {
        ...line("adv", "scan-1", 1),
        findingType: "APP_INCIDENT_ADVISORY",
        filename: "config/settings_data.json",
        codeSnippet: "shopify://apps/selleasy/blocks/app-embed\n{}",
        description: advisoryDescription({
          advisory: SELLEASY,
          embedHandle: "shopify://apps/selleasy/blocks/app-embed",
        }),
      };
      serve([advisory]);
      mockTypeCounts.mockResolvedValue({
        ...TYPE_COUNTS,
        MALICIOUS_SCRIPT: 0,
        APP_INCIDENT_ADVISORY: 1,
      });
      mockScans.mockResolvedValue({ items: [RUNNING, SCAN], hasNextPage: false });

      const data = await load();

      expect(data.securityRisks).toEqual([expect.objectContaining({ kind: "advisory" })]);
      expect(fallbackReads()).toMatchObject({ typeCounts: 1, rows: 1, filtered: 0 });
    });

    it("previous scan failed too: one lookup for the last successful scan, then the lean read", async () => {
      serve([]);
      mockScans.mockResolvedValue({
        items: [RUNNING, { ...RUNNING, id: "scan-3", status: "FAILED" }],
        hasNextPage: false,
      });
      (getCompletedScansForShop as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "scan-1", completedAt: SCAN.completedAt, themeName: SCAN.themeName },
      ]);

      await load();

      expect(fallbackReads()).toEqual({
        typeCounts: 1,
        lookup: 1,
        rows: 0,
        filtered: 0,
        summary: 0,
      });
    });
  });
});

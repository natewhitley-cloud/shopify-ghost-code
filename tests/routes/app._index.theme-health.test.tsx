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
      // (the vintage sentence and the theme library). No chip, no action box,
      // and no verdict line: the malicious line below is the verdict.
      expect(chipsOf(section)).toEqual([]);
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
      expect(data.findingsTile).toEqual({ total: 2, tone: "critical" });
      const html = renderDashboard(data);
      expect(tileOf(html)).toMatchObject({
        tileTone: "critical",
        numberTone: "critical",
        total: 2,
        noun: "findings",
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
    expect(data.findingsTile).toEqual({ total: 4, tone: "critical" });
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
    expect(data.findingsTile).toEqual({ total: 5, tone: "critical" });
  });

  it("malicious code with no ignores at all: the stored total, not green", async () => {
    scans({ "scan-1": { found: { MALICIOUS_SCRIPT: 1 }, kept: {} } }, false);
    const data = await runLoader();
    expect(mockFiltered).not.toHaveBeenCalled();
    expect(data.findingsTile).toEqual({ total: 1, tone: "critical" });
    expect(tileOf(renderDashboard(data))).toMatchObject({
      tileTone: "critical",
      total: 1,
      noun: "finding",
    });
  });

  it("(c): no malicious, everything ignored -> 0 and green, as before", async () => {
    scans({ "scan-1": { found: { GHOST_SCRIPT: 3 }, kept: {} } });
    const data = await runLoader();
    expect(data.findingsTile).toEqual({ total: 0, tone: "success" });
    expect(tileOf(renderDashboard(data))).toMatchObject({
      tileTone: "success",
      numberTone: "success",
      total: 0,
    });
  });

  it("(d): no malicious, normal findings -> unchanged, with and without ignores", async () => {
    // No ignores: the seeded scan's 7 findings.
    let data = await runLoader();
    expect(data.findingsTile).toEqual({ total: 7, tone: "warning" });
    expect(tileOf(renderDashboard(data))).toMatchObject({
      tileTone: "warning",
      numberTone: "warning",
      total: 7,
    });

    // With ignores: the ignore-filtered total.
    scans({ "scan-1": { found: { GHOST_SCRIPT: 3, GHOST_PIXEL: 2 }, kept: { GHOST_SCRIPT: 2 } } });
    data = await runLoader();
    expect(data.findingsTile).toEqual({ total: 2, tone: "warning" });
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
      expect(data.findingsTile).toEqual({ total: 2, tone: "critical" });
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
      expect(data.findingsTile).toEqual({ total: 3, tone: "warning" });
      expect(data.findingTrend).toEqual({ direction: "improving", previousTotal: 4 });
      expect(tileOf(renderDashboard(data)).delta).toBe("▼ 1 fewer than last scan");
    });
  });
});

// gc-14x5: an affected-app advisory is NOT known malicious code. On Home it is
// a normal finding: it never turns the findings tile critical, never raises the
// critical "Known malicious code" line, honours ignores (nothing is added
// back), and counts in its lane like any other finding.
describe("Home: an affected-app advisory is a normal finding, not malicious code (gc-14x5)", () => {
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
    "%s: an advisory alone is a warning tile counting 1, never critical",
    async (plan) => {
      setPlan(plan);
      scan({ APP_INCIDENT_ADVISORY: 1 });

      const data = await runLoader();

      expect(data.findingsTile).toEqual({ total: 1, tone: "warning" });
      const html = renderDashboard(data);
      expect(tileOf(html)).toEqual({ tileTone: "warning", numberTone: "warning", total: 1 });
      expect(html).not.toMatch(/class="[^"]*health-score-(tile|number)--critical/);
    },
  );

  it("never raises the critical 'Known malicious code' line", async () => {
    scan({ APP_INCIDENT_ADVISORY: 1 });

    const data = await runLoader();

    expect(data.maliciousHealth).toBeNull();
    const rows = data.themeHealth as HealthRow[];
    expect(rowOf(rows, "malicious")).toMatchObject({ status: "clean", count: 0 });
    // Round 3: the advisory is in no theme health row at all.
    expect(rowOf(rows, "scripts-styles")).toMatchObject({ status: "clean", count: 0 });
    expect(rows.every((r) => r.count === 0)).toBe(true);
    const section = sectionOf(renderDashboard(data));
    expect(section).not.toContain('<s-badge tone="critical">');
    expect(section).toContain("No known malicious code found.");
  });

  it("an ignored advisory leaves a green zero: nothing is added back, unlike ignored malicious code", async () => {
    scan({ APP_INCIDENT_ADVISORY: 1 }, {});

    const data = await runLoader();

    expect(data.findingsTile).toEqual({ total: 0, tone: "success" });
    expect(tileOf(renderDashboard(data))).toMatchObject({ tileTone: "success", total: 0 });
    expect(data.maliciousHealth).toBeNull();
  });

  it("control: ignored malicious code beside it is still added back and critical", async () => {
    scan({ APP_INCIDENT_ADVISORY: 1, MALICIOUS_SCRIPT: 1 }, {});

    const data = await runLoader();

    // Only the malicious finding is added back: 1, not 2.
    expect(data.findingsTile).toEqual({ total: 1, tone: "critical" });
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
      expect(data.findingsTile).toEqual({ total: 1, tone: "warning" });
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
      // The tile counts all three.
      expect(data.findingsTile).toEqual({ total: 3, tone: "warning" });

      const html = renderDashboard(data);
      expect(html).toContain("What it&#x27;s costing you");
      // "leftover items" counts the laned findings only: 2, not 3.
      expect(html).toMatch(/2 leftover items from apps you&#x27;ve uninstalled are/);
      expect(html).not.toMatch(/3 leftover items/);
      expect(html).toContain("(2 findings)");
      expect(html).not.toContain("Still tracking you");
    });

    it("an advisory beside one privacy-lane finding does not inflate that lane", async () => {
      scan({ APP_INCIDENT_ADVISORY: 1, GHOST_PIXEL: 1 });

      const data = (await runLoader()) as unknown as LaneData;

      expect(data.laneSummary).toEqual([expect.objectContaining({ lane: "privacy", count: 1 })]);
      expect(renderDashboard(data)).toMatch(/1 leftover item from apps you&#x27;ve uninstalled is/);
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
          cost: "A public report describes this app delivering code that sent shoppers to a fake checkout page on at least one store.",
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
      // Round 3: the card's headline, not the type label.
      expect(block).toContain(">An app in your theme was named in a checkout phishing report</h3>");
      expect(block).not.toContain("App Security Advisories");
      expect(block).toContain('<s-badge tone="critical">HIGH</s-badge>');
      expect(block).toContain("layout/theme.liquid, line 42");
      expect(block).toContain(
        "A public report describes this app delivering code that sent shoppers to a fake checkout page on at least one store.",
      );
      expect(block).toMatch(
        /<a aria-label="See what to check: An app in your theme was named in a checkout phishing report, layout\/theme\.liquid, line 42"[^>]*href="\/app\/scans\/scan-1#finding-adv"[^>]*>See what to check<\/a>/,
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

  it("FLIPPING THE FLAG changes nothing in theme health for a scan taken before the flip", async () => {
    // The scan recorded its live set BEFORE the flip: the advisory type is not
    // in it. Off, then on: the checklist must be identical, and the scripts
    // row must not turn into "None found ... Run a new scan".
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
    expect(on.themeHealth).toEqual(off.themeHealth);
    expect(rowOf(on.themeHealth as HealthRow[], "scripts-styles")).toMatchObject({
      status: "clean",
      statusLabel: "Clean",
      detail: null,
    });
    expect(sectionOf(renderDashboard(on))).toBe(sectionOf(renderDashboard(off)));
    expect(sectionOf(renderDashboard(on))).not.toContain("Not checked on your last scan");
  });

  describe("top card: one line for advisories (round 3, B7)", () => {
    const topCard = (html: string) => {
      const start = html.indexOf('<div class="health-read">');
      return start === -1 ? "" : html.slice(start, html.indexOf("</div></div></div>", start));
    };
    const LINK = (text: string) =>
      new RegExp(`<a[^>]*href="/app/scans/scan-1#app-security-advisories"[^>]*>${text}</a>`);

    it("an advisory alone: the card holds the one line, linked to the scan page's advisory section", async () => {
      scan({ APP_INCIDENT_ADVISORY: 1 });

      const data = await runLoader();
      const card = topCard(renderDashboard(data));

      expect((data as unknown as { advisoryCount: number }).advisoryCount).toBe(1);
      expect(card).toMatch(LINK("1 app security advisory to review"));
      // Nothing else in the read: no damage line, no leftover sentence.
      expect(card).not.toContain("Most of the damage is in");
      expect(card).not.toMatch(/leftover item/);
    });

    it("two advisories pluralise", async () => {
      scan({ APP_INCIDENT_ADVISORY: 2 });

      expect(topCard(renderDashboard(await runLoader()))).toMatch(
        LINK("2 app security advisories to review"),
      );
    });

    it("beside other findings: after the leftover sentence, and the two account for the tile", async () => {
      scan({ APP_INCIDENT_ADVISORY: 1, GHOST_SCRIPT: 2 });

      const data = await runLoader();
      const card = topCard(renderDashboard(data));

      expect(data.findingsTile).toEqual({ total: 3, tone: "warning" });
      expect(card).toMatch(/2 leftover items from apps you&#x27;ve uninstalled are/);
      expect(card).toMatch(LINK("1 app security advisory to review"));
      expect(card.indexOf("leftover items")).toBeLessThan(card.indexOf("app security advisory"));
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

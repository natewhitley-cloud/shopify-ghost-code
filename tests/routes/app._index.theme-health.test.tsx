/**
 * Home: security risks, the lanes card and the scan control, through the REAL
 * loader and Dashboard.
 *
 * This file began as the theme health checklist's (gc-i6du). gc-np1d.6 removed
 * the checklist, the findings tile, the trend chart and the "Start here" block
 * from Home (decision 1A: "What it's costing you" is the one summary); the
 * first describe pins that they stay gone, and that their reads are gone too.
 *
 * Strategy: mock I/O (models, theme fetcher), run the REAL Home loader, then
 * render the REAL Dashboard with that loader data, so the assertions are on
 * what each plan is sent and what the merchant sees. No network, no database.
 */
import { FindingType } from "@prisma/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { LoaderFunctionArgs } from "react-router";
import { createRoutesStub } from "react-router";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// gc-np1d.4: the value-action card has its own tests (app._index.value-action);
// here it renders nothing so the existing assertions keep their meaning.
vi.mock("../../app/services/value-action.server", () => ({
  loadValueAction: vi.fn(async () => ({ card: null, cleanCopyFindingIds: [] })),
}));

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
  // The removed checklist's one query (gc-np1d.6 pins that Home never makes it).
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
import type { ValueActionCard } from "../../app/lib/value-action";
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
import Dashboard, {
  loader,
  MALICIOUS_FALLBACK_BODY,
  MALICIOUS_FALLBACK_HEADING,
  SECURITY_FALLBACK_BODY,
  SECURITY_FALLBACK_HEADING,
  SECURITY_UNAVAILABLE_BODY,
  SECURITY_UNAVAILABLE_HEADING,
} from "../../app/routes/app._index";
import { getFilteredFindingSummaryAndKept } from "../../app/services/finding-aggregation.server";
import { resetThemeCaches } from "../../app/services/theme-cache.server";
import { fetchAllThemes, fetchMainTheme } from "../../app/services/theme-fetcher.server";
import { getFreeTopFindings, getFullListTopFindings } from "../../app/services/top-findings.server";
import { loadValueAction } from "../../app/services/value-action.server";
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

/** Loader fields that only fed the Home sections gc-np1d.6 removed. */
const REMOVED_HOME_FIELDS = [
  "themeHealth",
  "maliciousHealth",
  "findingsTile",
  "findingTrend",
  "riskSummaryLine",
  "advisoryCount",
  "dominant",
  "topFindings",
  "newlyInactiveApps",
  "healthScoreTrend",
  "showTrendEmptyState",
  "scansNeeded",
  "trendChartEnabled",
] as const;

describe("Home has one summary: no theme health, tile, trend or Start here (gc-np1d.6)", () => {
  it.each(["free", "Standard", "Professional"])(
    "%s: none of the removed sections render, and none of their reads run",
    async (plan) => {
      setPlan(plan);

      const data = await runLoader();

      for (const field of REMOVED_HOME_FIELDS) expect(data).not.toHaveProperty(field);
      expect(mockThemeCounts).not.toHaveBeenCalled();
      expect(getCompletedScansForShop).not.toHaveBeenCalled();
      expect(getFullListTopFindings).not.toHaveBeenCalled();
      expect(getFreeTopFindings).not.toHaveBeenCalled();

      const html = renderDashboard(data);
      expect(html).toContain("What it&#x27;s costing you");
      // The removed checklist's heading ("Theme health").
      expect(html).not.toMatch(/>Theme health</);
      expect(html).not.toContain("theme-health-heading");
      expect(html).not.toContain("top-findings-heading");
      expect(html).not.toContain("health-score-tile");
      expect(html).not.toContain("Most Recent Findings");
      expect(html).not.toMatch(/Findings Trend|trend-chart/);
      expect(html).not.toMatch(/(fewer|more) than last scan|No change from last scan/);
      expect(html).not.toMatch(/health score|out of 100/i);
    },
  );

  it("Free reads no theme list at all (the checklist was its only reader)", async () => {
    setPlan("free");

    const data = await runLoader();

    expect(mockFetchAllThemes).not.toHaveBeenCalled();
    expect(data.allThemes).toEqual([]);
  });

  it("a paid plan reads the theme list once, for the picker", async () => {
    setPlan("Standard");

    const data = await runLoader();

    expect(mockFetchAllThemes).toHaveBeenCalledTimes(1);
    expect(data.allThemes).toEqual(THEMES);
  });
});

// Reviewer LOW-4, kept through gc-np1d.6: lane counts leave out ignored
// findings, so with every malicious finding ignored and nothing else found the
// lanes card must not say the theme is clean. The security banner at the top
// speaks for the malicious code (the removed checklist's red line used to).
// gc-np1d.6: one "all clear" on the page. The action card's All clear state
// replaces the lanes card's; with no action card the lanes card says it.
describe("Home: one all-clear (gc-np1d.6)", () => {
  const CLEAR_CARD: ValueActionCard = {
    kind: "clear",
    heading: "All clear: no leftover code in Dawn - live",
    body: "We'll keep checking. Scan again any time you add or remove an app.",
    note: null,
    apps: [],
    primary: null,
    secondary: null,
    telemetryKey: null,
    upsellKey: null,
  };

  beforeEach(() => {
    // A clean scan: no findings at all.
    mockTypeCounts.mockResolvedValue({});
    (getSeverityCountsForScans as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Map([["scan-1", { HIGH: 0, MEDIUM: 0, LOW: 0 }]]),
    );
  });

  it.each(["free", "Standard", "Professional"])(
    "%s: the action card says All clear, so the lanes all-clear card does not render",
    async (plan) => {
      setPlan(plan);
      vi.mocked(loadValueAction).mockResolvedValue({ card: CLEAR_CARD, cleanCopyFindingIds: [] });

      const html = renderDashboard(await runLoader());

      expect(html).toContain("All clear: no leftover code in Dawn - live");
      expect(html).not.toContain("You&#x27;re all clear");
      expect(html).not.toContain("No leftover code found. Your theme is clean.");
    },
  );

  it("no action card: the lanes all-clear card renders exactly as before", async () => {
    vi.mocked(loadValueAction).mockResolvedValue({ card: null, cleanCopyFindingIds: [] });

    const html = renderDashboard(await runLoader());

    expect(html).toMatch(/<h2 class="dashboard-section-title">You&#x27;re all clear<\/h2>/);
    expect(html).toContain("No leftover code found. Your theme is clean.");
  });

  it("a non-clear action card leaves the lanes card alone", async () => {
    vi.mocked(loadValueAction).mockResolvedValue({
      card: { ...CLEAR_CARD, kind: "scan_first", heading: "Scan again to remove these" },
      cleanCopyFindingIds: [],
    });

    expect(renderDashboard(await runLoader())).toContain("You&#x27;re all clear");
  });
});

// gc-np1d.6: the theme health checklist used to back up the malicious-code
// banner. Its replacement: when the latest scan found malicious code and no
// banner names it (e.g. the banners' read failed), a critical fallback banner.
describe("Home: known malicious code backup banner (gc-np1d.6)", () => {
  const BILIING = KNOWN_MALICIOUS_DOMAINS.find((d) => d.domain === "biliing.top")!;
  const ROW = {
    id: "m1",
    scanId: "scan-1",
    findingType: "MALICIOUS_SCRIPT",
    severity: "HIGH",
    filename: "layout/theme.liquid",
    lineNumber: 12,
    appName: null,
    codeSnippet: '<script src="https://biliing.top/x.js"></script>',
    description: maliciousDescription(BILIING),
    createdAt: new Date("2026-10-11T10:00:00Z"),
  };

  // The advisory and menu kill switches on, so their stored findings show.
  const SHOWN_FLAGS = ["APP_INCIDENT_ADVISORY_LIVE_ENABLED", "MENU_INJECTION_LIVE_ENABLED"];
  beforeEach(() => {
    for (const flag of SHOWN_FLAGS) process.env[flag] = "true";
    mockTypeCounts.mockResolvedValue({ ...TYPE_COUNTS, MALICIOUS_SCRIPT: 1 });
  });
  afterEach(() => {
    for (const flag of SHOWN_FLAGS) delete process.env[flag];
  });

  it("the banner rendered: no fallback (no duplicate)", async () => {
    (getFindingsForScan as ReturnType<typeof vi.fn>).mockImplementation(
      async (_id: string, f?: { findingType?: string }) =>
        [ROW].filter((r) => !f?.findingType || r.findingType === f.findingType),
    );

    const html = renderDashboard(await runLoader());

    expect(html).toContain("Your theme references biliing.top, a domain linked to malicious code");
    expect(html).not.toContain(MALICIOUS_FALLBACK_HEADING);
  });

  it.each(["free", "Standard", "Professional"])(
    "%s: the banners' read failed: the critical fallback, linked to the latest scan, never paywalled",
    async (plan) => {
      setPlan(plan);
      (getFindingsForScan as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db down"));

      const data = await runLoader();
      const html = renderDashboard(data);

      expect(data.securityRisks).toEqual([]);
      expect(data.maliciousFound).toBe(true);
      const start = html.indexOf(
        `<s-banner tone="critical" heading="${MALICIOUS_FALLBACK_HEADING}"`,
      );
      expect(start).toBeGreaterThan(-1);
      const banner = html.slice(start, html.indexOf("</s-banner>", start));
      expect(banner).toContain(MALICIOUS_FALLBACK_BODY);
      expect(banner).toMatch(
        /<a href="\/app\/scans\/scan-1"[^>]*><s-button[^>]*>See what to check</,
      );
      expect(banner).not.toMatch(/pricing_plans|Upgrade|free trial/i);
      // In the security area: above the lanes card and the notice slot.
      expect(start).toBeLessThan(html.indexOf("What it&#x27;s costing you"));
    },
  );

  it("no malicious code: no fallback, even when the banners' read failed", async () => {
    mockTypeCounts.mockResolvedValue(TYPE_COUNTS);
    (getFindingsForScan as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db down"));

    expect(renderDashboard(await runLoader())).not.toContain(MALICIOUS_FALLBACK_HEADING);
  });

  // gc-xtno path: while a rescan runs (or after one failed) the banners come
  // from the last successful scan. A failed read there never hides it.
  const RUNNING = { ...SCAN, id: "scan-2", status: "IN_PROGRESS", completedAt: null };

  /** The backup banner's markup, or null when none renders. */
  function backupBanner(html: string, heading: string): string | null {
    const start = html.indexOf(`heading="${heading.replace(/'/g, "&#x27;")}"`);
    if (start === -1) return null;
    return html.slice(html.lastIndexOf("<s-banner", start), html.indexOf("</s-banner>", start));
  }

  it("while a scan runs and the last scan's banners' read failed: the backup, linked to that scan", async () => {
    mockScans.mockResolvedValue({ items: [RUNNING, SCAN], hasNextPage: false });
    (getFindingsForScan as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db down"));

    const banner = backupBanner(renderDashboard(await runLoader()), MALICIOUS_FALLBACK_HEADING);

    expect(banner).not.toBeNull();
    expect(banner).toMatch(/<a href="\/app\/scans\/scan-1"/);
  });

  it("while a scan runs and the last scan's security read throws: the unavailable backup, linked to that scan", async () => {
    mockScans.mockResolvedValue({ items: [RUNNING, SCAN], hasNextPage: false });
    mockTypeCounts.mockImplementation(async (_id: string, types?: unknown) => {
      // The fallback's lean security groupBy fails; nothing else reads it here.
      if (types) throw new Error("db down");
      return TYPE_COUNTS;
    });

    const data = await runLoader();
    const html = renderDashboard(data);

    expect(data.securityBackup).toEqual({ scanId: "scan-1", copy: "unavailable" });
    const banner = backupBanner(html, SECURITY_UNAVAILABLE_HEADING);
    expect(banner).not.toBeNull();
    expect(banner).toContain(SECURITY_UNAVAILABLE_BODY);
    expect(banner).toMatch(/<a href="\/app\/scans\/scan-1"/);
    expect(banner).not.toMatch(/pricing_plans|Upgrade|free trial/i);
    expect(html).not.toContain(MALICIOUS_FALLBACK_HEADING);
  });

  it("after a failed scan, when finding the last successful scan throws: the unavailable backup, to the scans list", async () => {
    mockScans.mockResolvedValue({
      items: [
        { ...RUNNING, status: "FAILED" },
        { ...SCAN, status: "FAILED" },
      ],
      hasNextPage: false,
    });
    (getCompletedScansForShop as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db down"));

    const banner = backupBanner(renderDashboard(await runLoader()), SECURITY_UNAVAILABLE_HEADING);

    expect(banner).not.toBeNull();
    expect(banner).toMatch(/<a href="\/app\/scans"/);
  });

  it("while a scan runs and the last scan has no security finding: no backup", async () => {
    mockScans.mockResolvedValue({ items: [RUNNING, SCAN], hasNextPage: false });
    mockTypeCounts.mockResolvedValue(TYPE_COUNTS);

    const data = await runLoader();

    expect(data.securityBackup).toBeNull();
    expect(renderDashboard(data)).not.toMatch(/<s-banner tone="(critical|warning)"/);
  });

  // Audit r1/r2: the backup covers every never-paywalled type, not only
  // malicious code, and names malicious code only when it is uncovered.
  type BackupCase = {
    found: Record<string, number>;
    /** Kept per-type counts after ignores; null = the shop has no ignores. */
    kept: Record<string, number> | null;
    heading: string;
    body: string;
  };
  it.each<[string, BackupCase]>([
    [
      "only an app advisory",
      {
        found: { APP_INCIDENT_ADVISORY: 1 },
        kept: null,
        heading: SECURITY_FALLBACK_HEADING,
        body: SECURITY_FALLBACK_BODY,
      },
    ],
    [
      "only code in a menu",
      {
        found: { MENU_INJECTION: 1 },
        kept: null,
        heading: SECURITY_FALLBACK_HEADING,
        body: SECURITY_FALLBACK_BODY,
      },
    ],
    [
      "ignored malicious code beside a kept advisory",
      {
        found: { MALICIOUS_SCRIPT: 1, APP_INCIDENT_ADVISORY: 1 },
        kept: { APP_INCIDENT_ADVISORY: 1, MALICIOUS_SCRIPT: 0 },
        heading: MALICIOUS_FALLBACK_HEADING,
        body: MALICIOUS_FALLBACK_BODY,
      },
    ],
  ])(
    "%s, and the banners' read failed: the backup on every plan, never paywalled",
    async (_what, c) => {
      for (const plan of ["free", "Standard", "Professional"]) {
        setPlan(plan);
        mockTypeCounts.mockResolvedValue({ ...TYPE_COUNTS, ...c.found });
        if (c.kept) {
          (getIgnoredFindingsForShop as ReturnType<typeof vi.fn>).mockResolvedValue({
            fingerprints: new Set(["fp-ignored"]),
            appNames: new Set(),
          });
          const byType = { ...TYPE_COUNTS, ...c.kept };
          const total = Object.values(byType).reduce((a, b) => a + b, 0);
          mockFiltered.mockResolvedValue({
            summary: { total, bySeverity: { HIGH: total, MEDIUM: 0, LOW: 0 }, byType },
            // The kept rows the banners would read: none come back.
            keptFindings: [],
            ignoredMalicious: c.found.MALICIOUS_SCRIPT ?? 0,
          });
        }
        (getFindingsForScan as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db down"));

        const data = await runLoader();
        const html = renderDashboard(data);

        expect(data.securityRisks).toEqual([]);
        const banner = backupBanner(html, c.heading);
        expect(banner).not.toBeNull();
        expect(banner).toMatch(/^<s-banner tone="critical"/);
        expect(banner).toContain(c.body);
        expect(banner).toMatch(
          /<a href="\/app\/scans\/scan-1"[^>]*><s-button[^>]*>See what to check</,
        );
        expect(banner).not.toMatch(/pricing_plans|Upgrade|free trial/i);
        // Exactly one backup banner.
        const other =
          c.heading === MALICIOUS_FALLBACK_HEADING
            ? SECURITY_FALLBACK_HEADING
            : MALICIOUS_FALLBACK_HEADING;
        expect(html).not.toContain(other);
        if (c.heading === SECURITY_FALLBACK_HEADING) expect(banner).not.toMatch(/malicious/i);
      }
    },
  );

  it("an advisory whose banner rendered: no backup (no duplicate)", async () => {
    const advisory = APP_INCIDENT_ADVISORIES[0];
    mockTypeCounts.mockResolvedValue({ ...TYPE_COUNTS, APP_INCIDENT_ADVISORY: 1 });
    (getFindingsForScan as ReturnType<typeof vi.fn>).mockImplementation(
      async (_id: string, f?: { findingType?: string }) =>
        f?.findingType === "MALICIOUS_SCRIPT"
          ? []
          : [
              {
                ...ROW,
                id: "a1",
                findingType: "APP_INCIDENT_ADVISORY",
                appName: advisory.appName,
                description: advisoryDescription({ advisory, scriptHost: advisory.scriptHosts[0] }),
              },
            ],
    );

    const data = await runLoader();

    expect(data.securityRisks.map((r) => r.kind)).toEqual(["advisory"]);
    expect(data.securityBackup).toBeNull();
    const html = renderDashboard(data);
    expect(html).not.toContain(SECURITY_FALLBACK_HEADING);
    expect(html).not.toContain(MALICIOUS_FALLBACK_HEADING);
  });

  it("malicious code with its banner, and menu code without one: the neutral backup", async () => {
    mockTypeCounts.mockResolvedValue({ ...TYPE_COUNTS, MALICIOUS_SCRIPT: 1, MENU_INJECTION: 1 });
    // The malicious read works; the menu read finds no rows (no banner).
    (getFindingsForScan as ReturnType<typeof vi.fn>).mockImplementation(
      async (_id: string, f?: { findingType?: string }) =>
        f?.findingType === "MALICIOUS_SCRIPT" ? [ROW] : [],
    );

    const data = await runLoader();

    expect(data.securityRisks.map((r) => r.kind)).toEqual(["malicious"]);
    expect(data.securityBackup).toEqual({ scanId: "scan-1", copy: "security" });
  });

  it("no security findings at all: no backup", async () => {
    mockTypeCounts.mockResolvedValue(TYPE_COUNTS);

    const data = await runLoader();

    expect(data.securityBackup).toBeNull();
    const html = renderDashboard(data);
    expect(html).not.toContain(SECURITY_FALLBACK_HEADING);
    expect(html).not.toContain(SECURITY_UNAVAILABLE_HEADING);
    expect(html).not.toContain(MALICIOUS_FALLBACK_HEADING);
  });
});

describe("Home lanes card: known malicious code is never 'all clear'", () => {
  const ALL_CLEAR = ["You&#x27;re all clear", "Your theme is clean"];
  const BILIING = KNOWN_MALICIOUS_DOMAINS.find((d) => d.domain === "biliing.top")!;
  const maliciousRow = (id: string, lineNumber: number) => ({
    id,
    scanId: "scan-1",
    findingType: "MALICIOUS_SCRIPT",
    severity: "HIGH",
    filename: "layout/theme.liquid",
    lineNumber,
    appName: null,
    codeSnippet: '<script src="https://biliing.top/x.js"></script>',
    description: maliciousDescription(BILIING),
    createdAt: new Date("2026-10-11T10:00:00Z"),
  });

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
      ignoredMalicious: found - kept,
    });
    const rows = Array.from({ length: found }, (_, i) => maliciousRow(`m${i}`, 10 + i));
    (getFindingsForScan as ReturnType<typeof vi.fn>).mockImplementation(
      async (_id: string, f?: { findingType?: string }) =>
        rows.filter((r) => !f?.findingType || r.findingType === f.findingType),
    );
  }

  it.each(["free", "Standard", "Professional"])(
    "%s: every malicious finding ignored and nothing else found -> no all-clear, no lanes card, the banner names it",
    async (plan) => {
      setPlan(plan);
      onlyMalicious(2, 0);
      const data = await runLoader();
      expect(data.laneSummary).toEqual([]);
      expect(data.maliciousFound).toBe(true);
      const html = renderDashboard(data);
      for (const text of ALL_CLEAR) expect(html, text).not.toContain(text);
      expect(html).not.toMatch(/all clear|is clean/i);
      expect(html).not.toContain("What it&#x27;s costing you");
      expect(html).toContain(
        "Your theme references biliing.top, a domain linked to malicious code",
      );
    },
  );

  it("a malicious finding that is NOT ignored keeps its lane, with no all-clear text", async () => {
    onlyMalicious(2, 2);
    const data = await runLoader();
    expect(data.laneSummary).not.toEqual([]);
    const html = renderDashboard(data);
    for (const text of ALL_CLEAR) expect(html, text).not.toContain(text);
    expect(html).toContain("What it&#x27;s costing you");
  });

  it.each(["free", "Standard", "Professional"])(
    "%s: no malicious findings and nothing else found -> the all-clear text still renders",
    async (plan) => {
      setPlan(plan);
      onlyMalicious(0, 0);
      const data = await runLoader();
      expect(data.laneSummary).toEqual([]);
      expect(data.maliciousFound).toBe(false);
      const html = renderDashboard(data);
      for (const text of ALL_CLEAR) expect(html, text).toContain(text);
    },
  );

  it("adds no finding query: the flag comes from the per-type counts already loaded", async () => {
    mockTypeCounts.mockResolvedValue({ ...TYPE_COUNTS, MALICIOUS_SCRIPT: 3 });
    const data = await runLoader();
    expect(data.maliciousFound).toBe(true);
    expect(mockTypeCounts).toHaveBeenCalledTimes(1);
    expect(mockTypeCounts).toHaveBeenCalledWith("scan-1");
  });

  it("no successful latest scan: not flagged, and no per-type count query", async () => {
    mockScans.mockResolvedValue({
      items: [{ ...SCAN, status: "FAILED", completedAt: null }],
      hasNextPage: false,
    });
    const data = await runLoader();
    expect(data.maliciousFound).toBe(false);
    expect(mockTypeCounts).not.toHaveBeenCalled();
  });
});

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

  it("an advisory is not malicious code: Home does not flag malicious code for it", async () => {
    scan({ APP_INCIDENT_ADVISORY: 1 });

    const data = await runLoader();

    expect(data.maliciousFound).toBe(false);
  });

  it("control: ignored malicious code beside an ignored advisory is still flagged", async () => {
    scan({ APP_INCIDENT_ADVISORY: 1, MALICIOUS_SCRIPT: 1 }, {});

    const data = await runLoader();

    expect(data.maliciousFound).toBe(true);
  });

  it("no top-card summary line (gc-np1d.6): the banner names the risk, not a count line", async () => {
    scan({ APP_INCIDENT_ADVISORY: 1, GHOST_SCRIPT: 2 });

    const html = renderDashboard(await runLoader());

    expect(html).not.toContain("1 app security advisory, 2 leftover items.");
    expect(html).not.toMatch(/<a[^>]*href="\/app\/scans\/scan-1"[^>]*>See all<\/a>/);
    expect(html).not.toContain("Most of the damage is in");
  });

  describe("no consequence lane (round 2)", () => {
    type LaneData = {
      laneSummary: Array<{ lane: string; label: string; count: number }>;
      startHere: string | null;
    };

    it("an advisory alone: no lane rows, no start-here lane", async () => {
      scan({ APP_INCIDENT_ADVISORY: 1 });

      const data = (await runLoader()) as unknown as LaneData;

      expect(data.laneSummary).toEqual([]);
      expect(data.startHere).toBeNull();
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
      // The advisory has no lane, so the chip goes to the most urgent real lane.
      expect(data.startHere).toBe("speed");

      const html = renderDashboard(data);
      expect(html).toContain("What it&#x27;s costing you");
      expect(html).toMatch(/aria-label="Review 2 Speed findings\./);
      expect(html).not.toContain("Still tracking you");
    });

    it("an advisory beside one privacy-lane finding does not inflate that lane", async () => {
      scan({ APP_INCIDENT_ADVISORY: 1, GHOST_PIXEL: 1 });

      const data = (await runLoader()) as unknown as LaneData;

      expect(data.laneSummary).toEqual([expect.objectContaining({ lane: "privacy", count: 1 })]);
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
        // At the very top: before the lanes card and everything else.
        expect(html.indexOf(banner)).toBeLessThan(html.indexOf("What it&#x27;s costing you"));
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

    it("a failed read never takes Home down: no banner, and never an all-clear", async () => {
      scan({ APP_INCIDENT_ADVISORY: 1 });
      (getFindingsForScan as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db down"));

      const data = await runLoader();
      const html = renderDashboard(data);

      expect((data as unknown as { securityRisks: unknown[] }).securityRisks).toEqual([]);
      expect(html).not.toContain("You&#x27;re all clear");
      expect(html).not.toContain("Your theme is clean");
    });
  });

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
      laneSummary: Array<{ lane: string; count: number }>;
    };

    /** The kept rows Home handed to the value action (gc-np1d.6: Start here's reader is gone). */
    const keptIds = () => {
      const calls = vi.mocked(loadValueAction).mock.calls;
      expect(calls).toHaveLength(1);
      return (calls[0][0].keptFindings ?? []).map((r) => r.id);
    };

    it.each(["free", "Standard", "Professional"])(
      "%s: no banner, no security wording, not in the lanes, not in the value action's rows",
      async (plan) => {
        setPlan(plan);
        delete process.env[ADVISORY_FLAG];

        const data = (await runLoader()) as unknown as KillData;
        const html = renderDashboard(data);

        expect(data.securityRisks).toEqual([]);
        expect(html).not.toContain(">Security risk<");
        expect(html).not.toContain("Selleasy");
        expect(html).not.toMatch(/security risk|app security advisor/i);
        expect(data.laneSummary).toEqual([expect.objectContaining({ lane: "speed", count: 2 })]);
        // The kept rows leave the advisory out.
        expect(keptIds()).toEqual(["s1", "s2"]);
      },
    );

    it("flag on: the same stored rows are a security risk, unchanged", async () => {
      const data = (await runLoader()) as unknown as KillData;
      const html = renderDashboard(data);

      expect(data.securityRisks).toEqual([
        expect.objectContaining({ kind: "advisory", appName: "Selleasy" }),
      ]);
      expect(html).toContain("Selleasy is in your theme");
      expect(data.laneSummary).toEqual([expect.objectContaining({ lane: "speed", count: 2 })]);
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
      laneSummary: Array<{ lane: string; count: number }>;
    };

    it.each(["free", "Standard", "Professional"])(
      "%s, flag off: no menu banner, not in the lanes, not in the value action's rows",
      async (plan) => {
        setPlan(plan);
        delete process.env[MENU_FLAG];

        const data = (await runLoader()) as unknown as KillData;
        const html = renderDashboard(data);

        expect(data.securityRisks).toEqual([]);
        expect(html).not.toContain("onerror");
        expect(html).not.toContain("Main menu &gt; Shop");
        expect(data.laneSummary).toEqual([expect.objectContaining({ lane: "speed", count: 2 })]);
        const calls = vi.mocked(loadValueAction).mock.calls;
        expect(calls).toHaveLength(1);
        expect((calls[0][0].keptFindings ?? []).map((r) => r.id)).toEqual(["s1", "s2"]);
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
    });
  });
});

// ---------------------------------------------------------------------------
// Home's scan control: the plan's manual-scan limit (gc-d0ui)
// ---------------------------------------------------------------------------

describe("Home scan control: manual-scan limit copy (gc-d0ui)", () => {
  /**
   * Home's scan control (gc-np1d.4): the header's Scan now button plus the
   * "Scan controls" row under the header (usage, next scan, upgrade link). It
   * replaced the old "New Scan" card at the bottom of the page.
   */
  function scanCardOf(html: string): string {
    const button = /<s-button slot="primary-action"[^>]*>Scan now<\/s-button>/.exec(html);
    expect(button).not.toBeNull();
    const start = html.indexOf('aria-label="Scan controls"');
    expect(start).toBeGreaterThan(-1);
    return `${button![0]}${html.slice(start, html.indexOf("</div>", start))}`;
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
      const html = renderDashboard(await runLoader());
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
    const html = renderDashboard(await runLoader());
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
  };
  const load = async () => (await runLoader()) as unknown as Data;

  // gc-np1d.6: the tile that said "k security risks" is gone; one banner per
  // domain, with the line count inside it, is what stays.
  describe("item 3: one banner per domain, not per line", () => {
    it.each(["free", "Standard", "Professional"])(
      "%s: three lines on one domain are 1 banner",
      async (plan) => {
        setPlan(plan);
        serve(THREE_LINES);

        const data = await load();
        const html = renderDashboard(data);

        expect(data.securityRisks).toHaveLength(1);
        expect(data.securityRisks[0].findings).toHaveLength(3);
        expect(html).not.toContain("3 security risks");
        // The per-line detail stays inside the banner.
        expect(html).toContain("on 3 lines of your theme");
      },
    );

    it("two domains are 2 banners", async () => {
      serve([...THREE_LINES, line("p1", "scan-1", 40, POLYFILL)]);

      const data = await load();

      expect(data.securityRisks).toHaveLength(2);
      const html = renderDashboard(data);
      expect(html).toContain("Your theme references biliing.top");
      expect(html).toContain("Your theme references polyfill.io");
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
      // gc-np1d.6: Home no longer reads the previous scan's filtered summary
      // (the trend was its reader); malicious code counts ignored or not, so the
      // lean security groupBy is enough and no filtered read is added.
      expect(mockFiltered.mock.calls.filter(([id]) => id === "scan-1")).toHaveLength(0);
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

// ---------------------------------------------------------------------------
// gc-np1d.4: Home's value actions (rule ~/.claude/rules/merchant-ux.md).
// The card model has its own tests (tests/lib/value-action.test.ts); these
// check where Home puts it and what its buttons do.
// ---------------------------------------------------------------------------

describe("Home value actions (gc-np1d.4)", () => {
  const CLEAN_COPY_CARD: ValueActionCard = {
    kind: "clean_copy",
    heading: "Remove 12 pieces of leftover code for you",
    body: "4 apps you uninstalled left code in your theme.",
    note: "Saves paying a developer or editing theme code yourself.",
    apps: [{ name: "Privy", count: 3 }],
    primary: { label: "Make a clean copy", action: "clean_copy" },
    secondary: null,
    telemetryKey: "clean_copy_action",
    upsellKey: null,
  };
  const DIY_CARD: ValueActionCard = {
    ...CLEAN_COPY_CARD,
    kind: "diy",
    heading: "Fix 12 pieces of leftover code",
    note: null,
    primary: { label: "See how to fix them", action: "diy" },
    secondary: { label: "Upgrade to Professional to remove them for you", action: "upgrade" },
    telemetryKey: "clean_copy_diy",
    upsellKey: "clean_copy_upsell",
  };

  it("loads the card for the latest finished scan, reusing its kept findings", async () => {
    vi.mocked(loadValueAction).mockResolvedValue({
      card: CLEAN_COPY_CARD,
      cleanCopyFindingIds: [],
    });
    const data = await runLoader();
    expect(loadValueAction).toHaveBeenCalledWith(
      expect.objectContaining({ scan: expect.objectContaining({ id: SCAN.id }) }),
    );
    expect(data.valueAction).toEqual(CLEAN_COPY_CARD);
  });

  it("no card while the latest scan is running (the 3s poll reads nothing for it)", async () => {
    mockScans.mockResolvedValue({
      items: [{ ...SCAN, status: "IN_PROGRESS" }],
      hasNextPage: false,
    });
    const data = await runLoader();
    expect(loadValueAction).not.toHaveBeenCalled();
    expect(data.valueAction).toBeNull();
  });

  it("puts Scan now in the header and the card above What it's costing you", async () => {
    vi.mocked(loadValueAction).mockResolvedValue({
      card: CLEAN_COPY_CARD,
      cleanCopyFindingIds: [],
    });
    // Under the cap, so the header button is enabled (the default fixture is at 1 of 1).
    (getScanUsage as ReturnType<typeof vi.fn>).mockResolvedValue({
      used: 0,
      limit: 1,
      period: "month",
      periodStart: new Date("2026-10-01T00:00:00Z"),
    });
    const html = renderDashboard(await runLoader());
    expect(html).toMatch(/<s-button slot="primary-action" variant="primary">Scan now<\/s-button>/);
    const cardAt = html.indexOf("Remove 12 pieces of leftover code for you");
    expect(cardAt).toBeGreaterThan(-1);
    expect(cardAt).toBeLessThan(html.indexOf("What it&#x27;s costing you"));
    // Its button opens the select page for the latest scan.
    expect(html).toMatch(
      /<a href="\/app\/scans\/scan-1\/clean-copy"[^>]*><s-button variant="primary">Make a clean copy<\/s-button><\/a>/,
    );
    // The old bottom card is gone.
    expect(html).not.toContain("Scan Actions");
    expect(html).not.toContain("Start New Scan");
  });

  it("Standard: do it yourself first, the upgrade second, to Shopify's plan page", async () => {
    setPlan("Standard");
    vi.mocked(loadValueAction).mockResolvedValue({ card: DIY_CARD, cleanCopyFindingIds: [] });
    const html = renderDashboard(await runLoader());
    const diyAt = html.indexOf('href="/app/scans/scan-1#scan-findings"');
    const upgradeAt = html.indexOf("Upgrade to Professional to remove them for you");
    expect(diyAt).toBeGreaterThan(-1);
    expect(upgradeAt).toBeGreaterThan(diyAt);
    expect(html).toMatch(
      /<a href="https:\/\/admin\.shopify\.com\/store\/paw-naturals-llc\/charges\/ghost-code\/pricing_plans" target="_top"[^>]*>Upgrade to Professional to remove them for you<\/a>/,
    );
  });

  it("onboarding (no scan yet) shows neither the header button nor a card", async () => {
    mockScans.mockResolvedValue({ items: [], hasNextPage: false });
    const html = renderDashboard(await runLoader());
    expect(html).not.toContain('slot="primary-action"');
    expect(html).toContain("Start First Scan");
  });
});

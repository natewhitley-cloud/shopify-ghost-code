/**
 * gc-frda: Home's app-removal banner, Start here badge and Dismiss intent.
 *
 * Strategy (same as app._index.onboarding.test.tsx): mock I/O at the model
 * boundary, run the REAL loader, then render the REAL Dashboard with that
 * loader data (createRoutesStub + hydrationData) to static markup, so the
 * assertions are on what the merchant actually sees.
 */
import { renderToStaticMarkup } from "react-dom/server";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
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
  dismissRemovalNotice: vi.fn(),
}));

vi.mock("../../app/models/scan.server", () => ({
  getScanById: vi.fn(),
  getScansForShop: vi.fn(),
  hasCompletedScans: vi.fn(),
  getCompletedScansForShop: vi.fn(),
  getFirstSuccessfulScanCompletedAt: vi.fn(),
  getLatestSuccessfulScanNonMaliciousCount: vi.fn(),
}));

vi.mock("../../app/models/app-removal.server", () => ({
  getRemovalNoticeRows: vi.fn(async () => []),
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
  getFullListTopFindings: vi.fn(async () => []),
  getFreeTopFindings: vi.fn(async () => []),
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

import { canStartScan, getScanUsage } from "../../app/lib/plan-gating.server";
import { getRemovalNoticeRows } from "../../app/models/app-removal.server";
import { getSeverityCountsForScans, getTypeCountsForScan } from "../../app/models/finding.server";
import { getIgnoredFindingsForShop } from "../../app/models/ignored-finding.server";
import {
  getCompletedScansForShop,
  getFirstSuccessfulScanCompletedAt,
  getScanById,
  getScansForShop,
  hasCompletedScans,
} from "../../app/models/scan.server";
import {
  dismissRemovalNotice,
  getOrCreateShopMetadata,
  getShopMetadata,
} from "../../app/models/shop.server";
import Dashboard, { action, loader } from "../../app/routes/app._index";
import { dispatchScan } from "../../app/services/scan-dispatch.server";
import { resetThemeCaches } from "../../app/services/theme-cache.server";
import { fetchAllThemes, fetchMainTheme } from "../../app/services/theme-fetcher.server";
import { getFreeTopFindings, getFullListTopFindings } from "../../app/services/top-findings.server";
import { authenticate } from "../../app/shopify.server";

const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const DOMAIN = "removal-merchant.myshopify.com";
const THEME_ID = "gid://shopify/OnlineStoreTheme/77";
const SHOP = {
  id: "shop-r",
  domain: DOMAIN,
  plan: "Standard",
  planReconciledAt: null,
  installedAt: new Date("2026-09-01T00:00:00Z"),
  uninstalledAt: null,
  lastSeenAt: null,
  lastThemePublishAt: null,
  upgradePreviewShownAt: null,
  feedbackNudgeShownAt: null,
  feedbackNudgeDismissedAt: null,
  feedbackSubmittedAt: null,
  firstResultsViewedAt: new Date("2026-09-02T00:00:00Z"),
  lastPromptKey: null,
  lastPromptShownAt: null,
  removalNoticeDismissedScanId: null as string | null,
};
const COMPLETED = {
  id: "scan-2",
  shopId: SHOP.id,
  themeId: THEME_ID,
  themeName: "Dawn",
  status: "COMPLETED",
  findingCount: 4,
  startedAt: new Date("2026-10-08T10:00:05Z"),
  completedAt: new Date("2026-10-08T10:01:00Z") as Date | null,
  createdAt: new Date("2026-10-08T10:00:00Z"),
  viewedOnHomeAt: new Date("2026-10-08T10:02:00Z"),
};
const IN_PROGRESS = { ...COMPLETED, id: "scan-3", status: "IN_PROGRESS", completedAt: null };

type Row = { appName: string; leftoverCount: number; state: string };
const removed = (appName: string, leftoverCount: number): Row => ({
  appName,
  leftoverCount,
  state: "REMOVED",
});
const cleaned = (appName: string, leftoverCount: number): Row => ({
  appName,
  leftoverCount,
  state: "CLEANED",
});

function runLoader(url = "https://example.com/app") {
  return loader({
    request: new Request(url),
    params: {},
    context: {},
  } as unknown as LoaderFunctionArgs);
}

type LoaderData = Awaited<ReturnType<typeof runLoader>>;

function renderDashboard(loaderData: unknown, entry = "/app"): string {
  const Stub = createRoutesStub([
    { id: "dashboard", path: "/app", Component: Dashboard as never, loader: () => loaderData },
  ]);
  return renderToStaticMarkup(
    <Stub initialEntries={[entry]} hydrationData={{ loaderData: { dashboard: loaderData } }} />,
  );
}

async function load(opts: {
  rows?: Row[];
  plan?: string;
  scan?: typeof COMPLETED;
  dismissed?: string | null;
}): Promise<LoaderData> {
  mock(getOrCreateShopMetadata).mockResolvedValue({
    ...SHOP,
    plan: opts.plan ?? SHOP.plan,
    removalNoticeDismissedScanId: opts.dismissed ?? null,
  });
  mock(getScansForShop).mockResolvedValue({
    items: [opts.scan ?? COMPLETED],
    hasNextPage: false,
  });
  mock(getRemovalNoticeRows).mockResolvedValue(opts.rows ?? []);
  return runLoader();
}

beforeEach(() => {
  vi.resetAllMocks();
  resetThemeCaches();
  mock(authenticate.admin).mockResolvedValue({
    session: { shop: DOMAIN },
    admin: { graphql: vi.fn() },
  });
  mock(getShopMetadata).mockResolvedValue(SHOP);
  mock(fetchMainTheme).mockResolvedValue({ id: THEME_ID, name: "Dawn" });
  mock(fetchAllThemes).mockResolvedValue([]);
  mock(getScanUsage).mockResolvedValue(null);
  mock(getCompletedScansForShop).mockResolvedValue([]);
  mock(hasCompletedScans).mockResolvedValue(true);
  // Prompt state: the shop's first successful scan was moments ago, so no
  // interruptive prompt (feedback nudge) is eligible to compete here.
  mock(getFirstSuccessfulScanCompletedAt).mockResolvedValue(new Date());
  mock(getSeverityCountsForScans).mockResolvedValue(
    new Map([["scan-2", { HIGH: 2, MEDIUM: 1, LOW: 1 }]]),
  );
  mock(getTypeCountsForScan).mockResolvedValue({ GHOST_SCRIPT: 3, GHOST_STYLE: 1 });
  mock(getIgnoredFindingsForShop).mockResolvedValue({
    fingerprints: new Set(),
    appNames: new Set(),
  });
});

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

describe("Home loader: app-removal banner (gc-frda)", () => {
  it("none: no banner, no badge set, one read on the scan's shop + theme", async () => {
    const data = await load({ rows: [] });
    expect(data.removalBanner).toBeNull();
    expect(data.newlyInactiveApps).toEqual([]);
    expect(getRemovalNoticeRows).toHaveBeenCalledTimes(1);
    expect(getRemovalNoticeRows).toHaveBeenCalledWith(SHOP.id, THEME_ID, "scan-2");
  });

  it("one app: an inactive notice bound to the scan, full list on a paid plan", async () => {
    const data = await load({ rows: [removed("Yotpo", 3)] });
    expect(data.removalBanner).toEqual({
      notice: { kind: "inactive", apps: [{ appName: "Yotpo", count: 3 }], total: 3 },
      scanId: "scan-2",
      fullList: true,
    });
    expect(data.newlyInactiveApps).toEqual(["Yotpo"]);
  });

  it("many apps: every app, largest first, all badged", async () => {
    const data = await load({
      rows: [removed("Avada", 1), removed("Privy", 2), removed("Yotpo", 5)],
    });
    expect(data.removalBanner?.notice.apps.map((a) => a.appName)).toEqual([
      "Yotpo",
      "Privy",
      "Avada",
    ]);
    expect(data.removalBanner?.notice.total).toBe(8);
    expect(data.newlyInactiveApps).toEqual(["Avada", "Privy", "Yotpo"]);
  });

  it("cleaned only: a success notice, and no Start here badge (nothing new is inactive)", async () => {
    const data = await load({ rows: [cleaned("Privy", 2)] });
    expect(data.removalBanner?.notice.kind).toBe("cleaned");
    expect(data.newlyInactiveApps).toEqual([]);
  });

  it("removed AND cleaned on the same scan: the inactive notice wins", async () => {
    const data = await load({ rows: [removed("Yotpo", 3), cleaned("Privy", 2)] });
    expect(data.removalBanner?.notice.kind).toBe("inactive");
    expect(data.removalBanner?.notice.apps).toEqual([{ appName: "Yotpo", count: 3 }]);
  });

  it("reinstalled rows show nothing", async () => {
    const data = await load({
      rows: [{ appName: "Yotpo", leftoverCount: 3, state: "REINSTALLED" }],
    });
    expect(data.removalBanner).toBeNull();
    expect(data.newlyInactiveApps).toEqual([]);
  });

  it("dismissed for THIS scan: no banner, but Start here still badges", async () => {
    const data = await load({ rows: [removed("Yotpo", 3)], dismissed: "scan-2" });
    expect(data.removalBanner).toBeNull();
    expect(data.newlyInactiveApps).toEqual(["Yotpo"]);
  });

  it("dismissed for an OLDER scan: the newer scan's removals show again", async () => {
    const data = await load({ rows: [removed("Yotpo", 3)], dismissed: "scan-1" });
    expect(data.removalBanner?.scanId).toBe("scan-2");
  });

  it("scan in progress: no read, no banner (same as other result-derived UI)", async () => {
    const data = await load({ rows: [removed("Yotpo", 3)], scan: IN_PROGRESS });
    expect(getRemovalNoticeRows).not.toHaveBeenCalled();
    expect(data.removalBanner).toBeNull();
    expect(data.newlyInactiveApps).toEqual([]);
  });

  it("Free sees the full banner (decision 4A), without the full list", async () => {
    const data = await load({ rows: [removed("Yotpo", 3)], plan: "free" });
    expect(data.removalBanner?.notice.apps).toEqual([{ appName: "Yotpo", count: 3 }]);
    expect(data.removalBanner?.fullList).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

describe("Home render: app-removal banner (gc-frda)", () => {
  it("renders at the top of the ground stack, above the scan summary", async () => {
    const html = renderDashboard(await load({ rows: [removed("Yotpo", 3)] }));
    expect(html).toContain('heading="Yotpo is no longer active in your store"');
    expect(html).toContain("It left 3 items behind.");
    expect(html.indexOf("Yotpo is no longer active")).toBeLessThan(
      html.indexOf("Most Recent Findings"),
    );
    // The first banner in the ground.
    expect(html.indexOf("<s-banner")).toBe(html.indexOf('<s-banner tone="info" heading="Yotpo'));
  });

  it("paid: 'Review 3 items' links to the app's filtered scan view", async () => {
    const html = renderDashboard(await load({ rows: [removed("Yotpo", 3)] }));
    expect(html).toMatch(
      /href="\/app\/scans\/scan-2\?app=Yotpo"[^>]*><s-button variant="primary">Review 3 items</,
    );
  });

  it("Free: 'See what Yotpo left' to the same view", async () => {
    const html = renderDashboard(await load({ rows: [removed("Yotpo", 3)], plan: "free" }));
    expect(html).toMatch(
      /href="\/app\/scans\/scan-2\?app=Yotpo"[^>]*><s-button variant="primary">See what Yotpo left</,
    );
  });

  it("links keep Home's embedded params", async () => {
    const data = await load({ rows: [removed("Yotpo", 3)] });
    const html = renderDashboard(data, "/app?host=h1&shop=s.myshopify.com");
    expect(html).toContain(
      'href="/app/scans/scan-2?host=h1&amp;shop=s.myshopify.com&amp;app=Yotpo"',
    );
  });

  it("many: list capped at 5 with 'and N more'", async () => {
    const rows = ["A", "B", "C", "D", "E", "F", "G"].map((a, i) => removed(a, 10 - i));
    const html = renderDashboard(await load({ rows }));
    expect(html).toContain('heading="7 apps are no longer active in your store"');
    expect(html.match(/<li><a href="\/app\/scans\/scan-2\?app=/g)).toHaveLength(5);
    expect(html).toContain("and 2 more");
    expect(html).toMatch(/<s-button variant="primary">Review A<\/s-button>/);
  });

  it("cleaned: success tone, Dismiss only", async () => {
    const html = renderDashboard(await load({ rows: [cleaned("Privy", 2)] }));
    expect(html).toContain(
      '<s-banner tone="success" heading="Privy&#x27;s leftovers are cleaned up"',
    );
    expect(html).toContain("The 2 items Privy left behind are gone as of this scan.");
  });

  it("no banner when dismissed for this scan", async () => {
    const html = renderDashboard(await load({ rows: [removed("Yotpo", 3)], dismissed: "scan-2" }));
    expect(html).not.toContain("no longer active");
  });

  it("no banner while a scan is in progress", async () => {
    const html = renderDashboard(await load({ rows: [removed("Yotpo", 3)], scan: IN_PROGRESS }));
    expect(html).not.toContain("no longer active");
  });

  it("Start here badges a top finding from a newly inactive app", async () => {
    mock(getFullListTopFindings).mockResolvedValue([
      {
        id: "f-1",
        findingType: "GHOST_SCRIPT",
        severity: "HIGH",
        createdAt: new Date("2026-10-08T10:00:30Z"),
        filename: "layout/theme.liquid",
        lineNumber: 12,
        appName: "Yotpo",
      },
      {
        id: "f-2",
        findingType: "GHOST_STYLE",
        severity: "LOW",
        createdAt: new Date("2026-10-08T10:00:31Z"),
        filename: "assets/x.css",
        lineNumber: 1,
        appName: "Privy",
      },
    ]);
    const html = renderDashboard(await load({ rows: [removed("Yotpo", 3)] }));
    expect(html).toContain("New · Yotpo");
    expect(html).not.toContain("New · Privy");
    expect(getFreeTopFindings).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Action: dismiss-removal-notice
// ---------------------------------------------------------------------------

describe("Home action: dismiss-removal-notice (gc-frda)", () => {
  const dismiss = (scanId?: string) =>
    action({
      request: new Request("https://example.com/app", {
        method: "POST",
        body: new URLSearchParams({
          intent: "dismiss-removal-notice",
          ...(scanId !== undefined ? { scanId } : {}),
        }),
      }),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

  beforeEach(() => {
    mock(getScanById).mockImplementation(async (id: string) =>
      id === "scan-2" ? { ...COMPLETED } : id === "other-shop-scan" ? { id, shopId: "x" } : null,
    );
  });

  it("authenticates, then stores the dismissed scan for the SESSION shop", async () => {
    await expect(dismiss("scan-2")).resolves.toEqual({ dismissed: true });
    expect(authenticate.admin).toHaveBeenCalledTimes(1);
    expect(getShopMetadata).toHaveBeenCalledWith(DOMAIN);
    expect(dismissRemovalNotice).toHaveBeenCalledWith(SHOP.id, "scan-2");
  });

  it("is idempotent: a repeat writes the same value again", async () => {
    await dismiss("scan-2");
    await dismiss("scan-2");
    expect(mock(dismissRemovalNotice).mock.calls).toEqual([
      [SHOP.id, "scan-2"],
      [SHOP.id, "scan-2"],
    ]);
  });

  it("a scan of another shop is a no-op", async () => {
    await expect(dismiss("other-shop-scan")).resolves.toEqual({ ignored: true });
    expect(dismissRemovalNotice).not.toHaveBeenCalled();
  });

  it("an unknown or missing scan id is a no-op", async () => {
    await expect(dismiss("nope")).resolves.toEqual({ ignored: true });
    await expect(dismiss("")).resolves.toEqual({ ignored: true });
    await expect(dismiss()).resolves.toEqual({ ignored: true });
    expect(dismissRemovalNotice).not.toHaveBeenCalled();
  });

  it("never starts a scan or checks plan gating", async () => {
    await dismiss("scan-2");
    expect(canStartScan).not.toHaveBeenCalled();
    expect(dispatchScan).not.toHaveBeenCalled();
  });

  it("an unauthenticated request never reaches the write", async () => {
    mock(authenticate.admin).mockRejectedValue(new Response(null, { status: 401 }));
    await expect(dismiss("scan-2")).rejects.toBeInstanceOf(Response);
    expect(dismissRemovalNotice).not.toHaveBeenCalled();
  });
});

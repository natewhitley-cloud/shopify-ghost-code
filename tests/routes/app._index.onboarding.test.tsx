/**
 * gc-bj4: first-load race hides the onboarding CTA.
 *
 * On a brand-new install the parent app.tsx loader (which creates the Shop row)
 * and this child loader run IN PARALLEL. If the child's getShopMetadata lands
 * before the parent's upsert commits, it used to take the `!shop` early return,
 * which made `showOnboarding` false: no welcome card, no "Start First Scan",
 * only the dashboard shell with a DISABLED "Start New Scan" button.
 *
 * Strategy: mock I/O, run the REAL loader, then render the REAL Dashboard
 * component with that loader data (createRoutesStub + hydrationData) to static
 * markup, so the assertion is on what the merchant actually sees.
 */
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
  // The return banner's "latest results hide findings" read (starvation fix).
  getLatestSuccessfulScanNonMaliciousCount: vi.fn(),
}));

vi.mock("../../app/services/nudge-stage.server", () => ({
  recordNudgeStageOnce: vi.fn(),
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
  getFilteredFindingSummary: vi.fn(),
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

import { logger } from "../../app/lib/logger.server";
import {
  canUseMultipleThemes,
  canUseScanDiffing,
  getScanUsage,
} from "../../app/lib/plan-gating.server";
import { SCAN_DURATION_EXPECTATION, SCAN_PHRASES } from "../../app/lib/scan-progress";
import { HOME_POLL_TIMEOUT_MESSAGE } from "../../app/lib/use-scan-polling";
import { getSeverityCountsForScans } from "../../app/models/finding.server";
import { getIgnoredFindingsForShop } from "../../app/models/ignored-finding.server";
import {
  getCompletedScansForShop,
  getScansForShop,
  hasCompletedScans,
} from "../../app/models/scan.server";
import { getOrCreateShopMetadata } from "../../app/models/shop.server";
import Dashboard, { HomeScanInProgress, loader } from "../../app/routes/app._index";
import { resetThemeCaches } from "../../app/services/theme-cache.server";
import { fetchMainTheme } from "../../app/services/theme-fetcher.server";
import { authenticate } from "../../app/shopify.server";

const mockAuth = authenticate.admin as ReturnType<typeof vi.fn>;
const mockGetOrCreate = getOrCreateShopMetadata as ReturnType<typeof vi.fn>;

const DOMAIN = "new-merchant.myshopify.com";
const NEW_SHOP = {
  id: "shop-new",
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
    // The stub types Component loosely; Dashboard reads only useLoaderData.
    { id: "dashboard", path: "/app", Component: Dashboard as never, loader: () => loaderData },
  ]);
  return renderToStaticMarkup(
    <Stub initialEntries={["/app"]} hydrationData={{ loaderData: { dashboard: loaderData } }} />,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  resetThemeCaches();
  mockAuth.mockResolvedValue({ session: { shop: DOMAIN }, admin: { graphql: vi.fn() } });
  (fetchMainTheme as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "gid://shopify/Theme/1",
    name: "Dawn",
  });
  (canUseMultipleThemes as ReturnType<typeof vi.fn>).mockReturnValue(false);
  (canUseScanDiffing as ReturnType<typeof vi.fn>).mockReturnValue(false);
  (getScanUsage as ReturnType<typeof vi.fn>).mockResolvedValue({
    used: 0,
    limit: 1,
    period: "month",
    periodStart: new Date("2026-09-01T00:00:00Z"),
  });
  (getScansForShop as ReturnType<typeof vi.fn>).mockResolvedValue({
    items: [],
    hasNextPage: false,
  });
  (getCompletedScansForShop as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (hasCompletedScans as ReturnType<typeof vi.fn>).mockResolvedValue(false);
  (getSeverityCountsForScans as ReturnType<typeof vi.fn>).mockResolvedValue(new Map());
  (getIgnoredFindingsForShop as ReturnType<typeof vi.fn>).mockResolvedValue({
    fingerprints: new Set(),
    appNames: new Set(),
  });
});

describe("gc-bj4: what the old `!shop` minimal data renders", () => {
  it("renders NO onboarding card and a DISABLED Start New Scan button", () => {
    // Exactly the object the pre-fix `!shop` branch returned. Kept as the
    // explicit defensive fallback, so this documents what it shows.
    const html = renderDashboard({
      shop: null,
      latestScan: null,
      latestScanId: null,
      canDiffLatest: false,
      findingSummary: null,
      mainTheme: null,
      allThemes: [],
      canSelectTheme: false,
      scanUsage: null,
      isFirstScan: true,
      healthScore: null,
      showRescanNudge: false,
      showThemeChangeNudge: false,
      showMultiThemeNudge: false,
      showFeedbackNudge: false,
      healthScoreTrend: null,
      showTrendEmptyState: false,
      scansNeeded: 0,
      trendChartEnabled: false,
      laneSummary: [],
      startHere: null,
      dominant: null,
      findingTrend: null,
    });

    expect(html).not.toContain("Welcome to Ghost Code");
    expect(html).not.toContain("Start First Scan");
    // The dashboard shell renders instead, with its scan button disabled.
    expect(html).toContain("Scan Actions");
    expect(html).toMatch(/<s-button[^>]*disabled[^>]*>Start New Scan<\/s-button>/);
  });
});

describe("gc-bj4: brand-new install always sees onboarding", () => {
  it("get-or-creates the shop in the child loader and renders an enabled Start First Scan", async () => {
    // The parent loader's create has not committed yet; the child's own
    // get-or-create returns the (newly created) row.
    mockGetOrCreate.mockResolvedValue(NEW_SHOP);

    const data = await runLoader();

    expect(mockGetOrCreate).toHaveBeenCalledWith(DOMAIN);
    expect(data.shop).toEqual(NEW_SHOP);

    const html = renderDashboard(data);
    expect(html).toContain("Welcome to Ghost Code");
    expect(html).toMatch(/<s-button[^>]*>Start First Scan<\/s-button>/);
    expect(html).not.toMatch(/<s-button[^>]*disabled[^>]*>Start First Scan/);
  });

  it("keeps an explicit, logged fallback if the row is still missing after create", async () => {
    mockGetOrCreate.mockResolvedValue(null);

    const data = await runLoader();

    expect(data.shop).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith("dashboard-shop-missing-after-create", {
      shop: DOMAIN,
    });
  });
});

// The shared scan wait experience (ScanProgress) on Home: the REAL loader with
// the latest scan still running, then the REAL Dashboard render.
describe("Home scan wait experience (ScanProgress)", () => {
  const SCAN = {
    id: "scan-1",
    shopId: NEW_SHOP.id,
    themeId: "gid://shopify/Theme/1",
    themeName: "Dawn",
    status: "IN_PROGRESS",
    findingCount: 0,
    startedAt: new Date("2026-10-08T10:00:05Z"),
    completedAt: null as Date | null,
    createdAt: new Date("2026-10-08T10:00:00Z"),
  };

  async function renderHome(scan: typeof SCAN): Promise<string> {
    mockGetOrCreate.mockResolvedValue(NEW_SHOP);
    (getScansForShop as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [scan],
      hasNextPage: false,
    });
    return renderDashboard(await runLoader());
  }

  it.each(["PENDING", "IN_PROGRESS"])(
    "renders the shared progress block while the latest scan is %s",
    async (status) => {
      const html = await renderHome({ ...SCAN, status });

      expect(html).toContain("Scanning your theme...");
      expect(html).toMatch(/<span role="status"[^>]*>Scan in progress<\/span>/);
      expect(html).toContain(SCAN_PHRASES[0]);
      expect(html).toContain(SCAN_DURATION_EXPECTATION);
      // The old fixed-range line is gone (one expectation, shared with the scan page).
      expect(html).not.toContain("1–3 minutes");
      expect(html).not.toMatch(/come back|leave this page|we.ll email/i);
      // Polling has not timed out on the first render.
      expect(html).not.toContain(HOME_POLL_TIMEOUT_MESSAGE);
    },
  );

  it("shows the live findings-so-far count now that Home polls", async () => {
    const html = await renderHome({ ...SCAN, findingCount: 3 });
    expect(html).toContain("Found 3 findings so far…");
  });

  it("does not render the progress block once the latest scan has completed", async () => {
    const html = await renderHome({
      ...SCAN,
      status: "COMPLETED",
      completedAt: new Date("2026-10-08T10:01:00Z"),
    });

    expect(html).toContain("Scan Actions"); // the real dashboard rendered
    expect(html).not.toContain("Scanning your theme...");
    expect(html).not.toContain("Scan in progress");
    expect(html).not.toContain(SCAN_DURATION_EXPECTATION);
    for (const phrase of SCAN_PHRASES) expect(html).not.toContain(phrase);
  });
});

describe("HomeScanInProgress: polling timed out", () => {
  const props = { createdAt: "2026-10-08T10:00:00.000Z", findingCount: 2 };

  it("while polling: spinner, scanning heading and progress, no timeout notice", () => {
    const html = renderToStaticMarkup(<HomeScanInProgress {...props} pollingTimedOut={false} />);
    expect(html).toContain("<s-spinner");
    expect(html).toContain("Scanning your theme...");
    expect(html).toContain(SCAN_PHRASES[0]);
    expect(html).not.toContain(HOME_POLL_TIMEOUT_MESSAGE);
  });

  it("after the cap: no spinner, no scanning heading, only the timeout notice", () => {
    const html = renderToStaticMarkup(<HomeScanInProgress {...props} pollingTimedOut />);
    expect(html).not.toContain("<s-spinner");
    expect(html).not.toContain("Scanning your theme...");
    expect(html).not.toContain("Results will appear here");
    expect(html).not.toContain(SCAN_PHRASES[0]);
    expect(html).toContain("Scan still running");
    expect(html).toContain(HOME_POLL_TIMEOUT_MESSAGE);
  });
});

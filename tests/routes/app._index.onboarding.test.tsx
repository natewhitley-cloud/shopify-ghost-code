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
import { getSeverityCountsForScans } from "../../app/models/finding.server";
import { getIgnoredFindingsForShop } from "../../app/models/ignored-finding.server";
import {
  getCompletedScansForShop,
  getScansForShop,
  hasCompletedScans,
} from "../../app/models/scan.server";
import { getOrCreateShopMetadata } from "../../app/models/shop.server";
import Dashboard, { loader } from "../../app/routes/app._index";
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

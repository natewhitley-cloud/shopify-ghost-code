/**
 * gc-ol95: Home's one-time "Summary emails are on" notice and its Dismiss
 * intent.
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

// gc-ol95 collaborators, mocked at their boundaries; the REAL
// claimSummaryNoticeForHome service runs between them and the loader.
vi.mock("../../app/models/merchant-alert.server", () => ({
  claimSummaryNoticeShown: vi.fn(),
  dismissSummaryNotice: vi.fn(),
}));

vi.mock("../../app/services/merchant-alert.server", () => ({
  getMerchantAlertConfigStatus: vi.fn(),
}));

vi.mock("../../app/services/shop-alert-email.server", () => ({
  refreshShopAlertEmail: vi.fn(),
}));

import { canStartScan, getScanUsage } from "../../app/lib/plan-gating.server";
import { getRemovalNoticeRows } from "../../app/models/app-removal.server";
import { getSeverityCountsForScans, getTypeCountsForScan } from "../../app/models/finding.server";
import { getIgnoredFindingsForShop } from "../../app/models/ignored-finding.server";
import {
  claimSummaryNoticeShown,
  dismissSummaryNotice,
} from "../../app/models/merchant-alert.server";
import {
  getCompletedScansForShop,
  getFirstSuccessfulScanCompletedAt,
  getScansForShop,
  hasCompletedScans,
} from "../../app/models/scan.server";
import { getOrCreateShopMetadata, getShopMetadata } from "../../app/models/shop.server";
import Dashboard, { action, loader } from "../../app/routes/app._index";
import { getMerchantAlertConfigStatus } from "../../app/services/merchant-alert.server";
import { dispatchScan } from "../../app/services/scan-dispatch.server";
import { refreshShopAlertEmail } from "../../app/services/shop-alert-email.server";
import { resetThemeCaches } from "../../app/services/theme-cache.server";
import { fetchAllThemes, fetchMainTheme } from "../../app/services/theme-fetcher.server";
import { getFreeTopFindings, getFullListTopFindings } from "../../app/services/top-findings.server";
import { authenticate } from "../../app/shopify.server";

const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const DOMAIN = "notice-merchant.myshopify.com";
const THEME_ID = "gid://shopify/OnlineStoreTheme/77";
const ADMIN = { graphql: vi.fn() };
/** A shop that just moved Free -> Professional: the notice is owed. */
const SHOP = {
  id: "shop-n",
  domain: DOMAIN,
  plan: "Professional",
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
  removalNoticeDismissedScanId: null,
  alertsEnabled: true,
  alertEmail: "owner@example.com" as string | null,
  summaryNoticePendingAt: new Date("2026-10-09T10:00:00Z") as Date | null,
  summaryNoticeShownAt: null as Date | null,
  summaryOptedInAt: null as Date | null,
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

function runLoader() {
  return loader({
    request: new Request("https://example.com/app"),
    params: {},
    context: {},
  } as unknown as LoaderFunctionArgs);
}

type LoaderData = Awaited<ReturnType<typeof runLoader>>;

function renderDashboard(loaderData: unknown): string {
  const Stub = createRoutesStub([
    { id: "dashboard", path: "/app", Component: Dashboard as never, loader: () => loaderData },
  ]);
  return renderToStaticMarkup(
    <Stub initialEntries={["/app"]} hydrationData={{ loaderData: { dashboard: loaderData } }} />,
  );
}

async function load(shop: Partial<typeof SHOP> = {}): Promise<LoaderData> {
  mock(getOrCreateShopMetadata).mockResolvedValue({ ...SHOP, ...shop });
  return runLoader();
}

const HEADING = "Summary emails are on";

beforeEach(() => {
  vi.resetAllMocks();
  resetThemeCaches();
  mock(authenticate.admin).mockResolvedValue({ session: { shop: DOMAIN }, admin: ADMIN });
  mock(getShopMetadata).mockResolvedValue(SHOP);
  mock(fetchMainTheme).mockResolvedValue({ id: THEME_ID, name: "Dawn" });
  mock(fetchAllThemes).mockResolvedValue([]);
  mock(getScanUsage).mockResolvedValue(null);
  mock(getCompletedScansForShop).mockResolvedValue([]);
  mock(hasCompletedScans).mockResolvedValue(true);
  mock(getFirstSuccessfulScanCompletedAt).mockResolvedValue(new Date());
  mock(getScansForShop).mockResolvedValue({ items: [COMPLETED], hasNextPage: false });
  mock(getRemovalNoticeRows).mockResolvedValue([]);
  mock(getSeverityCountsForScans).mockResolvedValue(
    new Map([["scan-2", { HIGH: 2, MEDIUM: 1, LOW: 1 }]]),
  );
  mock(getTypeCountsForScan).mockResolvedValue({ GHOST_SCRIPT: 3, GHOST_STYLE: 1 });
  mock(getIgnoredFindingsForShop).mockResolvedValue({
    fingerprints: new Set(),
    appNames: new Set(),
  });
  mock(getFullListTopFindings).mockResolvedValue([]);
  mock(getFreeTopFindings).mockResolvedValue([]);
  mock(getMerchantAlertConfigStatus).mockReturnValue({ configured: true });
  mock(claimSummaryNoticeShown).mockResolvedValue(true);
  mock(refreshShopAlertEmail).mockResolvedValue(null);
});

describe("Home: summary-email notice (gc-ol95)", () => {
  it("pending -> claimed once on this load -> rendered with the owner email (Professional: weekly)", async () => {
    const data = await load();
    expect(claimSummaryNoticeShown).toHaveBeenCalledExactlyOnceWith(DOMAIN);
    expect(data.summaryNotice).toEqual({ email: "owner@example.com", cadence: "weekly" });

    const html = renderDashboard(data);
    expect(html).toMatch(/<s-banner[^>]*tone="info"[^>]*heading="Summary emails are on"/);
    expect(html).toContain(
      "We&#x27;ll email owner@example.com a summary after each weekly scan, only when something changed. You can turn this off in",
    );
    expect(html).toContain('<a href="/app/settings"');
    expect(html).toContain(">Settings</a>.");
    expect(html).toContain(">Dismiss</s-button>");
    expect(html).not.toMatch(/[\u2014\u2013]/);
  });

  it("Standard says monthly", async () => {
    const html = renderDashboard(await load({ plan: "Standard" }));
    expect(html).toContain("a summary after each monthly scan, only when something changed.");
  });

  it("shown once: a later load (shownAt stamped) never claims or renders it again", async () => {
    const data = await load({ summaryNoticeShownAt: new Date("2026-10-09T11:00:00Z") });
    expect(claimSummaryNoticeShown).not.toHaveBeenCalled();
    expect(data.summaryNotice).toBeNull();
    expect(renderDashboard(data)).not.toContain(HEADING);
  });

  it("a concurrent load that loses the claim renders nothing", async () => {
    mock(claimSummaryNoticeShown).mockResolvedValue(false);
    const data = await load();
    expect(data.summaryNotice).toBeNull();
    expect(renderDashboard(data)).not.toContain(HEADING);
  });

  it("a failed claim renders nothing and never breaks Home", async () => {
    mock(claimSummaryNoticeShown).mockRejectedValue(new Error("db down"));
    const data = await load();
    expect(data.summaryNotice).toBeNull();
  });

  it("never for a shop already paid before this shipped (nothing pending)", async () => {
    const data = await load({ summaryNoticePendingAt: null });
    expect(claimSummaryNoticeShown).not.toHaveBeenCalled();
    expect(data.summaryNotice).toBeNull();
    expect(renderDashboard(data)).not.toContain(HEADING);
  });

  it.each([
    ["sending not configured (dark): stays pending for when it goes live", {}, false],
    ["Free plan", { plan: "free" }, true],
    ["toggle turned off (it would not be true)", { alertsEnabled: false }, true],
  ])("not shown and not claimed: %s", async (_l, shop, configured) => {
    mock(getMerchantAlertConfigStatus).mockReturnValue(
      configured ? { configured: true } : { configured: false, reason: "disabled" },
    );
    const data = await load(shop);
    expect(claimSummaryNoticeShown).not.toHaveBeenCalled();
    expect(data.summaryNotice).toBeNull();
  });

  it("no cached owner email: reads it now; falls back to generic copy if that fails", async () => {
    mock(refreshShopAlertEmail).mockResolvedValue("fresh@example.com");
    let data = await load({ alertEmail: null });
    expect(refreshShopAlertEmail).toHaveBeenCalledWith(DOMAIN, ADMIN);
    expect(data.summaryNotice?.email).toBe("fresh@example.com");

    mock(refreshShopAlertEmail).mockResolvedValue(null);
    mock(claimSummaryNoticeShown).mockResolvedValue(true);
    data = await load({ alertEmail: null });
    expect(renderDashboard(data)).toContain(
      "We&#x27;ll email your store owner email a summary after each weekly scan",
    );
  });
});

describe("Home action: dismiss-summary-notice (gc-ol95)", () => {
  const dismiss = () =>
    action({
      request: new Request("https://example.com/app", {
        method: "POST",
        body: new URLSearchParams({ intent: "dismiss-summary-notice" }),
      }),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

  it("clears the pending notice for the SESSION shop and starts no scan", async () => {
    await expect(dismiss()).resolves.toEqual({ dismissed: true });
    expect(getShopMetadata).toHaveBeenCalledWith(DOMAIN);
    expect(dismissSummaryNotice).toHaveBeenCalledExactlyOnceWith(SHOP.id);
    expect(dispatchScan).not.toHaveBeenCalled();
    expect(canStartScan).not.toHaveBeenCalled();
  });

  it("is idempotent", async () => {
    await dismiss();
    await dismiss();
    expect(mock(dismissSummaryNotice).mock.calls).toEqual([[SHOP.id], [SHOP.id]]);
  });
});

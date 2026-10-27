/**
 * gc-1q1s.6: Home's checkout guard incidents (every plan), the merge with the
 * scan's malicious-code banners by domain, the status line, and the
 * "This is expected" intent. Same harness as app._index.summary-notice.test:
 * the REAL loader and Dashboard, I/O mocked at the boundaries.
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

// Theme health checklist (gc-i6du): its own queries and rows are covered in
// app._index.theme-health.test.tsx; here it returns no rows (renders nothing).
vi.mock("../../app/services/theme-health.server", () => ({
  loadThemeHealth: vi.fn(async () => []),
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

// gc-1q1s.6 collaborators: the guard's storage, mocked at the model.
vi.mock("../../app/models/storefront-guard.server", () => ({
  loadGuardForHome: vi.fn(),
  acknowledgeGuardIncident: vi.fn(),
}));

import { canStartScan, getScanUsage } from "../../app/lib/plan-gating.server";
import { getRemovalNoticeRows } from "../../app/models/app-removal.server";
import { getSeverityCountsForScans, getTypeCountsForScan } from "../../app/models/finding.server";
import { getIgnoredFindingsForShop } from "../../app/models/ignored-finding.server";
import { claimSummaryNoticeShown } from "../../app/models/merchant-alert.server";
import {
  getCompletedScansForShop,
  getFirstSuccessfulScanCompletedAt,
  getScansForShop,
  hasCompletedScans,
} from "../../app/models/scan.server";
import { getOrCreateShopMetadata, getShopMetadata } from "../../app/models/shop.server";
import {
  acknowledgeGuardIncident,
  loadGuardForHome,
} from "../../app/models/storefront-guard.server";
import Dashboard, { action, loader } from "../../app/routes/app._index";
import { getMerchantAlertConfigStatus } from "../../app/services/merchant-alert.server";
import { dispatchScan } from "../../app/services/scan-dispatch.server";
import { refreshShopAlertEmail } from "../../app/services/shop-alert-email.server";
import { resetThemeCaches } from "../../app/services/theme-cache.server";
import { fetchAllThemes, fetchMainTheme } from "../../app/services/theme-fetcher.server";
import { getFreeTopFindings, getFullListTopFindings } from "../../app/services/top-findings.server";
import { authenticate } from "../../app/shopify.server";

const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const DOMAIN = "guard-merchant.myshopify.com";
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
  summaryNoticePendingAt: null as Date | null,
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
  mock(loadGuardForHome).mockResolvedValue({ state: null, incidents: [] });
  delete process.env.STOREFRONT_GUARD_LIVE_ENABLED;
});

const T = new Date("2026-10-27T03:17:00Z");
function incident(over: Record<string, unknown> = {}) {
  return {
    id: "inc-1",
    kind: "KNOWN_MALICIOUS",
    fingerprint: "KNOWN_MALICIOUS:cartassure.top",
    host: "cartassure.top",
    page: "both",
    sourceLabel: "Named in JavaScript attached to an element in the page",
    state: "open",
    openedAt: T,
    firstSeenAt: T,
    lastSeenAt: T,
    seenCount: 1,
    cleanStreak: 0,
    resolvedAt: null,
    resolution: null,
    acknowledgedAt: null,
    emailedOpenedAt: null,
    ...over,
  };
}

describe("Home: checkout guard incidents (gc-1q1s.6)", () => {
  it.each(["free", "Standard", "Professional"])(
    "shows a known-malicious incident as a security risk on %s, even while the guard is dark",
    async (plan) => {
      mock(loadGuardForHome).mockResolvedValue({ state: null, incidents: [incident()] });
      const data = await load({ plan });
      const html = renderDashboard(data);
      expect(html).toContain(
        "Your live store loads code from cartassure.top, a domain linked to malicious code",
      );
      expect(html).toContain(
        "Shopify may block shoppers from being sent to a domain it has flagged",
      );
      expect(html).toContain("your homepage and cart page");
      expect(html).toContain("What to check");
      expect(html).toContain("shopify-app-compromised-checklist");
      expect(html).toContain("shown on every plan");
      expect(html).not.toMatch(/hijack/i);
      expect(html).not.toMatch(/[\u2014\u2013]/);
      // Dark: no status line.
      expect(html).not.toContain('data-testid="guard-status"');
    },
  );

  it("a new script host is a warning with This is expected, not a security risk", async () => {
    mock(loadGuardForHome).mockResolvedValue({
      state: null,
      incidents: [
        incident({
          id: "inc-2",
          kind: "NEW_SCRIPT_HOST",
          fingerprint: "NEW_SCRIPT_HOST:widgets.newapp.io",
          host: "widgets.newapp.io",
          page: "home",
          sourceLabel: "Loaded by a script tag in the page",
        }),
      ],
    });
    const html = renderDashboard(await load());
    expect(html).toMatch(
      /<s-banner[^>]*tone="warning"[^>]*heading="A new script source started loading on your store: widgets.newapp.io"/,
    );
    expect(html).toContain(">This is expected</s-button>");
    expect(html).not.toContain(">Security risk<");
  });

  it("a script loader names where it was seen", async () => {
    mock(loadGuardForHome).mockResolvedValue({
      state: null,
      incidents: [
        incident({
          kind: "SCRIPT_LOADER",
          fingerprint: "SCRIPT_LOADER:pay-check.example",
          host: "pay-check.example",
          page: "cart",
          sourceLabel: "Code in an onerror attribute in the checkout button",
          seenCount: 3,
        }),
      ],
    });
    const html = renderDashboard(await load());
    expect(html).toContain(
      "Code on your live store loads a script from pay-check.example in an unusual way",
    );
    expect(html).toContain("your cart page (code in an onerror attribute in the checkout button)");
    expect(html).toContain("Seen 3 times, last on");
  });

  it("the status line shows only while the guard is live", async () => {
    process.env.STOREFRONT_GUARD_LIVE_ENABLED = "true";
    mock(loadGuardForHome).mockResolvedValue({
      state: {
        lastCheckedAt: T,
        lastOutcome: "paused_password",
        lastReadableAt: null,
        primaryHost: "shop.example.com",
        lastRedirectHost: null,
      },
      incidents: [],
    });
    const html = renderDashboard(await load());
    expect(html).toContain("Checkout guard is paused while your store is password-protected.");
  });

  it("a guard read failure renders Home without the guard", async () => {
    mock(loadGuardForHome).mockRejectedValue(new Error("db down"));
    const data = await load();
    expect(data.guard).toEqual({ incidents: [], status: null });
    expect(renderDashboard(data)).not.toContain("checkout guard");
  });
});

describe("Home action: guard-acknowledge (gc-1q1s.6)", () => {
  const ack = (incidentId?: string) =>
    action({
      request: new Request("https://example.com/app", {
        method: "POST",
        body: new URLSearchParams({
          intent: "guard-acknowledge",
          ...(incidentId !== undefined ? { incidentId } : {}),
        }),
      }),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

  it("acknowledges for the SESSION shop only and starts no scan", async () => {
    mock(acknowledgeGuardIncident).mockResolvedValue(true);
    await expect(ack("inc-2")).resolves.toEqual({ acknowledged: true });
    expect(acknowledgeGuardIncident).toHaveBeenCalledWith(SHOP.id, "inc-2", expect.any(Date));
    expect(dispatchScan).not.toHaveBeenCalled();
    expect(canStartScan).not.toHaveBeenCalled();
  });

  it("an empty or missing id is ignored", async () => {
    await expect(ack("")).resolves.toEqual({ ignored: true });
    await expect(ack()).resolves.toEqual({ ignored: true });
    expect(acknowledgeGuardIncident).not.toHaveBeenCalled();
  });

  it("reports false when the incident is not this shop's open new-host incident", async () => {
    mock(acknowledgeGuardIncident).mockResolvedValue(false);
    await expect(ack("someone-elses")).resolves.toEqual({ acknowledged: false });
  });
});

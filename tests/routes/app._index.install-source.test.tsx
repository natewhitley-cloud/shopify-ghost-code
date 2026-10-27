/**
 * gc-3twe: Home's one-time "How did you find GhostCode?" card at the end of the
 * results view, and its two intents.
 *
 * Strategy (same as app._index.summary-optin.test.tsx): mock I/O at the model
 * boundary, run the REAL loader, then render the REAL Dashboard with that
 * loader data to static markup, so the assertions are on what the merchant
 * actually sees. The answer service is mocked here (its claim and telemetry
 * are covered in tests/services/install-source.server.test.ts).
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
  claimPromptSlot: vi.fn(),
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

vi.mock("../../app/services/install-source.server", () => ({
  recordInstallSourceAnswer: vi.fn(),
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

vi.mock("../../app/lib/plan-gating.server", async (importOriginal) => ({
  // canReceiveAlerts stays REAL: the accept re-check reads it.
  canReceiveAlerts: (await importOriginal<typeof import("../../app/lib/plan-gating.server")>())
    .canReceiveAlerts,
  canStartScan: vi.fn(),
  canUseMultipleThemes: vi.fn(),
  canUseScanDiffing: vi.fn(),
  getScanUsage: vi.fn(),
  getWeekStartUTC: vi.fn(),
}));

vi.mock("../../inngest/client", () => ({
  inngest: { send: vi.fn() },
}));

vi.mock("../../app/models/merchant-alert.server", () => ({
  claimSummaryNoticeShown: vi.fn(),
  dismissSummaryNotice: vi.fn(),
  setSummaryEmailsEnabled: vi.fn(),
  declineSummaryOptIn: vi.fn(),
  claimSummaryOptInFirstShown: vi.fn(),
}));

vi.mock("../../app/services/merchant-alert.server", () => ({
  getMerchantAlertConfigStatus: vi.fn(),
}));

vi.mock("../../app/services/shop-alert-email.server", () => ({
  refreshShopAlertEmail: vi.fn(),
}));

import {
  INSTALL_SOURCE_COPY,
  INSTALL_SOURCE_OPTIONS,
  INSTALL_SOURCE_OTHER_MAX_LEN,
} from "../../app/lib/install-source";
import { canStartScan, getScanUsage } from "../../app/lib/plan-gating.server";
import { getRemovalNoticeRows } from "../../app/models/app-removal.server";
import { getSeverityCountsForScans, getTypeCountsForScan } from "../../app/models/finding.server";
import { getIgnoredFindingsForShop } from "../../app/models/ignored-finding.server";
import {
  getCompletedScansForShop,
  getFirstSuccessfulScanCompletedAt,
  getScansForShop,
  hasCompletedScans,
} from "../../app/models/scan.server";
import {
  claimPromptSlot,
  getOrCreateShopMetadata,
  getShopMetadata,
} from "../../app/models/shop.server";
import Dashboard, { action, loader } from "../../app/routes/app._index";
import { recordInstallSourceAnswer } from "../../app/services/install-source.server";
import { getMerchantAlertConfigStatus } from "../../app/services/merchant-alert.server";
import { recordNudgeStageOnce } from "../../app/services/nudge-stage.server";
import { dispatchScan } from "../../app/services/scan-dispatch.server";
import { refreshShopAlertEmail } from "../../app/services/shop-alert-email.server";
import { resetThemeCaches } from "../../app/services/theme-cache.server";
import { fetchAllThemes, fetchMainTheme } from "../../app/services/theme-fetcher.server";
import { getFreeTopFindings, getFullListTopFindings } from "../../app/services/top-findings.server";
import { authenticate } from "../../app/shopify.server";

const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const DOMAIN = "legacy-merchant.myshopify.com";
const THEME_ID = "gid://shopify/OnlineStoreTheme/77";
const ADMIN = { graphql: vi.fn() };

/**
 * A Professional shop (fixture shared with the summary opt-in tests) whose
 * latest scan completed, so Home renders its results.
 */
const SHOP = {
  id: "shop-legacy",
  domain: DOMAIN,
  plan: "Professional",
  planReconciledAt: null,
  installedAt: new Date("2026-06-01T00:00:00Z"),
  uninstalledAt: null as Date | null,
  lastSeenAt: null,
  lastThemePublishAt: null,
  upgradePreviewShownAt: null,
  feedbackNudgeShownAt: null,
  feedbackNudgeDismissedAt: null,
  feedbackSubmittedAt: null as Date | null,
  firstOpenedAt: new Date("2026-06-01T00:00:00Z"),
  firstResultsViewedAt: new Date("2026-06-02T00:00:00Z"),
  lastPromptKey: null as string | null,
  lastPromptShownAt: null as Date | null,
  reviewPopupRequestedAt: new Date("2026-06-03T00:00:00Z"),
  reviewPopupRetryAfter: null,
  reviewPopupAttemptCount: 1,
  reviewPopupLastAttemptAt: new Date("2026-06-03T00:00:00Z"),
  reviewPopupLastResult: "shown",
  reviewPopupPrevPromptKey: null,
  reviewPopupPrevPromptShownAt: null,
  upgradeReturnLastShownAt: null,
  upgradeReturnLastDismissedAt: null,
  upgradeReturnDismissCount: 0,
  upgradeReturnShownAt: null,
  staleResultsShownAt: null,
  speedTeaserShownAt: null,
  everPaidAt: new Date("2026-06-01T00:00:00Z"),
  alertsEnabled: true,
  alertEmail: "owner@example.com" as string | null,
  removalNoticeDismissedScanId: null,
  summaryNoticePendingAt: null as Date | null,
  summaryNoticeShownAt: null as Date | null,
  summaryOptedInAt: null as Date | null,
  summaryOptInDeclinedAt: null as Date | null,
  summaryOptInFirstShownAt: null as Date | null,
  guardEmailNoticeShownAt: null,
  guardEmailOffAt: null,
  guardEmailConsentHash: null,
  isInternal: false,
  installSourceShownAt: null as Date | null,
  installSourceAnsweredAt: null as Date | null,
  installSourceSkippedAt: null as Date | null,
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

const esc = (s: string) => s.replace(/'/g, "&#x27;");

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
  mock(getFirstSuccessfulScanCompletedAt).mockResolvedValue(new Date("2026-06-02T00:00:00Z"));
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
  mock(claimPromptSlot).mockResolvedValue(true);
  mock(refreshShopAlertEmail).mockResolvedValue(null);
});

const HEADING = INSTALL_SOURCE_COPY.heading;

describe("Home loader: install-source card (gc-3twe)", () => {
  it("with results: shows the card at the very end, after Scan Actions, and records `shown` once", async () => {
    const data = await load();
    expect(data.showInstallSourceCard).toBe(true);
    expect(recordNudgeStageOnce).toHaveBeenCalledWith("install_source", "shown", DOMAIN);
    expect(
      mock(recordNudgeStageOnce).mock.calls.filter(([key]) => key === "install_source"),
    ).toHaveLength(1);

    const html = renderDashboard(data);
    expect(html).toContain(`heading="${esc(HEADING)}"`);
    expect(html).toContain(esc(INSTALL_SOURCE_COPY.body));
    for (const o of INSTALL_SOURCE_OPTIONS) {
      expect(html).toContain(`value="${o.value}"`);
    }
    expect(html).toContain(`maxLength="${INSTALL_SOURCE_OTHER_MAX_LEN}"`);
    expect(html).toContain(`placeholder="${INSTALL_SOURCE_COPY.otherPlaceholder}"`);
    expect(html).toMatch(/<s-button variant="secondary">Send<\/s-button>/);
    expect(html).toMatch(/<s-button variant="tertiary">Skip<\/s-button>/);
    // The last section on the page: after Scan Actions.
    expect(html.indexOf("Scan Actions")).toBeLessThan(html.indexOf(esc(HEADING)));
    expect(html.indexOf(esc(HEADING))).toBeGreaterThan(html.indexOf("View Scan History"));
  });

  it("already shown: renders without another claim (reloads and the 3s poll write nothing)", async () => {
    const data = await load({ installSourceShownAt: new Date("2026-10-20T00:00:00Z") });
    expect(data.showInstallSourceCard).toBe(true);
    expect(
      mock(recordNudgeStageOnce).mock.calls.filter(([key]) => key === "install_source"),
    ).toHaveLength(0);
  });

  it.each<[string, Partial<typeof SHOP>]>([
    ["an internal store", { isInternal: true }],
    ["already answered", { installSourceAnsweredAt: new Date("2026-10-20T00:00:00Z") }],
    ["already skipped", { installSourceSkippedAt: new Date("2026-10-20T00:00:00Z") }],
  ])("hidden for %s, and no `shown`", async (_label, shop) => {
    const data = await load(shop);
    expect(data.showInstallSourceCard).toBe(false);
    expect(recordNudgeStageOnce).not.toHaveBeenCalledWith("install_source", "shown", DOMAIN);
    expect(renderDashboard(data)).not.toContain(esc(HEADING));
  });

  it("hidden while the latest scan is still running (no results on screen)", async () => {
    mock(getScansForShop).mockResolvedValue({
      items: [{ ...COMPLETED, id: "scan-3", status: "RUNNING", completedAt: null }, COMPLETED],
      hasNextPage: false,
    });
    const data = await load();
    expect(data.showInstallSourceCard).toBe(false);
    expect(recordNudgeStageOnce).not.toHaveBeenCalledWith("install_source", "shown", DOMAIN);
  });

  it("never in the onboarding branch (no scan yet)", async () => {
    mock(getScansForShop).mockResolvedValue({ items: [], hasNextPage: false });
    mock(hasCompletedScans).mockResolvedValue(false);
    const data = await load();
    expect(data.showInstallSourceCard).toBe(false);
    expect(renderDashboard(data)).not.toContain(esc(HEADING));
  });
});

describe("Home actions: install-source-answer / install-source-skip (gc-3twe)", () => {
  const post = (fields: Record<string, string>) =>
    action({
      request: new Request("https://example.com/app", {
        method: "POST",
        body: new URLSearchParams(fields),
      }),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

  it("Send: stores the parsed answer for the SESSION shop, before any plan gating", async () => {
    mock(recordInstallSourceAnswer).mockResolvedValue("stored");

    await expect(
      post({ intent: "install-source-answer", source: "other", other: "  a podcast " }),
    ).resolves.toEqual({ installSourceAnswered: true });

    expect(recordInstallSourceAnswer).toHaveBeenCalledExactlyOnceWith(DOMAIN, {
      source: "other",
      other: "a podcast",
    });
    expect(canStartScan).not.toHaveBeenCalled();
    expect(dispatchScan).not.toHaveBeenCalled();
  });

  it("Send drops other text for a non-other choice", async () => {
    await post({ intent: "install-source-answer", source: "sidekick", other: "ignored" });
    expect(recordInstallSourceAnswer).toHaveBeenCalledWith(DOMAIN, {
      source: "sidekick",
      other: null,
    });
  });

  it("a write that failed returns save_failed, so the card comes back with a retry message", async () => {
    mock(recordInstallSourceAnswer).mockResolvedValue("failed");
    await expect(post({ intent: "install-source-answer", source: "web_search" })).resolves.toEqual({
      installSourceError: "save_failed",
    });
  });

  it("a repeat Send (claim lost) still answers ok and changes nothing", async () => {
    mock(recordInstallSourceAnswer).mockResolvedValue("lost");
    await expect(post({ intent: "install-source-answer", source: "web_search" })).resolves.toEqual({
      installSourceAnswered: true,
    });
  });

  it.each([
    ["no choice", {}],
    ["blank choice", { source: "" }],
    ["unknown choice", { source: "tiktok" }],
  ])("Send with %s: an error the card shows, nothing stored", async (_label, fields) => {
    await expect(post({ intent: "install-source-answer", ...fields })).resolves.toEqual({
      installSourceError: "missing_choice",
    });
    expect(recordInstallSourceAnswer).not.toHaveBeenCalled();
    expect(dispatchScan).not.toHaveBeenCalled();
  });

  it("Skip: the once-per-merchant dismissed claim, before any plan gating", async () => {
    await expect(post({ intent: "install-source-skip" })).resolves.toEqual({ dismissed: true });
    expect(recordNudgeStageOnce).toHaveBeenCalledExactlyOnceWith(
      "install_source",
      "dismissed",
      DOMAIN,
    );
    expect(recordInstallSourceAnswer).not.toHaveBeenCalled();
    expect(canStartScan).not.toHaveBeenCalled();
    expect(dispatchScan).not.toHaveBeenCalled();
  });
});

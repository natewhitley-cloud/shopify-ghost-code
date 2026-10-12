/**
 * gc-xorg: Home's one-time "New: summary emails" opt-in prompt for shops paid
 * before gc-ol95 shipped, and its two intents.
 *
 * Strategy (same as app._index.summary-notice.test.tsx): mock I/O at the model
 * boundary, run the REAL loader (with the REAL prompt cap, eligibility and
 * summary-optin service between it and the models), then render the REAL
 * Dashboard with that loader data to static markup, so the assertions are on
 * what the merchant actually sees.
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

import { FEEDBACK_NUDGE_COPY } from "../../app/lib/feedback-nudge";
import { logger } from "../../app/lib/logger.server";
import { canStartScan, getScanUsage } from "../../app/lib/plan-gating.server";
import { getRemovalNoticeRows } from "../../app/models/app-removal.server";
import { getSeverityCountsForScans, getTypeCountsForScan } from "../../app/models/finding.server";
import { getIgnoredFindingsForShop } from "../../app/models/ignored-finding.server";
import {
  claimSummaryNoticeShown,
  claimSummaryOptInFirstShown,
  declineSummaryOptIn,
  setSummaryEmailsEnabled,
} from "../../app/models/merchant-alert.server";
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
import Dashboard, { action, loader, summaryOptInView } from "../../app/routes/app._index";
import { getMerchantAlertConfigStatus } from "../../app/services/merchant-alert.server";
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
const HOUR = 60 * 60 * 1000;
const hoursAgo = (h: number) => new Date(Date.now() - h * HOUR);
/** gc-rxq0: the opt-in is offered for 14 days from its first render. */
const OFFER_HOURS = 14 * 24;

/**
 * A LEGACY Professional shop: paid before gc-ol95 shipped, so no consent stamp
 * of any kind; old enough for the feedback nudge too (the opt-in must win);
 * the review popup already requested (so it never blocks Home).
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

const HEADING = "New: summary emails";
const WEEKLY_BODY =
  "Get a weekly digest of what changed in your store: new or fixed findings, and apps that are no longer active. We&#x27;ll send it to owner@example.com, only when something changed.";

/** The logger.info event names emitted so far. */
const infoEvents = () => mock(logger.info).mock.calls.map(([event]) => event);

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

describe("Home loader: summary-email opt-in (gc-xorg)", () => {
  it("legacy Professional shop: claims the prompt slot and renders the weekly opt-in with the owner email", async () => {
    const data = await load();
    expect(claimPromptSlot).toHaveBeenCalledExactlyOnceWith(
      DOMAIN,
      "summary_optin",
      expect.objectContaining({ lastPromptKey: null, lastPromptShownAt: null }),
      expect.any(Date),
    );
    expect(data.summaryOptIn).toEqual({ email: "owner@example.com", cadence: "weekly" });
    // Outranks the feedback nudge (also eligible): one prompt per view.
    expect(data.showFeedbackNudge).toBe(false);

    const html = renderDashboard(data);
    expect(html).toMatch(/<s-banner[^>]*tone="info"[^>]*heading="New: summary emails"/);
    expect(html).toContain(WEEKLY_BODY);
    expect(html).toMatch(/<s-button[^>]*variant="primary"[^>]*>Turn on<\/s-button>/);
    expect(html).toMatch(/<s-button[^>]*variant="secondary"[^>]*>No thanks<\/s-button>/);
    expect(html).not.toContain(FEEDBACK_NUDGE_COPY.heading);
    expect(html).not.toContain("Summary emails are on");
    expect(html).not.toMatch(/[—–]/);
  });

  it("Standard says monthly", async () => {
    const html = renderDashboard(await load({ plan: "Standard" }));
    expect(html).toContain("Get a monthly digest of what changed in your store:");
  });

  it("first render in a window logs summary_optin_shown with the domain only (never the email)", async () => {
    await load();
    expect(logger.info).toHaveBeenCalledWith("summary_optin_shown", { shop: DOMAIN });
    expect(JSON.stringify(mock(logger.info).mock.calls)).not.toContain("owner@example.com");
  });

  it("re-renders inside its own 24h window (reload / poll): no new claim, no shown log", async () => {
    const data = await load({ lastPromptKey: "summary_optin", lastPromptShownAt: hoursAgo(1) });
    expect(data.summaryOptIn).toEqual({ email: "owner@example.com", cadence: "weekly" });
    expect(claimPromptSlot).not.toHaveBeenCalled();
    expect(infoEvents()).not.toContain("summary_optin_shown");
  });

  it("ignored: shows again on a later visit once its window has passed", async () => {
    const data = await load({ lastPromptKey: "summary_optin", lastPromptShownAt: hoursAgo(25) });
    expect(data.summaryOptIn).not.toBeNull();
    expect(claimPromptSlot).toHaveBeenCalledTimes(1);
    expect(infoEvents()).toContain("summary_optin_shown");
  });

  it("respects the cap: another prompt holding the 24h window = not rendered", async () => {
    const data = await load({ lastPromptKey: "feedback", lastPromptShownAt: hoursAgo(1) });
    expect(data.summaryOptIn).toBeNull();
    expect(claimPromptSlot).not.toHaveBeenCalled();
    expect(renderDashboard(data)).not.toContain(HEADING);
  });

  it("an unknown/retired key holding the window also blocks it", async () => {
    const data = await load({ lastPromptKey: "review_banner", lastPromptShownAt: hoursAgo(1) });
    expect(data.summaryOptIn).toBeNull();
  });

  it("a lost slot claim to another prompt renders nothing", async () => {
    mock(claimPromptSlot).mockResolvedValue(false);
    mock(getShopMetadata).mockResolvedValue({
      ...SHOP,
      lastPromptKey: "feedback",
      lastPromptShownAt: new Date(),
    });
    const data = await load();
    expect(data.summaryOptIn).toBeNull();
    expect(data.showFeedbackNudge).toBe(false);
  });

  it("no cached owner email: reads it on the first render; falls back to the shared phrasing", async () => {
    mock(refreshShopAlertEmail).mockResolvedValue("fresh@example.com");
    let data = await load({ alertEmail: null });
    expect(refreshShopAlertEmail).toHaveBeenCalledWith(DOMAIN, ADMIN);
    expect(data.summaryOptIn?.email).toBe("fresh@example.com");

    mock(refreshShopAlertEmail).mockResolvedValue(null);
    data = await load({ alertEmail: null });
    expect(renderDashboard(data)).toContain(
      "We&#x27;ll send it to your store owner email, only when something changed.",
    );
  });

  it("no cached email on a re-render inside the window: no Admin call (keeps the 3s poll cheap)", async () => {
    const data = await load({
      alertEmail: null,
      lastPromptKey: "summary_optin",
      lastPromptShownAt: hoursAgo(1),
    });
    expect(refreshShopAlertEmail).not.toHaveBeenCalled();
    expect(data.summaryOptIn?.email).toBeNull();
  });

  it.each<[string, Partial<typeof SHOP>, boolean]>([
    ["Free plan", { plan: "free" }, true],
    ["sending not configured", {}, false],
    ["alerts turned off / unsubscribed", { alertsEnabled: false }, true],
    ["uninstalled", { uninstalledAt: hoursAgo(2) }, true],
    ["already opted in", { summaryOptedInAt: hoursAgo(48) }, true],
    ["notice already shown", { summaryNoticeShownAt: hoursAgo(48) }, true],
    ["declined", { summaryOptInDeclinedAt: hoursAgo(48) }, true],
  ])("not rendered and no slot claimed for it: %s", async (_l, shop, configured) => {
    mock(getMerchantAlertConfigStatus).mockReturnValue(
      configured ? { configured: true } : { configured: false, reason: "disabled" },
    );
    const data = await load({ ...shop, feedbackSubmittedAt: new Date("2026-06-05T00:00:00Z") });
    expect(data.summaryOptIn).toBeNull();
    expect(claimPromptSlot).not.toHaveBeenCalledWith(
      DOMAIN,
      "summary_optin",
      expect.anything(),
      expect.anything(),
    );
    expect(renderDashboard(data)).not.toContain(HEADING);
  });

  it("notice owed (Free -> paid): the one-time notice renders instead, never the opt-in", async () => {
    mock(claimSummaryNoticeShown).mockResolvedValue(true);
    const data = await load({ summaryNoticePendingAt: hoursAgo(1) });
    expect(data.summaryOptIn).toBeNull();
    const html = renderDashboard(data);
    expect(html).toContain("Summary emails are on");
    expect(html).not.toContain(HEADING);
  });

  it("first render stamps summaryOptInFirstShownAt for the SESSION shop (gc-rxq0)", async () => {
    mock(claimSummaryOptInFirstShown).mockResolvedValue(true);
    await load();
    expect(claimSummaryOptInFirstShown).toHaveBeenCalledExactlyOnceWith(DOMAIN);
  });

  it("an already-stamped shop renders without a new stamp write", async () => {
    const data = await load({ summaryOptInFirstShownAt: hoursAgo(48) });
    expect(data.summaryOptIn).not.toBeNull();
    expect(claimSummaryOptInFirstShown).not.toHaveBeenCalled();
  });

  it("no stamp when the opt-in does not render (another prompt holds the window)", async () => {
    await load({ lastPromptKey: "feedback", lastPromptShownAt: hoursAgo(1) });
    expect(claimSummaryOptInFirstShown).not.toHaveBeenCalled();
  });

  it("still offered 1 hour before its 14 days are up", async () => {
    const data = await load({ summaryOptInFirstShownAt: hoursAgo(OFFER_HOURS - 1) });
    expect(data.summaryOptIn).toEqual({ email: "owner@example.com", cadence: "weekly" });
    expect(data.showFeedbackNudge).toBe(false);
  });

  it("retired 14 days after first shown: the feedback nudge takes Home's slot; nothing else written", async () => {
    const data = await load({ summaryOptInFirstShownAt: hoursAgo(OFFER_HOURS) });
    expect(data.summaryOptIn).toBeNull();
    expect(data.showFeedbackNudge).toBe(true);
    expect(claimPromptSlot).toHaveBeenCalledExactlyOnceWith(
      DOMAIN,
      "feedback",
      expect.anything(),
      expect.anything(),
    );
    // Retirement is not a decline and not an opt-out.
    expect(declineSummaryOptIn).not.toHaveBeenCalled();
    expect(setSummaryEmailsEnabled).not.toHaveBeenCalled();
    expect(claimSummaryOptInFirstShown).not.toHaveBeenCalled();
    const html = renderDashboard(data);
    expect(html).not.toContain(HEADING);
    expect(html).toContain(FEEDBACK_NUDGE_COPY.heading);
  });

  it("not eligible: the feedback nudge takes Home's slot as before", async () => {
    const data = await load({ summaryOptInDeclinedAt: hoursAgo(48) });
    expect(data.summaryOptIn).toBeNull();
    expect(data.showFeedbackNudge).toBe(true);
    expect(claimPromptSlot).toHaveBeenCalledWith(
      DOMAIN,
      "feedback",
      expect.anything(),
      expect.anything(),
    );
  });
});

describe("Home actions: summary-optin-accept / summary-optin-decline (gc-xorg)", () => {
  const post = (intent: string) =>
    action({
      request: new Request("https://example.com/app", {
        method: "POST",
        body: new URLSearchParams({ intent }),
      }),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

  it("Turn on: the shared Settings opt-in path for the SESSION shop, live (consent stamp)", async () => {
    await expect(post("summary-optin-accept")).resolves.toEqual({ summaryOptedIn: true });
    expect(getShopMetadata).toHaveBeenCalledWith(DOMAIN);
    expect(setSummaryEmailsEnabled).toHaveBeenCalledExactlyOnceWith(SHOP.id, true, {
      sendingLive: true,
      noticeShown: false,
    });
    expect(logger.info).toHaveBeenCalledWith("summary_optin_accepted", { shop: DOMAIN });
    expect(declineSummaryOptIn).not.toHaveBeenCalled();
    expect(dispatchScan).not.toHaveBeenCalled();
    expect(canStartScan).not.toHaveBeenCalled();
  });

  it.each<[string, Partial<typeof SHOP>, boolean]>([
    ["the plan is Free now", { plan: "free" }, true],
    ["sending is not configured", {}, false],
    ["the merchant said No thanks (stale tab)", { summaryOptInDeclinedAt: hoursAgo(1) }, true],
    ["alerts are off / unsubscribed (stale tab)", { alertsEnabled: false }, true],
    [
      "the Free -> paid notice is pending (never offered)",
      { summaryNoticePendingAt: hoursAgo(1) },
      true,
    ],
    ["the shop is uninstalled", { uninstalledAt: hoursAgo(1) }, true],
  ])("Turn on is ignored, nothing written, when %s", async (_l, shop, configured) => {
    mock(getShopMetadata).mockResolvedValue({ ...SHOP, ...shop });
    mock(getMerchantAlertConfigStatus).mockReturnValue(
      configured ? { configured: true } : { configured: false, reason: "no_sender" },
    );
    await expect(post("summary-optin-accept")).resolves.toEqual({ ignored: true });
    expect(setSummaryEmailsEnabled).not.toHaveBeenCalled();
    expect(infoEvents()).not.toContain("summary_optin_accepted");
  });

  it("Turn on from a tab older than the 14-day offer (gc-rxq0): ignored, nothing written, the neutral line", async () => {
    mock(getShopMetadata).mockResolvedValue({
      ...SHOP,
      summaryOptInFirstShownAt: hoursAgo(OFFER_HOURS),
    });
    const result = await post("summary-optin-accept");
    expect(result).toEqual({ ignored: true });
    expect(setSummaryEmailsEnabled).not.toHaveBeenCalled();
    expect(declineSummaryOptIn).not.toHaveBeenCalled();
    expect(infoEvents()).not.toContain("summary_optin_accepted");
    // The client shows the existing neutral "We couldn't turn on summary emails..." line.
    const prompt = { email: "owner@example.com", cadence: "weekly" as const };
    expect(summaryOptInView(prompt, "accept", result as never)).toEqual({
      visible: null,
      confirmed: false,
      failed: true,
    });
  });

  it("Turn on is idempotent: an already-consented shop is left as is", async () => {
    mock(getShopMetadata).mockResolvedValue({ ...SHOP, summaryOptedInAt: hoursAgo(1) });
    await expect(post("summary-optin-accept")).resolves.toEqual({ summaryOptedIn: true });
    expect(setSummaryEmailsEnabled).not.toHaveBeenCalled();
  });

  it("No thanks: stamps the decline for the SESSION shop only, touches nothing else", async () => {
    mock(declineSummaryOptIn).mockResolvedValue(true);
    await expect(post("summary-optin-decline")).resolves.toEqual({ dismissed: true });
    expect(declineSummaryOptIn).toHaveBeenCalledExactlyOnceWith(DOMAIN);
    expect(setSummaryEmailsEnabled).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith("summary_optin_declined", { shop: DOMAIN });
    expect(dispatchScan).not.toHaveBeenCalled();
  });

  it("No thanks is idempotent: a repeat stamps nothing new and logs nothing", async () => {
    mock(declineSummaryOptIn).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await post("summary-optin-decline");
    await expect(post("summary-optin-decline")).resolves.toEqual({ dismissed: true });
    expect(infoEvents().filter((e) => e === "summary_optin_declined")).toHaveLength(1);
  });

  it("a form-supplied shop is ignored: the write keys on the session shop", async () => {
    mock(declineSummaryOptIn).mockResolvedValue(true);
    await action({
      request: new Request("https://example.com/app", {
        method: "POST",
        body: new URLSearchParams({
          intent: "summary-optin-decline",
          shop: "victim.myshopify.com",
          shopId: "other",
        }),
      }),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);
    expect(declineSummaryOptIn).toHaveBeenCalledExactlyOnceWith(DOMAIN);
  });
});

describe("summaryOptInView: client state after a click (gc-xorg)", () => {
  const PROMPT = { email: "owner@example.com", cadence: "weekly" as const };

  it("before any answer: the banner shows, no line", () => {
    expect(summaryOptInView(PROMPT, null, undefined)).toEqual({
      visible: PROMPT,
      confirmed: false,
      failed: false,
    });
  });

  it.each(["accept", "decline"] as const)(
    "right after %s (request in flight): hidden at once, no line yet",
    (answer) => {
      expect(summaryOptInView(PROMPT, answer, undefined)).toEqual({
        visible: null,
        confirmed: false,
        failed: false,
      });
    },
  );

  it("Turn on confirmed by the server: the success line only", () => {
    expect(summaryOptInView(PROMPT, "accept", { summaryOptedIn: true })).toEqual({
      visible: null,
      confirmed: true,
      failed: false,
    });
  });

  it("Turn on ignored by the server: the neutral couldn't-turn-on line only", () => {
    expect(summaryOptInView(PROMPT, "accept", { ignored: true })).toEqual({
      visible: null,
      confirmed: false,
      failed: true,
    });
  });

  it("Turn on answered with an error: the neutral line", () => {
    expect(summaryOptInView(PROMPT, "accept", { error: "Shop not found." })).toEqual({
      visible: null,
      confirmed: false,
      failed: true,
    });
  });

  it("No thanks shows neither line", () => {
    expect(summaryOptInView(PROMPT, "decline", { dismissed: true })).toEqual({
      visible: null,
      confirmed: false,
      failed: false,
    });
  });

  it("stays hidden after the loader revalidates without the prompt", () => {
    expect(summaryOptInView(null, "accept", { summaryOptedIn: true }).visible).toBeNull();
  });
});

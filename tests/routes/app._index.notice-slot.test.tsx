/**
 * gc-np1d.6: Home's one notice slot, through the REAL loader and Dashboard.
 *
 * The pick itself (priority, every pair) is unit-tested in
 * tests/lib/home-notice.test.ts. Here: the loader records no stamp for a
 * prompt that would lose the slot, the page renders at most one slot notice at
 * the bottom, and only the winner's consent claim is posted.
 *
 * The notice services are mocked at their module boundary (their own tests
 * cover when each is owed); the claim hook is a spy, so the test reads which
 * notice the page asked to stamp during render.
 */
import { renderToStaticMarkup } from "react-dom/server";
import type { LoaderFunctionArgs } from "react-router";
import { createRoutesStub } from "react-router";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../app/services/value-action.server", () => ({
  loadValueAction: vi.fn(async () => ({ card: null, cleanCopyFindingIds: [] })),
}));
vi.mock("../../app/shopify.server", () => ({ authenticate: { admin: vi.fn() } }));
vi.mock("../../app/db.server", () => ({ default: {} }));
vi.mock("../../app/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../app/models/shop.server", () => ({
  getShopMetadata: vi.fn(),
  getOrCreateShopMetadata: vi.fn(),
}));
vi.mock("../../app/models/scan.server", () => ({
  getScanById: vi.fn(),
  getScansForShop: vi.fn(),
  hasCompletedScans: vi.fn(),
  getCompletedScansForShop: vi.fn(),
}));
vi.mock("../../app/models/app-removal.server", () => ({
  getRemovalNoticeRows: vi.fn(async () => []),
}));
vi.mock("../../app/services/nudge-stage.server", () => ({ recordNudgeStageOnce: vi.fn() }));
vi.mock("../../app/services/journey-milestone.server", () => ({
  recordJourneyMilestoneOnce: vi.fn(),
  recordScanResultsViewOnce: vi.fn(),
}));
vi.mock("../../app/services/scan-dispatch.server", () => ({ dispatchScan: vi.fn() }));
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
vi.mock("../../inngest/client", () => ({ inngest: { send: vi.fn() } }));
// The slot's candidates, at their module boundary.
vi.mock("../../app/services/prompt-cap.server", () => ({
  loadShopPromptState: vi.fn(),
  resolvePrompt: vi.fn(),
}));
vi.mock("../../app/services/summary-optin.server", () => ({
  summaryOptInForHome: vi.fn(),
  acceptSummaryOptIn: vi.fn(),
  declineSummaryOptInForHome: vi.fn(),
}));
vi.mock("../../app/services/summary-notice.server", () => ({
  summaryNoticeForHome: vi.fn(),
  claimSummaryNoticeRendered: vi.fn(),
}));
vi.mock("../../app/services/storefront-guard-notice.server", () => ({
  guardEmailNoticeForHome: vi.fn(),
  claimGuardEmailNoticeRendered: vi.fn(),
}));
vi.mock("../../app/lib/use-claim-rendered-notice", () => ({ useClaimRenderedNotice: vi.fn() }));

import { FEEDBACK_NUDGE_COPY } from "../../app/lib/feedback-nudge";
import { canUseMultipleThemes, getScanUsage } from "../../app/lib/plan-gating.server";
import { GUARD_NOTICE_HEADING } from "../../app/lib/storefront-guard-copy";
import { SUMMARY_NOTICE_HEADING, SUMMARY_OPTIN_HEADING } from "../../app/lib/summary-email-copy";
import { useClaimRenderedNotice } from "../../app/lib/use-claim-rendered-notice";
import { getRemovalNoticeRows } from "../../app/models/app-removal.server";
import { getSeverityCountsForScans, getTypeCountsForScan } from "../../app/models/finding.server";
import { getIgnoredFindingsForShop } from "../../app/models/ignored-finding.server";
import {
  getCompletedScansForShop,
  getScansForShop,
  hasCompletedScans,
} from "../../app/models/scan.server";
import { getOrCreateShopMetadata, getShopMetadata } from "../../app/models/shop.server";
import Dashboard, { loader } from "../../app/routes/app._index";
import { recordNudgeStageOnce } from "../../app/services/nudge-stage.server";
import { loadShopPromptState, resolvePrompt } from "../../app/services/prompt-cap.server";
import { guardEmailNoticeForHome } from "../../app/services/storefront-guard-notice.server";
import { summaryNoticeForHome } from "../../app/services/summary-notice.server";
import { summaryOptInForHome } from "../../app/services/summary-optin.server";
import { resetThemeCaches } from "../../app/services/theme-cache.server";
import { fetchAllThemes, fetchMainTheme } from "../../app/services/theme-fetcher.server";
import { authenticate } from "../../app/shopify.server";

const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const DOMAIN = "slot-merchant.myshopify.com";
const THEME_ID = "gid://shopify/OnlineStoreTheme/1";
const SHOP = {
  id: "shop-s",
  domain: DOMAIN,
  plan: "Standard",
  installedAt: new Date("2026-09-01T00:00:00Z"),
  uninstalledAt: null,
  lastThemePublishAt: null,
  feedbackNudgeShownAt: null as Date | null,
  firstResultsViewedAt: new Date("2026-09-02T00:00:00Z"),
  lastPromptKey: null,
  lastPromptShownAt: null,
  removalNoticeDismissedScanId: null as string | null,
  guardEmailNoticeShownAt: null as Date | null,
  summaryNoticeShownAt: null as Date | null,
};
const COMPLETED = {
  id: "scan-2",
  shopId: SHOP.id,
  themeId: THEME_ID,
  themeName: "Dawn",
  status: "COMPLETED",
  findingCount: 4,
  startedAt: new Date("2026-10-08T10:00:05Z"),
  completedAt: new Date("2026-10-08T10:01:00Z"),
  createdAt: new Date("2026-10-08T10:00:00Z"),
  viewedOnHomeAt: new Date("2026-10-08T10:02:00Z"),
};
const TWO_THEMES = [
  { id: THEME_ID, name: "Dawn", role: "MAIN", updatedAt: "2026-10-01T00:00:00Z" },
  { id: "t2", name: "Dawn copy", role: "UNPUBLISHED", updatedAt: "2026-09-01T00:00:00Z" },
];

const GUARD_NOTICE = { email: "owner@example.com" };
const SUMMARY_NOTICE = { email: "owner@example.com", cadence: "weekly" as const };
const OPT_IN = { email: "owner@example.com", cadence: "weekly" as const };
const MULTI_THEME_COPY = "Your store has more than one theme.";
const REMOVAL_HEADING = "Yotpo is no longer active in your store";

type Candidates = {
  guard?: boolean;
  summaryNotice?: boolean;
  prompt?: "feedback" | "summary_optin" | null;
  multiTheme?: boolean;
  removal?: boolean;
  shop?: Partial<typeof SHOP>;
};

function setUp(c: Candidates) {
  mock(getOrCreateShopMetadata).mockResolvedValue({ ...SHOP, ...c.shop });
  mock(guardEmailNoticeForHome).mockResolvedValue(c.guard ? GUARD_NOTICE : null);
  mock(summaryNoticeForHome).mockResolvedValue(c.summaryNotice ? SUMMARY_NOTICE : null);
  mock(resolvePrompt).mockResolvedValue(c.prompt ?? null);
  mock(summaryOptInForHome).mockResolvedValue(OPT_IN);
  mock(fetchAllThemes).mockResolvedValue(c.multiTheme ? TWO_THEMES : [TWO_THEMES[0]]);
  mock(getRemovalNoticeRows).mockResolvedValue(
    c.removal ? [{ appName: "Yotpo", leftoverCount: 3, state: "REMOVED" }] : [],
  );
}

function runLoader() {
  return loader({
    request: new Request("https://example.com/app"),
    params: {},
    context: {},
  } as unknown as LoaderFunctionArgs);
}

function renderDashboard(loaderData: unknown): string {
  const Stub = createRoutesStub([
    { id: "dashboard", path: "/app", Component: Dashboard as never, loader: () => loaderData },
  ]);
  return renderToStaticMarkup(
    <Stub initialEntries={["/app"]} hydrationData={{ loaderData: { dashboard: loaderData } }} />,
  );
}

async function renderHome(c: Candidates): Promise<string> {
  setUp(c);
  return renderDashboard(await runLoader());
}

/** The slot notices present in the page, by a text unique to each. */
function slotNotices(html: string): string[] {
  const marks: Array<[string, string]> = [
    ["guard_email", `heading="${GUARD_NOTICE_HEADING}"`],
    ["summary_notice", `heading="${SUMMARY_NOTICE_HEADING}"`],
    ["summary_optin", `heading="${SUMMARY_OPTIN_HEADING}"`],
    ["feedback", FEEDBACK_NUDGE_COPY.body.replace(/'/g, "&#x27;")],
    ["multi_theme", MULTI_THEME_COPY],
    ["app_removed", REMOVAL_HEADING],
  ];
  return marks.filter(([, mark]) => html.includes(mark)).map(([key]) => key);
}

/** First arguments the page passed the claim hook for `intent`, across renders. */
function claimedFor(intent: string): unknown[] {
  return mock(useClaimRenderedNotice)
    .mock.calls.filter(([, form]) => (form as { intent: string }).intent === intent)
    .map(([notice]) => notice);
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
  mock(canUseMultipleThemes).mockReturnValue(false);
  mock(getScanUsage).mockResolvedValue(null);
  mock(getCompletedScansForShop).mockResolvedValue([]);
  mock(hasCompletedScans).mockResolvedValue(true);
  mock(getScansForShop).mockResolvedValue({ items: [COMPLETED], hasNextPage: false });
  mock(getSeverityCountsForScans).mockResolvedValue(
    new Map([["scan-2", { HIGH: 2, MEDIUM: 1, LOW: 1 }]]),
  );
  mock(getTypeCountsForScan).mockResolvedValue({ GHOST_SCRIPT: 3, GHOST_STYLE: 1 });
  mock(getIgnoredFindingsForShop).mockResolvedValue({
    fingerprints: new Set(),
    appNames: new Set(),
  });
  mock(loadShopPromptState).mockResolvedValue({ lastPromptKey: null, lastPromptShownAt: null });
});

// ---------------------------------------------------------------------------
// Loader: a prompt that would lose the slot claims nothing
// ---------------------------------------------------------------------------

describe("Home loader: prompts that would lose the slot record nothing (gc-np1d.6)", () => {
  it("control: no consent notice, the feedback ask is resolved, shown and stamped once", async () => {
    setUp({ prompt: "feedback" });

    const data = await runLoader();

    expect(resolvePrompt).toHaveBeenCalledTimes(1);
    expect(data.showFeedbackNudge).toBe(true);
    expect(recordNudgeStageOnce).toHaveBeenCalledWith("feedback", "shown", DOMAIN);
  });

  it("the guard email notice is offered: no prompt resolved (no slot claim), no feedback `shown`", async () => {
    setUp({ guard: true, prompt: "feedback" });

    const data = await runLoader();

    expect(resolvePrompt).not.toHaveBeenCalled();
    expect(data.showFeedbackNudge).toBe(false);
    expect(recordNudgeStageOnce).not.toHaveBeenCalledWith("feedback", "shown", DOMAIN);
    expect(data.guardEmailNotice).toEqual(GUARD_NOTICE);
  });

  it("the summary notice is offered: the opt-in is not resolved and its first-shown stamp is not written", async () => {
    setUp({ summaryNotice: true, prompt: "summary_optin" });

    const data = await runLoader();

    expect(resolvePrompt).not.toHaveBeenCalled();
    expect(summaryOptInForHome).not.toHaveBeenCalled();
    expect(data.summaryOptIn).toBeNull();
    expect(data.summaryNotice).toEqual(SUMMARY_NOTICE);
  });

  it.each(["guardEmailNoticeShownAt", "summaryNoticeShownAt"] as const)(
    "%s claimed a minute ago (still latched on screen after a revalidation): no prompt, no stamp",
    async (field) => {
      setUp({ prompt: "feedback", shop: { [field]: new Date(Date.now() - 60_000) } });

      const data = await runLoader();

      expect(resolvePrompt).not.toHaveBeenCalled();
      expect(data.showFeedbackNudge).toBe(false);
      expect(recordNudgeStageOnce).not.toHaveBeenCalled();
    },
  );

  it("a consent notice claimed over 24h ago no longer holds the prompts back", async () => {
    setUp({
      prompt: "feedback",
      shop: { guardEmailNoticeShownAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });

    const data = await runLoader();

    expect(resolvePrompt).toHaveBeenCalledTimes(1);
    expect(data.showFeedbackNudge).toBe(true);
    expect(recordNudgeStageOnce).toHaveBeenCalledWith("feedback", "shown", DOMAIN);
  });

  // The feedback ask outranks the multi-theme upsell, so it never loses to it:
  // with both, the feedback ask is shown and its stamp is the winner's.
  it("feedback beside the multi-theme upsell: feedback wins, so its stamp is the winner's", async () => {
    const html = await renderHome({ prompt: "feedback", multiTheme: true });

    expect(recordNudgeStageOnce).toHaveBeenCalledWith("feedback", "shown", DOMAIN);
    expect(slotNotices(html)).toEqual(["feedback"]);
  });
});

// ---------------------------------------------------------------------------
// Render: at most one slot notice, at the bottom
// ---------------------------------------------------------------------------

describe("Home render: one notice slot (gc-np1d.6)", () => {
  it("nothing wants the slot: no slot notice, and no claim posted", async () => {
    const html = await renderHome({});

    expect(slotNotices(html)).toEqual([]);
    expect(claimedFor("guard-email-notice-shown").every((n) => n === null)).toBe(true);
    expect(claimedFor("summary-notice-shown").every((n) => n === null)).toBe(true);
  });

  it("guard notice and summary notice together: only the guard notice renders and claims", async () => {
    const html = await renderHome({ guard: true, summaryNotice: true, multiTheme: true });

    expect(slotNotices(html)).toEqual(["guard_email"]);
    expect(claimedFor("guard-email-notice-shown")).toContainEqual(GUARD_NOTICE);
    // The loser is on no screen, so it records no "shown" consent stamp.
    const summaryClaims = claimedFor("summary-notice-shown");
    expect(summaryClaims.length).toBeGreaterThan(0);
    expect(summaryClaims.every((n) => n === null)).toBe(true);
  });

  it("the summary notice alone wins and claims", async () => {
    const html = await renderHome({ summaryNotice: true, removal: true });

    expect(slotNotices(html)).toEqual(["summary_notice"]);
    expect(claimedFor("summary-notice-shown")).toContainEqual(SUMMARY_NOTICE);
  });

  it("opt-in beside the multi-theme upsell and the removal notice: only the opt-in", async () => {
    const html = await renderHome({ prompt: "summary_optin", multiTheme: true, removal: true });

    expect(slotNotices(html)).toEqual(["summary_optin"]);
  });

  it("multi-theme upsell beside the removal notice: only the upsell", async () => {
    const html = await renderHome({ multiTheme: true, removal: true });

    expect(slotNotices(html)).toEqual(["multi_theme"]);
  });

  it("the removal notice alone shows, with its own copy", async () => {
    const html = await renderHome({ removal: true });

    expect(slotNotices(html)).toEqual(["app_removed"]);
    expect(html).toContain("It left 3 items behind.");
  });

  it("the slot sits at the bottom, after What it's costing you", async () => {
    const html = await renderHome({ prompt: "feedback" });

    const lanes = html.indexOf("What it&#x27;s costing you");
    expect(lanes).toBeGreaterThan(-1);
    expect(html.indexOf(FEEDBACK_NUDGE_COPY.heading)).toBeGreaterThan(lanes);
  });

  it("every candidate at once: one notice, the guard email notice", async () => {
    const html = await renderHome({
      guard: true,
      summaryNotice: true,
      multiTheme: true,
      removal: true,
    });

    expect(slotNotices(html)).toEqual(["guard_email"]);
  });
});

/**
 * Scan page, gc-np1d.6 (page map "### Scan results"):
 *   - Findings grouped by app (decision 3A): one card per app in the paid list
 *     and the Free preview, headed by the app name ("Other code" for none) and
 *     the group's total under the active filters.
 *   - One notice slot (decision A) directly below the value-action card: the
 *     return banner, else the upgrade teaser, else the stale-results notice.
 *     Only the winner records a "shown" stamp; nothing in the slot is a
 *     primary button; a Free page carries at most two upgrade asks.
 *
 * Loader + page rendered together (the same boundaries as
 * app.scans.$scanId.clean-copy-entry.test.tsx).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LoaderFunctionArgs } from "react-router";
import { createRoutesStub } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: vi.fn(),
  },
}));

const dbMock = vi.hoisted(() => ({
  // gc-tib.21: the freshness check's "latest successful scan of this theme".
  scan: { findFirst: vi.fn() },
  // gc-tib.20: the recent-runs read; no runs unless a test sets them.
  fixRun: { findMany: vi.fn(async () => [] as unknown[]) },
}));
vi.mock("../../app/db.server", () => ({
  default: dbMock,
}));

// Checkout guard incidents (gc-1q1s.6): none unless a test sets them.
vi.mock("../../app/services/storefront-guard-home.server", () => ({
  loadGuardHome: vi.fn(),
}));

// claimShopStamp is mocked at the model boundary so the REAL journey-milestone
// service (gc-dpm.1) runs, including its never-throw guard.
vi.mock("../../app/models/shop.server", () => ({
  claimShopStamp: vi.fn(),
  // gc-97k.6/7: the REAL resolvePrompt runs; only its slot write is mocked.
  // (The popup attempt is recorded by the review-request action, not here.)
  claimPromptSlot: vi.fn(),
  getShopMetadata: vi.fn(),
  // gc-97k.9: the REAL upgrade-return service runs; only its writes are mocked.
  startUpgradeReturnEpisode: vi.fn(),
  recordUpgradeReturnDismissal: vi.fn(),
}));

// gc-97k.8: the BillingEvent history read behind trial eligibility, mocked at
// the model boundary so the REAL trial-eligibility service runs.
vi.mock("../../app/models/billing-event.server", () => ({
  hasBillingHistory: vi.fn(),
}));

vi.mock("../../app/models/scan.server", () => ({
  getScanById: vi.fn(),
  // gc-97k.9: the return-visit banner's "first successful scan 24h+ ago" read.
  getFirstSuccessfulScanCompletedAt: vi.fn(),
  // The return banner's "latest results hide findings" read (starvation fix).
  getLatestSuccessfulScanNonMaliciousCount: vi.fn(),
  // gc-mgi: the stale banner's "is this the latest successful scan" read.
  getCompletedScansForShop: vi.fn(),
  // Per-scan "viewed on the scan page" stamp, mocked at the model boundary so
  // the REAL journey-milestone service (never-throws wrapper) runs.
  claimScanViewStamp: vi.fn(),
  // gc-tib.21: the clean copy freshness check (the service's own) reads these.
  SUCCESSFUL_SCAN_STATUSES: ["COMPLETED", "PARTIAL"],
}));

// gc-tib.21: the entry point runs the service's freshness check (one Admin MAIN
// read) and needs a scan-time md5 per file. MAIN is the scan's theme,
// unchanged since the scan, unless a test says otherwise.
const cleanAdmin = vi.hoisted(() => ({ getMainTheme: vi.fn() }));
vi.mock("../../app/services/clean-copy-admin.server", async (importActual) => ({
  ...(await importActual<typeof import("../../app/services/clean-copy-admin.server")>()),
  createCleanCopyAdmin: () => cleanAdmin,
}));
vi.mock("../../app/models/scan-manifest.server", () => ({ getScanManifest: vi.fn() }));

// gc-frda: app-removal reads (queries covered in tests/models/app-removal.server.test.ts).
// No removal by default; the original implementations survive vi.resetAllMocks.
vi.mock("../../app/models/app-removal.server", () => ({
  getAppRemovalForScanApp: vi.fn(async () => null),
  getAppRemovalsDetectedOnScan: vi.fn(async () => []),
}));

vi.mock("../../app/models/finding.server", async (importOriginal) => ({
  countFindingsByApp: vi.fn(async () => []),
  getFindingSummary: vi.fn(),
  getFindingsForScan: vi.fn(),
  getTopFindingsOfTypes: vi.fn(),
  // gc-bn0x "Start here" reads (full-list plans without ignores).
  getTypeSeverityCountsForScan: vi.fn(),
  getTopFindingsInGroup: vi.fn(),
  getFindingsPageForScan: vi.fn(),
  // gc-np1d.6: the Free preview's group totals (one groupBy); none by default.
  getFindingGroupsForScan: vi.fn(async () => []),
  getAppAttributionForScan: vi.fn(),
  getFindingFilterOptionsForScan: vi.fn(),
  getFindingByIdForShop: vi.fn(),
  // Zero-map helpers used by the REAL getFilteredFindingSummary (finding-aggregation
  // is left unmocked). Needed once a test supplies non-empty ignores, which routes
  // aggregation through the materialize-and-filter path instead of the groupBy.
  // The REAL zero maps (pure), so an ignore-path byType has numeric counts the
  // Free preview formula (gc-97k.10) can sum.
  createZeroSeverityCounts: (
    await importOriginal<typeof import("../../app/models/finding.server")>()
  ).createZeroSeverityCounts,
  createZeroTypeCounts: (await importOriginal<typeof import("../../app/models/finding.server")>())
    .createZeroTypeCounts,
}));

// E2.2: the loader now aggregates via getFilteredFindingSummary, which fast-paths
// to getFindingSummary when the shop has no suppressions. Left unmocked (real,
// pure) so the fast-path assertions on getFindingSummary below still hold; only
// the ignore read is mocked to return "no suppressions".
vi.mock("../../app/models/ignored-finding.server", () => ({
  getIgnoredFindingsForShop: vi.fn(),
  ignoreFindingInstance: vi.fn(),
  ignoreFindingApp: vi.fn(),
}));

vi.mock("../../app/lib/plan-gating.server", () => ({
  // gc-mgi: the stale banner's quota check (its period logic is covered in
  // tests/lib/plan-gating.server.test.ts).
  canStartScan: vi.fn(),
  canViewFindingDetails: vi.fn(),
  canUseScanDiffing: vi.fn(),
  canExportPdf: vi.fn(),
  // gc-4n0y: Broken links are Standard+ by plan (coverage notices).
  canDetectDanglingReferences: vi.fn(),
}));

vi.mock("../../app/models/unknown-script.server", () => ({
  getUnknownScriptsForScan: vi.fn(),
  submitSignatureSuggestion: vi.fn(),
  findUnknownScriptForShop: vi.fn(),
}));

vi.mock("../../app/lib/format", () => ({
  formatDate: vi.fn().mockReturnValue("2026-03-22"),
  statusTone: vi.fn().mockReturnValue("info"),
  statusLabel: vi.fn().mockReturnValue("Completed"),
  // Mirror the real implementation so loader gating on successful scans works.
  isSuccessfulScan: (status: string) => status === "COMPLETED" || status === "PARTIAL",
}));

vi.mock("../../app/services/app-lookup.server", () => ({
  isTrackerApp: vi.fn().mockReturnValue(false),
}));

// gc-97k.4: the once-per-merchant nudge recorder (its claim/dedupe logic is
// covered in tests/services/upgrade-preview-nudge.server.test.ts).
vi.mock("../../app/services/upgrade-preview-nudge.server", () => ({
  recordUpgradePreviewStageOnce: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { NEVER_PAYWALLED_FINDING_TYPES } from "../../app/lib/finding-classification";
import { canStartScan, canViewFindingDetails } from "../../app/lib/plan-gating.server";
import { hasBillingHistory } from "../../app/models/billing-event.server";
import {
  countFindingsByApp,
  getAppAttributionForScan,
  getFindingFilterOptionsForScan,
  getFindingGroupsForScan,
  getFindingsForScan,
  getFindingsPageForScan,
  getFindingSummary,
  getTopFindingsInGroup,
  getTopFindingsOfTypes,
  getTypeSeverityCountsForScan,
} from "../../app/models/finding.server";
import { getIgnoredFindingsForShop } from "../../app/models/ignored-finding.server";
import {
  getCompletedScansForShop,
  getFirstSuccessfulScanCompletedAt,
  getLatestSuccessfulScanNonMaliciousCount,
  getScanById,
} from "../../app/models/scan.server";
import {
  claimPromptSlot,
  claimShopStamp,
  getShopMetadata,
  startUpgradeReturnEpisode,
} from "../../app/models/shop.server";
import { getUnknownScriptsForScan } from "../../app/models/unknown-script.server";
import ScanDetail, { loader } from "../../app/routes/app.scans.$scanId";
import { isTrackerApp } from "../../app/services/app-lookup.server";
import { loadGuardHome } from "../../app/services/storefront-guard-home.server";
import { recordUpgradePreviewStageOnce } from "../../app/services/upgrade-preview-nudge.server";
import { authenticate } from "../../app/shopify.server";

const NOW = new Date("2026-03-25T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const PRICING = "https://admin.shopify.com/store/test-shop/charges/ghost-code/pricing_plans";

const SHOP = {
  id: "shop-1",
  domain: "test-shop.myshopify.com",
  plan: "Professional",
  firstResultsViewedAt: new Date("2026-03-01T00:00:00Z") as Date | null,
  lastPromptKey: null as string | null,
  lastPromptShownAt: null as Date | null,
  // The review popup is already done, so the return banner is the top prompt.
  reviewPopupRequestedAt: new Date("2026-02-01T00:00:00Z") as Date | null,
  reviewPopupRetryAfter: null as Date | null,
  reviewPopupAttemptCount: 0,
  reviewPopupLastAttemptAt: null as Date | null,
  reviewPopupLastResult: null as string | null,
  upgradeReturnLastShownAt: null as Date | null,
  upgradeReturnLastDismissedAt: null as Date | null,
  upgradeReturnDismissCount: 0,
  upgradeReturnShownAt: null as Date | null,
  upgradePreviewShownAt: null as Date | null,
  staleResultsShownAt: null as Date | null,
  lastThemePublishAt: null as Date | null,
  installedAt: new Date("2026-02-01T00:00:00Z"),
  feedbackNudgeDismissedAt: null as Date | null,
  feedbackSubmittedAt: null as Date | null,
  everPaidAt: null as Date | null,
};

const SCAN = {
  id: "scan-1",
  shopId: "shop-1",
  themeId: "gid://shopify/Theme/123456",
  themeName: "Dawn",
  status: "COMPLETED",
  findingCount: 10,
  startedAt: new Date("2026-03-20T10:00:00Z"),
  completedAt: new Date("2026-03-20T10:05:00Z"),
  createdAt: new Date("2026-03-20T10:00:00Z"),
  skippedCategories: [] as string[],
  cappedCategories: [] as string[],
  unreachableCategories: [] as string[],
  skippedFiles: [] as string[],
  walkCoverage: null as unknown,
  liveAppHooks: { embedApps: [], scriptTagApps: null } as unknown,
};

const finding = (
  id: string,
  appName: string | null,
  severity: "HIGH" | "MEDIUM" | "LOW",
  over: Record<string, unknown> = {},
) => ({
  id,
  scanId: SCAN.id,
  findingType: "GHOST_SCRIPT",
  filename: `snippets/${id}.liquid`,
  appName,
  lineNumber: 3,
  severity,
  description: "",
  createdAt: new Date("2026-03-20T10:05:00Z"),
  codeSnippet: `<script src='https://cdn.example/${id}.js'></script>`,
  spanStart: null,
  spanEnd: null,
  spanSha256: null,
  ...over,
});

const mockShop = vi.mocked(getShopMetadata);
const claimedColumns = () => vi.mocked(claimShopStamp).mock.calls.map((c) => c[1]);

const run = (url = "https://test-shop.myshopify.com/app/scans/scan-1") =>
  loader({
    request: new Request(url),
    params: { scanId: "scan-1" },
    context: {},
  } as unknown as LoaderFunctionArgs);

async function renderPage(url?: string): Promise<{ html: string; data: Record<string, unknown> }> {
  const data = (await run(url)) as Record<string, unknown>;
  const Stub = createRoutesStub([
    { id: "scan", path: "/app/scans/:scanId", Component: ScanDetail as never, loader: () => data },
  ]);
  const html = renderToStaticMarkup(
    createElement(Stub, {
      initialEntries: ["/app/scans/scan-1"],
      hydrationData: { loaderData: { scan: data } },
    }),
  );
  return { html, data };
}

/** The notice slot's markup ("" when the page renders no slot). */
function slotOf(html: string): string {
  const start = html.indexOf('<div class="scan-notice-slot">');
  if (start === -1) return "";
  // The slot holds one s-banner; it ends at that banner's close.
  const end = html.indexOf("</s-banner>", start);
  return html.slice(start, end + "</s-banner>".length);
}

/** The group headers in page order: [heading, subline]. */
function groupHeaders(html: string): Array<[string, string]> {
  return [
    ...html.matchAll(
      /<section class="finding-group"[^>]*><div[^>]*><h3[^>]*>([^<]*)<\/h3><div[^>]*>([^<]*)<\/div>/g,
    ),
  ].map((m) => [m[1].replace(/&amp;/g, "&"), m[2]]);
}

/** Free shop with `total` findings (half previewed, the rest hidden). */
function freeShop(over: Record<string, unknown> = {}) {
  mockShop.mockResolvedValue({ ...SHOP, plan: "free", ...over } as never);
  vi.mocked(canViewFindingDetails).mockReturnValue(false);
}

function freeFindings(rows: ReturnType<typeof finding>[]) {
  const byType: Record<string, number> = {};
  const bySeverity: Record<string, number> = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const r of rows) {
    byType[r.findingType] = (byType[r.findingType] ?? 0) + 1;
    bySeverity[r.severity] += 1;
  }
  vi.mocked(getFindingSummary).mockResolvedValue({
    total: rows.length,
    bySeverity,
    byType,
  } as never);
  vi.mocked(getTopFindingsOfTypes).mockImplementation((async (
    _scanId: string,
    types: string[],
    take: number,
  ) => rows.filter((r) => types.includes(r.findingType)).slice(0, take)) as never);
}

/** The theme changed after the scan; the Free quota is used. */
function staleAndBlocked() {
  vi.mocked(canStartScan).mockResolvedValue({
    allowed: false,
    reason: "Free plan limit",
    nextScanAt: new Date("2026-04-01T00:00:00Z"),
  } as never);
  return { lastThemePublishAt: new Date("2026-03-21T00:00:00Z") };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("CLEAN_COPY_ENABLED", "false");
  vi.mocked(authenticate.admin).mockResolvedValue({ session: { shop: SHOP.domain } } as never);
  mockShop.mockResolvedValue(SHOP as never);
  vi.mocked(getScanById).mockResolvedValue(SCAN as never);
  vi.mocked(claimPromptSlot).mockResolvedValue(true as never);
  vi.mocked(claimShopStamp).mockResolvedValue(true as never);
  vi.mocked(startUpgradeReturnEpisode).mockResolvedValue(undefined as never);
  vi.mocked(recordUpgradePreviewStageOnce).mockResolvedValue(true as never);
  vi.mocked(hasBillingHistory).mockResolvedValue(false);
  // Return banner eligible: first successful scan 4+ days ago.
  vi.mocked(getFirstSuccessfulScanCompletedAt).mockResolvedValue(new Date(NOW.getTime() - 5 * DAY));
  vi.mocked(getCompletedScansForShop).mockResolvedValue([
    { id: "scan-1", completedAt: SCAN.completedAt, themeName: "Dawn" },
  ] as never);
  vi.mocked(getLatestSuccessfulScanNonMaliciousCount).mockResolvedValue(10);
  vi.mocked(getFindingSummary).mockResolvedValue({
    total: 0,
    bySeverity: { HIGH: 0, MEDIUM: 0, LOW: 0 },
    byType: {},
  } as never);
  vi.mocked(getFindingsPageForScan).mockResolvedValue({
    items: [],
    hasNextPage: false,
    nextCursor: null,
    groups: [],
  });
  vi.mocked(getFindingGroupsForScan).mockResolvedValue([]);
  vi.mocked(getAppAttributionForScan).mockResolvedValue([]);
  vi.mocked(getFindingFilterOptionsForScan).mockResolvedValue({ types: [], apps: [] });
  vi.mocked(isTrackerApp).mockReturnValue(false);
  vi.mocked(canViewFindingDetails).mockReturnValue(true);
  vi.mocked(getTopFindingsOfTypes).mockResolvedValue([]);
  vi.mocked(getTypeSeverityCountsForScan).mockResolvedValue([]);
  vi.mocked(getTopFindingsInGroup).mockResolvedValue([]);
  vi.mocked(getFindingsForScan).mockResolvedValue([]);
  vi.mocked(countFindingsByApp).mockResolvedValue([]);
  vi.mocked(getIgnoredFindingsForShop).mockResolvedValue({
    fingerprints: new Set(),
    appNames: new Set(),
  } as never);
  vi.mocked(getUnknownScriptsForScan).mockResolvedValue([]);
  vi.mocked(loadGuardHome).mockResolvedValue({ incidents: [], status: null } as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Findings grouped by app (decision 3A)
// ---------------------------------------------------------------------------

describe("paid list grouped by app", () => {
  const PAGE = [
    finding("p2", "Privy", "HIGH"),
    finding("p1", "Privy", "LOW"),
    finding("l1", "Loox & Co", "MEDIUM"),
    finding("o1", null, "HIGH"),
  ];
  const GROUPS = [
    { appName: "Privy", count: 2 },
    // Cut by the page boundary: 1 of its 4 rows on this page.
    { appName: "Loox & Co", count: 4 },
    { appName: null, count: 1 },
  ];

  beforeEach(() => {
    vi.mocked(getFindingSummary).mockResolvedValue({
      total: 7,
      bySeverity: { HIGH: 2, MEDIUM: 4, LOW: 1 },
      byType: { GHOST_SCRIPT: 7 },
    } as never);
    vi.mocked(getFindingsPageForScan).mockResolvedValue({
      items: PAGE,
      hasNextPage: true,
      nextCursor: "4",
      groups: GROUPS,
    } as never);
  });

  it("one card per app in the page's order, with the group's full total; no app is Other code", async () => {
    const { html } = await renderPage();

    expect(groupHeaders(html)).toEqual([
      ["Privy", "2 findings"],
      ["Loox & Co", "4 findings"],
      ["Other code", "1 finding"],
    ]);
    // Each row sits in its own app's card.
    const section = (name: string) => {
      const start = html.indexOf(`>${name}</h3>`);
      const end = html.indexOf("</section>", start);
      return html.slice(start, end);
    };
    expect(section("Privy")).toContain('id="finding-p2"');
    expect(section("Privy")).toContain('id="finding-p1"');
    expect(section("Privy")).not.toContain('id="finding-l1"');
    expect(section("Loox &amp; Co")).toContain('id="finding-l1"');
    expect(section("Other code")).toContain('id="finding-o1"');
    // No install status is claimed.
    expect(html).not.toMatch(/Uninstalled ·/);
  });

  it("Load More carries the next page's offset and the active filters", async () => {
    const { html } = await renderPage(
      "https://test-shop.myshopify.com/app/scans/scan-1?severity=HIGH",
    );
    expect(html).toContain('href="/app/scans/scan-1?severity=HIGH&amp;cursor=4"');
    expect(vi.mocked(getFindingsPageForScan).mock.calls[0][1]).toMatchObject({
      severity: "HIGH",
      cursor: undefined,
    });
  });

  it("keeps the row content: ignore controls, Ignore all from the app, export", async () => {
    const { html } = await renderPage();
    expect(html).toContain("Ignore all from Privy");
    expect(html).toContain("Export CSV");
  });
});

describe("Free preview grouped by app", () => {
  it("groups the preview rows by the ranked groups, with each app's total and how many show", async () => {
    freeShop();
    // 6 findings -> 3 previewed (one per lane bucket read), 3 hidden.
    freeFindings([
      finding("loox-high", "Loox", "HIGH"),
      finding("privy-high", "Privy", "HIGH", { findingType: "GHOST_HREFLANG" }),
      finding("other", null, "HIGH", { findingType: "ORPHAN_ASSET" }),
      finding("x1", "Loox", "LOW", { findingType: "GHOST_PIXEL" }),
      finding("x2", "Privy", "LOW", { findingType: "GHOST_PIXEL" }),
      finding("x3", "Privy", "LOW", { findingType: "GHOST_PIXEL" }),
    ]);
    vi.mocked(getFindingGroupsForScan).mockResolvedValue([
      { appName: "Privy", count: 3 },
      { appName: "Loox", count: 2 },
      { appName: null, count: 1 },
    ]);

    const { html, data } = await renderPage();

    // The Free view's counts: never the always-shown types.
    expect(getFindingGroupsForScan).toHaveBeenCalledWith("scan-1", {
      excludeFindingTypes: NEVER_PAYWALLED_FINDING_TYPES,
    });
    // The picker's rows (one per lane) come back in group order: Privy (worst
    // HIGH, 3), Loox (HIGH, 2), then Other code although it is HIGH too.
    expect((data.previewFindings as Array<{ id: string }>).map((f) => f.id)).toEqual([
      "privy-high",
      "loox-high",
      "other",
    ]);
    expect(groupHeaders(html)).toEqual([
      ["Privy", "3 findings · 1 shown"],
      ["Loox", "2 findings · 1 shown"],
      ["Other code", "1 finding"],
    ]);
  });

  it("a shop with ignores counts its kept rows, with no extra groupBy", async () => {
    freeShop();
    const rows = [
      finding("a", "Privy", "HIGH"),
      finding("b", "Privy", "LOW"),
      finding("m", "Bad", "HIGH", { findingType: "MALICIOUS_SCRIPT" }),
      finding("gone", "Ignored App", "HIGH"),
    ];
    vi.mocked(getIgnoredFindingsForShop).mockResolvedValue({
      fingerprints: new Set(),
      appNames: new Set(["Ignored App"]),
    } as never);
    vi.mocked(getFindingsForScan).mockResolvedValue(rows as never);
    vi.mocked(getTopFindingsOfTypes).mockImplementation((async (
      _s: string,
      types: string[],
      take: number,
    ) => rows.filter((r) => types.includes(r.findingType)).slice(0, take)) as never);

    const { data } = await renderPage();

    expect(getFindingGroupsForScan).not.toHaveBeenCalled();
    // Privy's 2 kept rows; the malicious and ignored rows are not counted.
    expect(data.previewGroups).toEqual([{ appName: "Privy", count: 2 }]);
  });
});

// ---------------------------------------------------------------------------
// One notice slot (decision A)
// ---------------------------------------------------------------------------

describe("one notice slot", () => {
  /** Free, 10 findings (5 hidden): return banner and teaser material. */
  function freeWithHidden(over: Record<string, unknown> = {}) {
    freeShop(over);
    freeFindings(
      Array.from({ length: 10 }, (_, i) =>
        finding(`f${i}`, "Privy", "HIGH", {
          findingType: i < 6 ? "GHOST_SCRIPT" : "GHOST_HREFLANG",
        }),
      ),
    );
  }

  it("return banner vs teaser vs stale: only the return banner renders, below the action card", async () => {
    freeWithHidden(staleAndBlocked());

    const { html, data } = await renderPage();

    expect(data.noticeSlot).toBe("upgrade_return");
    const slot = slotOf(html);
    expect(slot).toContain("Not now");
    // The teaser and the stale notice are not on the page.
    expect(html).not.toContain("These results are from");
    expect(html.match(/more findings on Standard/g)).toHaveLength(1);
    // Below the action card, above the findings.
    const heading = (data.valueAction as { heading: string }).heading;
    const card = html.indexOf(`aria-label="${heading}"`);
    expect(card).toBeGreaterThan(-1);
    expect(card).toBeLessThan(html.indexOf('<div class="scan-notice-slot">'));
    // Only the winner stamps.
    expect(claimedColumns()).toEqual(["upgradeReturnShownAt"]);
    expect(recordUpgradePreviewStageOnce).not.toHaveBeenCalled();
  });

  it("teaser vs stale: the teaser renders in the slot and stamps; the stale notice records nothing", async () => {
    freeWithHidden({ ...staleAndBlocked(), upgradeReturnDismissCount: 3 });

    const { html, data } = await renderPage();

    expect(data.noticeSlot).toBe("upgrade_preview");
    expect(slotOf(html)).toContain("more findings on Standard");
    expect(html).not.toContain("These results are from");
    expect(recordUpgradePreviewStageOnce).toHaveBeenCalledWith("shown", SHOP.domain);
    expect(claimedColumns()).not.toContain("staleResultsShownAt");
    // The teaser is no longer inside the Free findings card.
    expect(html.indexOf("more findings on Standard")).toBeLessThan(html.indexOf("Preview: Top"));
  });

  it("stale loses to the teaser: a plain status-bar line says the results may be out of date, with no stamp", async () => {
    freeWithHidden({ ...staleAndBlocked(), upgradeReturnDismissCount: 3 });

    const { html, data } = await renderPage();

    expect(data.noticeSlot).toBe("upgrade_preview");
    expect(data.staleNote).toEqual({ themePublishedAt: new Date("2026-03-21T00:00:00Z") });
    const bar = html.slice(
      html.indexOf('<div class="scan-status-bar">'),
      html.indexOf("</div>", html.indexOf('<div class="scan-status-bar">')),
    );
    const note = bar.slice(bar.indexOf('<span class="scan-stale-note">'));
    expect(note).toContain("Your theme changed on");
    expect(note).toContain("so some findings may already be fixed.");
    // A fact, not an ask: no button, no link.
    expect(note).not.toMatch(/<s-button|<a /);
    expect(claimedColumns()).not.toContain("staleResultsShownAt");
  });

  it("stale loses to the return banner: the same line, no stamp", async () => {
    freeWithHidden(staleAndBlocked());

    const { html, data } = await renderPage();

    expect(data.noticeSlot).toBe("upgrade_return");
    expect(html).toContain('<span class="scan-stale-note">');
    expect(claimedColumns()).not.toContain("staleResultsShownAt");
  });

  it("stale wins the slot: no duplicate status-bar line", async () => {
    freeShop(staleAndBlocked());
    freeFindings([finding("only", "Privy", "HIGH")]);

    const { html, data } = await renderPage();

    expect(data.noticeSlot).toBe("stale_results");
    expect(data.staleNote).toBeNull();
    expect(html).not.toContain("scan-stale-note");
    expect(html.match(/Your theme changed on/g)).toHaveLength(1);
  });

  it("not stale: no line", async () => {
    freeWithHidden();
    const { html, data } = await renderPage();
    expect(data.staleNote).toBeNull();
    expect(html).not.toContain("scan-stale-note");
  });

  it("stale alone (nothing hidden): the stale notice holds the slot and stamps", async () => {
    freeShop(staleAndBlocked());
    freeFindings([finding("only", "Privy", "HIGH")]);

    const { html, data } = await renderPage();

    expect(data.noticeSlot).toBe("stale_results");
    expect(slotOf(html)).toContain("These results are from");
    expect(claimedColumns()).toEqual(["staleResultsShownAt"]);
  });

  it("nothing wants the slot: no slot at all", async () => {
    const { html, data } = await renderPage();
    expect(data.noticeSlot).toBeNull();
    expect(html).not.toContain("scan-notice-slot");
  });

  it.each([
    ["return banner", {}],
    ["teaser", { upgradeReturnDismissCount: 3 }],
  ])("the slot (%s) has no primary button", async (_label, over) => {
    freeWithHidden(over);
    const { html } = await renderPage();
    const slot = slotOf(html);
    expect(slot).toContain("<s-button");
    expect(slot).not.toContain('variant="primary"');
  });

  it("the stale notice in the slot has no primary button (Rescan now is tertiary)", async () => {
    vi.mocked(canStartScan).mockResolvedValue({ allowed: true } as never);
    mockShop.mockResolvedValue({
      ...SHOP,
      plan: "Standard",
      lastThemePublishAt: new Date("2026-03-21T00:00:00Z"),
    } as never);

    const { html } = await renderPage();
    const slot = slotOf(html);
    expect(slot).toContain("Rescan now");
    expect(slot).not.toContain('variant="primary"');
  });

  it.each([
    ["return banner", {}],
    ["teaser", { upgradeReturnDismissCount: 3 }],
  ])(
    "a Free page (%s, truncated walk, stale) carries at most two upgrade asks: card plus slot",
    async (_label, over) => {
      freeWithHidden({ ...staleAndBlocked(), ...over });
      vi.mocked(getScanById).mockResolvedValue({
        ...SCAN,
        walkCoverage: {
          products: { checked: 500, total: null, truncated: true, lastId: "gid://x/1" },
        },
      } as never);

      const { html } = await renderPage();

      // Every upgrade ask links to the plan page; the coverage line has none.
      const asks = html.split(`href="${PRICING}"`).length - 1;
      expect(asks).toBeGreaterThanOrEqual(1);
      expect(asks).toBeLessThanOrEqual(2);
      expect(html).toContain("Professional checks up to");
      expect(slotOf(html)).toContain(`href="${PRICING}"`);
    },
  );
});

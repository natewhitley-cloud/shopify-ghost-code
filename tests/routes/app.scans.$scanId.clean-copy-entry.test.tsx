/**
 * Clean copy entry point on the scan page (gc-tib slice 5, spec section 4).
 *
 * The loader adds `cleanCopy: { eligible, count }` only when CLEAN_COPY_ENABLED
 * is on AND the shop is Professional AND the scan has at least one finding of
 * the 4 fixable types with a removal span. Any other shop or flag state makes
 * no extra read at all. The page shows one secondary "Make a clean copy (N)"
 * button when eligible.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LoaderFunctionArgs } from "react-router";
import { createRoutesStub } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (the same boundaries as app.scans.$scanId.test.ts)
// ---------------------------------------------------------------------------

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: vi.fn(),
  },
}));

vi.mock("../../app/db.server", () => ({
  default: {},
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
}));

// gc-frda: app-removal reads (queries covered in tests/models/app-removal.server.test.ts).
// No removal by default; the original implementations survive vi.resetAllMocks.
vi.mock("../../app/models/app-removal.server", () => ({
  getAppRemovalForScanApp: vi.fn(async () => null),
  getAppRemovalsDetectedOnScan: vi.fn(async () => []),
}));

vi.mock("../../app/models/finding.server", async (importOriginal) => ({
  getFindingSummary: vi.fn(),
  getFindingsForScan: vi.fn(),
  getTopFindingsOfTypes: vi.fn(),
  // gc-bn0x "Start here" reads (full-list plans without ignores).
  getTypeSeverityCountsForScan: vi.fn(),
  getTopFindingsInGroup: vi.fn(),
  getFindingsPageForScan: vi.fn(),
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

import { canViewFindingDetails } from "../../app/lib/plan-gating.server";
import {
  getFindingsForScan,
  getAppAttributionForScan,
  getFindingFilterOptionsForScan,
  getFindingSummary,
  getFindingsPageForScan,
  getTopFindingsOfTypes,
  getTypeSeverityCountsForScan,
  getTopFindingsInGroup,
} from "../../app/models/finding.server";
import { getIgnoredFindingsForShop } from "../../app/models/ignored-finding.server";
import {
  getCompletedScansForShop,
  getFirstSuccessfulScanCompletedAt,
  getLatestSuccessfulScanNonMaliciousCount,
  getScanById,
} from "../../app/models/scan.server";
import { claimPromptSlot, getShopMetadata } from "../../app/models/shop.server";
import { getUnknownScriptsForScan } from "../../app/models/unknown-script.server";
import ScanDetail, { loader } from "../../app/routes/app.scans.$scanId";
import { isTrackerApp } from "../../app/services/app-lookup.server";
import { loadGuardHome } from "../../app/services/storefront-guard-home.server";
import { authenticate } from "../../app/shopify.server";

const SHOP = {
  id: "shop-1",
  domain: "test-shop.myshopify.com",
  plan: "Professional",
  firstResultsViewedAt: new Date("2026-03-01T00:00:00Z") as Date | null,
  lastPromptKey: null as string | null,
  lastPromptShownAt: null as Date | null,
  reviewPopupRequestedAt: null as Date | null,
  reviewPopupRetryAfter: null as Date | null,
  reviewPopupAttemptCount: 0,
  reviewPopupLastAttemptAt: null as Date | null,
  reviewPopupLastResult: null as string | null,
  upgradeReturnLastShownAt: null as Date | null,
  upgradeReturnLastDismissedAt: null as Date | null,
  upgradeReturnDismissCount: 0,
  upgradeReturnShownAt: null as Date | null,
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
  findingCount: 3,
  startedAt: new Date("2026-03-20T10:00:00Z"),
  completedAt: new Date("2026-03-20T10:05:00Z"),
  createdAt: new Date("2026-03-20T10:00:00Z"),
  skippedCategories: [] as string[],
  cappedCategories: [] as string[],
  unreachableCategories: [] as string[],
  skippedFiles: [] as string[],
  // gc-tib.10: the live-embed status the count needs ("Live App" still has an embed on).
  liveAppHooks: { embedApps: ["Live App"], scriptTagApps: null } as unknown,
};

const withSpan = (
  id: string,
  findingType = "GHOST_SCRIPT",
  over: Record<string, unknown> = {},
) => ({
  id,
  findingType,
  filename: "layout/theme.liquid",
  appName: "Ghost App",
  lineNumber: 3,
  severity: "MEDIUM",
  createdAt: new Date("2026-03-20T10:05:00Z"),
  codeSnippet: "<script src='x'></script>",
  spanStart: 10,
  spanEnd: 60,
  spanSha256: "hash",
  ...over,
});

const mockGetShopMetadata = getShopMetadata as ReturnType<typeof vi.fn>;
const mockGetFindingsForScan = getFindingsForScan as ReturnType<typeof vi.fn>;

/** The loader reads the malicious findings with a filter; only the entry point reads them all. */
const unfilteredFindingReads = () =>
  mockGetFindingsForScan.mock.calls.filter((call) => call[1] === undefined).length;

type Entry = { cleanCopy: { eligible: boolean; count: number } };

const run = () =>
  loader({
    request: new Request("https://test-shop.myshopify.com/app/scans/scan-1"),
    params: { scanId: "scan-1" },
    context: {},
  } as unknown as LoaderFunctionArgs);

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CLEAN_COPY_ENABLED", "true");
  (authenticate.admin as ReturnType<typeof vi.fn>).mockResolvedValue({
    session: { shop: SHOP.domain },
  });
  mockGetShopMetadata.mockResolvedValue(SHOP);
  (getScanById as ReturnType<typeof vi.fn>).mockResolvedValue(SCAN);
  (claimPromptSlot as ReturnType<typeof vi.fn>).mockResolvedValue(true);
  (getFirstSuccessfulScanCompletedAt as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  // This scan is the shop's latest successful scan unless a test says otherwise.
  (getCompletedScansForShop as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: "scan-1", completedAt: SCAN.completedAt, themeName: "Dawn" },
  ]);
  (getLatestSuccessfulScanNonMaliciousCount as ReturnType<typeof vi.fn>).mockResolvedValue(10);
  (getFindingSummary as ReturnType<typeof vi.fn>).mockResolvedValue({
    total: 3,
    bySeverity: { HIGH: 1, MEDIUM: 1, LOW: 1 },
    byType: { GHOST_SCRIPT: 3 },
  });
  (getFindingsPageForScan as ReturnType<typeof vi.fn>).mockResolvedValue({
    items: [],
    hasNextPage: false,
    nextCursor: null,
  });
  (getAppAttributionForScan as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (getFindingFilterOptionsForScan as ReturnType<typeof vi.fn>).mockResolvedValue({
    types: [],
    apps: [],
  });
  (isTrackerApp as ReturnType<typeof vi.fn>).mockReturnValue(false);
  (canViewFindingDetails as ReturnType<typeof vi.fn>).mockReturnValue(true);
  (getTopFindingsOfTypes as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (getTypeSeverityCountsForScan as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (getTopFindingsInGroup as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  mockGetFindingsForScan.mockResolvedValue([]);
  (getIgnoredFindingsForShop as ReturnType<typeof vi.fn>).mockResolvedValue({
    fingerprints: new Set(),
    appNames: new Set(),
  });
  (getUnknownScriptsForScan as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  vi.mocked(loadGuardHome).mockResolvedValue({ incidents: [], status: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("scan page Clean copy entry point (loader)", () => {
  it("eligible with a count of the fixable findings that have a span", async () => {
    mockGetFindingsForScan.mockResolvedValue([
      withSpan("a"),
      withSpan("b", "GHOST_SNIPPET"),
      // Not counted: a type that is not fixable, and a fixable one with no span.
      withSpan("c", "GHOST_PAGE"),
      { id: "d", findingType: "GHOST_STYLE", spanStart: null, spanEnd: null, spanSha256: null },
    ]);
    const res = (await run()) as unknown as Entry;
    expect(res.cleanCopy).toEqual({ eligible: true, count: 2 });
  });

  it("not eligible, and no findings read, when the flag is off", async () => {
    vi.stubEnv("CLEAN_COPY_ENABLED", "false");
    mockGetFindingsForScan.mockResolvedValue([withSpan("a")]);
    const res = (await run()) as unknown as Entry;
    expect(res.cleanCopy).toEqual({ eligible: false, count: 0 });
    expect(unfilteredFindingReads()).toBe(0);
  });

  it("not eligible, and no findings read, on Standard or Free", async () => {
    for (const plan of ["Standard", "free"]) {
      mockGetShopMetadata.mockResolvedValue({ ...SHOP, plan });
      mockGetFindingsForScan.mockResolvedValue([withSpan("a")]);
      const res = (await run()) as unknown as Entry;
      expect(res.cleanCopy).toEqual({ eligible: false, count: 0 });
    }
    expect(unfilteredFindingReads()).toBe(0);
  });

  it("not eligible when no finding has a span", async () => {
    mockGetFindingsForScan.mockResolvedValue([
      { id: "a", findingType: "GHOST_SCRIPT", spanStart: null, spanEnd: null, spanSha256: null },
    ]);
    const res = (await run()) as unknown as Entry;
    expect(res.cleanCopy).toEqual({ eligible: false, count: 0 });
  });

  it("not eligible for a scan with no findings", async () => {
    const res = (await run()) as unknown as Entry;
    expect(res.cleanCopy).toEqual({ eligible: false, count: 0 });
  });
});

describe("gc-tib.10: the count matches what the select page can offer", () => {
  it("ignored, live-embed, disallowed-path and unknown-app findings don't count", async () => {
    (getIgnoredFindingsForShop as ReturnType<typeof vi.fn>).mockResolvedValue({
      fingerprints: new Set(),
      appNames: new Set(["Ignored App"]),
    });
    mockGetFindingsForScan.mockResolvedValue([
      withSpan("ok"),
      withSpan("ignored", "GHOST_SCRIPT", { appName: "Ignored App" }),
      withSpan("embed", "GHOST_SCRIPT", { appName: "Live App" }),
      withSpan("path", "GHOST_SCRIPT", { filename: "config/settings_data.json" }),
      withSpan("unknown", "GHOST_SCRIPT", { appName: null }),
    ]);
    const res = (await run()) as unknown as Entry;
    expect(res.cleanCopy).toEqual({ eligible: true, count: 1 });
  });

  it("not on an older scan: no button, no findings read", async () => {
    (getCompletedScansForShop as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "scan-2", completedAt: new Date("2026-03-21T10:00:00Z"), themeName: "Dawn" },
    ]);
    mockGetFindingsForScan.mockResolvedValue([withSpan("a")]);
    const res = (await run()) as unknown as Entry;
    expect(res.cleanCopy).toEqual({ eligible: false, count: 0 });
    expect(unfilteredFindingReads()).toBe(0);
  });

  it("not after the theme was published since the scan", async () => {
    mockGetShopMetadata.mockResolvedValue({
      ...SHOP,
      lastThemePublishAt: new Date("2026-03-21T00:00:00Z"),
    });
    mockGetFindingsForScan.mockResolvedValue([withSpan("a")]);
    expect(((await run()) as unknown as Entry).cleanCopy.eligible).toBe(false);
  });

  it("r4: counts only findings in the files the select page can show", async () => {
    const many = Array.from({ length: 52 }, (_, i) =>
      withSpan(`f${i}`, "GHOST_SCRIPT", {
        filename: `snippets/s${String(i).padStart(2, "0")}.liquid`,
      }),
    );
    mockGetFindingsForScan.mockResolvedValue(many);
    expect(((await run()) as unknown as Entry).cleanCopy.count).toBe(50);
  });

  it("not when the scan's live-embed status is unknown", async () => {
    (getScanById as ReturnType<typeof vi.fn>).mockResolvedValue({ ...SCAN, liveAppHooks: null });
    mockGetFindingsForScan.mockResolvedValue([withSpan("a")]);
    expect(((await run()) as unknown as Entry).cleanCopy.eligible).toBe(false);
  });
});

describe("scan page Clean copy entry point (rendered)", () => {
  async function renderPage(): Promise<string> {
    const data = await run();
    const Stub = createRoutesStub([
      {
        id: "scan",
        path: "/app/scans/:scanId",
        Component: ScanDetail as never,
        loader: () => data,
      },
    ]);
    return renderToStaticMarkup(
      createElement(Stub, {
        initialEntries: ["/app/scans/scan-1"],
        hydrationData: { loaderData: { scan: data } },
      }),
    );
  }

  it("shows one secondary button linking to clean-copy when eligible", async () => {
    mockGetFindingsForScan.mockResolvedValue([withSpan("a"), withSpan("b")]);
    const html = await renderPage();
    expect(html.match(/Make a clean copy \(2\)/g)).toHaveLength(1);
    expect(html).toMatch(
      /<a href="\/app\/scans\/scan-1\/clean-copy"[^>]*><s-button variant="secondary">Make a clean copy \(2\)<\/s-button><\/a>/,
    );
  });

  it("shows no button when not eligible", async () => {
    vi.stubEnv("CLEAN_COPY_ENABLED", "false");
    expect(await renderPage()).not.toContain("clean copy");
  });
});

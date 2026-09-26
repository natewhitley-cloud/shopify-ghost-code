/**
 * gc-bj4: the concurrent first post-install load, end to end at the route layer.
 *
 * React Router runs the parent app.tsx loader and the dashboard (app._index)
 * loader IN PARALLEL. Both now get-or-create the Shop row through the REAL
 * shop model over a stateful fake table, so both may upsert. This proves neither
 * loader throws and the dashboard data renders the onboarding card.
 */
import { renderToStaticMarkup } from "react-dom/server";
import type { LoaderFunctionArgs } from "react-router";
import { createRoutesStub } from "react-router";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: vi.fn() },
}));

// Stateful fake Shop table: the row does not exist until the first upsert.
// A second upsert that lands after the row exists loses the race with P2002
// (the non-native-upsert worst case), which the helper must tolerate.
const fakeDb = vi.hoisted(() => {
  const state: { row: Record<string, unknown> | null; upserts: number } = {
    row: null,
    upserts: 0,
  };
  return {
    state,
    shop: {
      findUnique: async () => state.row,
      upsert: async ({ create }: { create: { domain: string } }) => {
        state.upserts += 1;
        await Promise.resolve();
        if (state.row) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        state.row = {
          id: "shop-new",
          domain: create.domain,
          plan: "free",
          planReconciledAt: null,
          installedAt: new Date(),
          uninstalledAt: null,
          lastSeenAt: null,
          lastThemePublishAt: null,
          hasSeenReviewPrompt: false,
          upgradePreviewShownAt: null,
          feedbackNudgeShownAt: null,
          feedbackNudgeDismissedAt: null,
          feedbackSubmittedAt: null,
          lastPromptKey: null,
          lastPromptShownAt: null,
        };
        return state.row;
      },
      update: async () => state.row,
      updateMany: async () => ({ count: 0 }),
    },
  };
});

vi.mock("../../app/db.server", () => ({ default: fakeDb }));

vi.mock("../../app/models/ops-event.server", () => ({
  recordPageVisit: vi.fn(),
}));

vi.mock("../../app/services/billing-reconciler.server", () => ({
  isPlanReconcileStale: vi.fn(() => false),
  reconcileShopPlan: vi.fn(),
}));

vi.mock("../../app/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
import { loader as appLoader } from "../../app/routes/app";
import Dashboard, { loader as dashboardLoader } from "../../app/routes/app._index";
import { resetThemeCaches } from "../../app/services/theme-cache.server";
import { fetchMainTheme } from "../../app/services/theme-fetcher.server";
import { authenticate } from "../../app/shopify.server";

const DOMAIN = "ortho-like.myshopify.com";

function args(): LoaderFunctionArgs {
  return {
    request: new Request("https://example.com/app"),
    params: {},
    context: {},
  } as unknown as LoaderFunctionArgs;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetThemeCaches();
  fakeDb.state.row = null;
  fakeDb.state.upserts = 0;
  (authenticate.admin as ReturnType<typeof vi.fn>).mockResolvedValue({
    session: { shop: DOMAIN },
    admin: { graphql: vi.fn() },
  });
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

describe("gc-bj4: parent + child loaders racing on a brand-new install", () => {
  it("both upsert without throwing and the dashboard renders the onboarding card", async () => {
    const [, dashboardData] = await Promise.all([appLoader(args()), dashboardLoader(args())]);

    expect(dashboardData.shop).toMatchObject({ id: "shop-new", domain: DOMAIN });

    const Stub = createRoutesStub([
      { id: "dashboard", path: "/app", Component: Dashboard as never, loader: () => dashboardData },
    ]);
    const html = renderToStaticMarkup(
      <Stub
        initialEntries={["/app"]}
        hydrationData={{ loaderData: { dashboard: dashboardData } }}
      />,
    );
    expect(html).toContain("Welcome to Ghost Code");
    expect(html).toMatch(/<s-button[^>]*>Start First Scan<\/s-button>/);
    expect(html).not.toMatch(/<s-button[^>]*disabled[^>]*>Start First Scan/);

    // Both loaders missed the row and both upserted; the loser's P2002 was absorbed.
    expect(fakeDb.state.upserts).toBe(2);
  });
});

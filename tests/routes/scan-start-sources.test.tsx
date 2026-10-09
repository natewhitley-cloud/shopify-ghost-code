/**
 * Scan-start source telemetry: every UI control that starts a merchant scan
 * posts `source` to Home's action (`/app?index`).
 *
 * GC tests run in a node environment (no DOM), so each page is rendered to
 * static markup with the REAL component and a createRoutesStub router, while
 * the JSX runtime is wrapped to capture every `<s-button>`'s props. Each
 * captured onClick is then invoked: a scan-start control drives the REAL
 * fetcher, which posts to the stub route's action, where the form data is
 * recorded. So the assertion is on what each button actually submits, and a
 * new scan button that forgets the source (or posts elsewhere) fails here.
 */
import { renderToStaticMarkup } from "react-dom/server";
import type { ActionFunctionArgs } from "react-router";
import { createRoutesStub } from "react-router";
import { describe, it, expect, vi, beforeEach } from "vitest";

type Captured = { type: string; props: Record<string, unknown> };
const captured = vi.hoisted(() => [] as Captured[]);

// Wrap both JSX runtimes (dev transform uses jsxDEV) to record host elements.
vi.mock("react/jsx-dev-runtime", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, (...a: unknown[]) => unknown>;
  return {
    ...real,
    jsxDEV: (type: unknown, props: Record<string, unknown>, ...rest: unknown[]) => {
      if (typeof type === "string") captured.push({ type, props });
      return real.jsxDEV(type, props, ...rest);
    },
  };
});
vi.mock("react/jsx-runtime", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, (...a: unknown[]) => unknown>;
  const wrap =
    (fn: (...a: unknown[]) => unknown) =>
    (type: unknown, props: Record<string, unknown>, ...rest: unknown[]) => {
      if (typeof type === "string") captured.push({ type, props });
      return fn(type, props, ...rest);
    };
  return { ...real, jsx: wrap(real.jsx), jsxs: wrap(real.jsxs) };
});

vi.mock("../../app/shopify.server", () => ({ authenticate: { admin: vi.fn() } }));
vi.mock("../../app/db.server", () => ({ default: {} }));
vi.mock("../../inngest/client", () => ({ inngest: { send: vi.fn() } }));

import Dashboard from "../../app/routes/app._index";
import ScanDetail from "../../app/routes/app.scans.$scanId";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Every form posted to Home's action, as plain objects. */
const homeActionPosts: Array<Record<string, string>> = [];

async function recordHomeAction({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  homeActionPosts.push(Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)])));
  return { ok: true };
}

function textOf(children: unknown): string {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(textOf).join("");
  return "";
}

/** Captured s-buttons with an onClick, labelled by their text. */
function clickableButtons(): Array<{ label: string; onClick: () => void }> {
  return captured
    .filter((c) => c.type === "s-button" && typeof c.props.onClick === "function")
    .map((c) => ({ label: textOf(c.props.children), onClick: c.props.onClick as () => void }));
}

/** Click one button and wait for the post (if any) to reach the stub action. */
async function clickAndCollect(onClick: () => void): Promise<Array<Record<string, string>>> {
  const before = homeActionPosts.length;
  onClick();
  // A scan-start click posts asynchronously through the router; give it time.
  await new Promise((r) => setTimeout(r, 20));
  return homeActionPosts.slice(before);
}

const NOW = new Date("2026-10-09T12:00:00Z");

const HOME_BASE = {
  shop: {
    id: "shop-1",
    domain: "merchant.myshopify.com",
    plan: "Standard",
    lastThemePublishAt: null,
  },
  latestScan: null,
  latestScanId: null,
  canDiffLatest: false,
  findingSummary: null,
  mainTheme: { id: "gid://shopify/OnlineStoreTheme/1", name: "Dawn" },
  allThemes: [],
  canSelectTheme: false,
  scanUsage: null,
  isFirstScan: true,
  hasResults: false,
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
  topFindings: [],
};

function renderHome(loaderData: unknown) {
  captured.length = 0;
  const Stub = createRoutesStub([
    {
      id: "home",
      path: "/app",
      Component: Dashboard as never,
      loader: () => loaderData,
      action: recordHomeAction,
    },
  ]);
  renderToStaticMarkup(
    <Stub initialEntries={["/app"]} hydrationData={{ loaderData: { home: loaderData } }} />,
  );
}

beforeEach(() => {
  homeActionPosts.length = 0;
});

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

describe("Home scan-start controls post source=home", () => {
  it("onboarding: 'Start First Scan' posts the main theme with source=home", async () => {
    renderHome(HOME_BASE);

    const buttons = clickableButtons();
    expect(buttons.map((b) => b.label)).toEqual(["Start First Scan"]);
    const posts = await clickAndCollect(buttons[0].onClick);

    expect(posts).toEqual([{ themeId: "gid://shopify/OnlineStoreTheme/1", source: "home" }]);
  });

  it("dashboard: main button, rescan nudge, theme-change nudge and trend empty state all post source=home", async () => {
    renderHome({
      ...HOME_BASE,
      isFirstScan: false,
      latestScan: {
        id: "scan-1",
        themeName: "Dawn",
        status: "COMPLETED",
        findingCount: 0,
        createdAt: NOW,
        startedAt: NOW,
        completedAt: NOW,
      },
      latestScanId: "scan-1",
      findingSummary: { bySeverity: { HIGH: 0, MEDIUM: 0, LOW: 0 } },
      hasResults: true,
      showRescanNudge: true,
      showThemeChangeNudge: true,
      trendChartEnabled: true,
      showTrendEmptyState: true,
      scansNeeded: 2,
    });

    const scanButtons = clickableButtons().filter((b) => /scan/i.test(b.label));
    // Rescan nudge, theme-change nudge, main button, trend empty state.
    expect(scanButtons).toHaveLength(4);
    for (const b of scanButtons) {
      const posts = await clickAndCollect(b.onClick);
      expect(posts, b.label).toEqual([
        { themeId: "gid://shopify/OnlineStoreTheme/1", source: "home" },
      ]);
    }
  });

  it("no other Home button starts a scan (every no-intent post carries a source)", async () => {
    renderHome({
      ...HOME_BASE,
      isFirstScan: false,
      latestScan: {
        id: "scan-1",
        themeName: "Dawn",
        status: "COMPLETED",
        findingCount: 0,
        createdAt: NOW,
        startedAt: NOW,
        completedAt: NOW,
      },
      latestScanId: "scan-1",
      findingSummary: { bySeverity: { HIGH: 0, MEDIUM: 0, LOW: 0 } },
      hasResults: true,
      showFeedbackNudge: true,
    });

    for (const b of clickableButtons()) {
      for (const post of await clickAndCollect(b.onClick)) {
        if (!("intent" in post)) expect(post.source, b.label).toBe("home");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Scan page
// ---------------------------------------------------------------------------

const SCAN_PAGE_DATA = {
  shopDomain: "merchant.myshopify.com",
  scan: {
    id: "scan-1",
    themeName: "Dawn",
    themeId: "gid://shopify/OnlineStoreTheme/1",
    status: "COMPLETED",
    startedAt: NOW,
    completedAt: NOW,
    createdAt: NOW,
    findingCount: 0,
    skippedFiles: [],
    skippedCategories: [],
    cappedCategories: [],
    unreachableCategories: [],
  },
  findings: [],
  findingsPagination: { hasNextPage: false, nextCursor: null },
  previewFindings: [],
  topFindings: [],
  upgradeReturn: null,
  upgradePreview: null,
  teaserCta: true,
  staleResults: {
    scanCompletedAt: NOW,
    themePublishedAt: new Date("2026-10-09T13:00:00Z"),
    action: { kind: "rescan" },
  },
  pricingPlansUrl: "https://admin.shopify.com/store/merchant/charges/ghost-code/pricing_plans",
  trialEligible: false,
  reviewRequestNonce: null,
  maliciousFindings: [],
  findingSummary: { total: 0, bySeverity: { HIGH: 0, MEDIUM: 0, LOW: 0 }, byType: {} },
  canViewDetails: true,
  canUseDiffing: false,
  canExportPdf: false,
  hasResults: true,
  unknownScripts: [],
  appAttributionData: [],
  filterOptions: { types: [], apps: [] },
  filters: { severity: "", type: "", app: "", lane: "" },
  laneLabel: "",
  laneSoWhat: "",
};

describe("Scan page 'Rescan now' posts source=scan_page to Home's action", () => {
  it("the stale-results banner's Rescan now posts to /app?index with source=scan_page", async () => {
    captured.length = 0;
    const Stub = createRoutesStub([
      {
        id: "scan",
        path: "/app/scans/:scanId",
        Component: ScanDetail as never,
        loader: () => SCAN_PAGE_DATA,
      },
      // Home's index route: the target of the rescan post.
      { id: "home", path: "/app", index: true, action: recordHomeAction, Component: () => null },
    ]);
    renderToStaticMarkup(
      <Stub
        initialEntries={["/app/scans/scan-1"]}
        hydrationData={{ loaderData: { scan: SCAN_PAGE_DATA } }}
      />,
    );

    const rescan = clickableButtons().filter((b) => b.label === "Rescan now");
    expect(rescan).toHaveLength(1);
    const posts = await clickAndCollect(rescan[0].onClick);

    // Main theme (no themeId): only the source.
    expect(posts).toEqual([{ source: "scan_page" }]);
  });
});

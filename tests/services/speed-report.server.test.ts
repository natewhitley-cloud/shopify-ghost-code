/**
 * Tests for app/services/speed-report.server.ts (gc-wt3y): the gate (flag,
 * plan, install), the not-configured path, URL resolution, one PageSpeed
 * attempt (budget before call, zero calls when gated), page/report roll-up,
 * the Run-now action service, and that the API key never reaches a log line
 * or an OpsEvent.
 *
 * Mocked at the boundaries: Prisma (db.server), the speed-report model, the
 * OpsEvent writer, the Inngest client, and fetch (injected). No network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockDb = vi.hoisted(() => ({ shop: { findUnique: vi.fn() } }));
vi.mock("../../app/db.server", () => ({ default: mockDb }));

const mockModel = vi.hoisted(() => ({
  createSpeedReport: vi.fn(),
  startSpeedReportForRun: vi.fn(),
  startManualSpeedReport: vi.fn(),
  failAbandonedSpeedReport: vi.fn(),
  hasRecentSpeedReportEvent: vi.fn(),
  finishSpeedReport: vi.fn(),
  reservePageSpeedCall: vi.fn(),
  claimSpeedReportRunNow: vi.fn(),
  releaseSpeedReportRunNow: vi.fn(),
  getRecentSpeedReports: vi.fn(),
  getSpeedReportRequestedAt: vi.fn(),
}));
vi.mock("../../app/models/speed-report.server", () => mockModel);

const mockRecordOpsEvent = vi.hoisted(() => vi.fn());
vi.mock("../../app/models/ops-event.server", async (importActual) => {
  const actual = await importActual<typeof import("../../app/models/ops-event.server")>();
  return { ...actual, recordOpsEvent: mockRecordOpsEvent };
});

const mockSend = vi.hoisted(() => vi.fn());
vi.mock("../../inngest/client", () => ({ inngest: { send: mockSend } }));

import { logger } from "../../app/lib/logger.server";
import type { PageSpeedFetch } from "../../app/services/pagespeed-client.server";
import type { SpeedRunSummary } from "../../app/services/speed-attribution.server";
import {
  attemptCalledGoogle,
  attemptHaltsPage,
  attemptHaltsRun,
  buildSpeedPageResult,
  checkSpeedReportEligibility,
  closeAbandonedSpeedReport,
  finalizeSpeedReport,
  isAllowedSpeedTarget,
  isSafeProductHandle,
  pickPublicProductUrl,
  precheckStorefrontPassword,
  prepareSpeedReportRun,
  productUrlOnPrimaryHost,
  requestSpeedReportRunNow,
  resolvePublicProductTarget,
  resolveSpeedTargets,
  RUN_NOW_ERRORS,
  runPageSpeedAttempt,
  type SpeedAttempt,
  type SpeedTargets,
} from "../../app/services/speed-report.server";
import type { StorefrontFetch } from "../../app/services/storefront-fetcher.server";
import {
  buildPageSpeedError,
  buildPageSpeedResponse,
  MYSHOPIFY_HOST,
  STORE_HOST,
  STORE_HOSTS,
} from "../fixtures/pagespeed-lighthouse";

const KEY = "AIza-SECRET-TEST-KEY-987";
const SHOP_ID = "shop-1";
const DOMAIN = MYSHOPIFY_HOST;
const HOME = `https://${STORE_HOST}/`;
const NOW = new Date("2026-10-11T12:00:00.000Z");

const PRO = { id: SHOP_ID, domain: DOMAIN, plan: "Professional", uninstalledAt: null };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function fetchReturning(...responses: Array<() => Response>): PageSpeedFetch {
  const fn = vi.fn();
  for (const r of responses) fn.mockImplementationOnce(async () => r());
  return fn as unknown as PageSpeedFetch;
}

let logSpies: Array<ReturnType<typeof vi.spyOn>>;

function everythingLogged(): string {
  return JSON.stringify([
    ...logSpies.flatMap((s) => s.mock.calls),
    ...mockRecordOpsEvent.mock.calls,
    ...mockModel.finishSpeedReport.mock.calls,
    ...mockSend.mock.calls,
  ]);
}

beforeEach(() => {
  vi.resetAllMocks();
  process.env.SPEED_REPORT_LIVE_ENABLED = "true";
  process.env.PAGESPEED_API_KEY = KEY;
  delete process.env.PAGESPEED_DAILY_CALL_BUDGET;
  mockDb.shop.findUnique.mockResolvedValue(PRO);
  mockModel.reservePageSpeedCall.mockResolvedValue(true);
  mockModel.createSpeedReport.mockResolvedValue({ id: "rep-1", createdAt: NOW });
  mockModel.startSpeedReportForRun.mockResolvedValue({ id: "rep-1" });
  mockModel.startManualSpeedReport.mockResolvedValue(true);
  mockModel.hasRecentSpeedReportEvent.mockResolvedValue(false);
  logSpies = [
    vi.spyOn(logger, "info").mockImplementation(() => {}),
    vi.spyOn(logger, "warn").mockImplementation(() => {}),
    vi.spyOn(logger, "error").mockImplementation(() => {}),
  ];
});

afterEach(() => {
  delete process.env.SPEED_REPORT_LIVE_ENABLED;
  delete process.env.PAGESPEED_API_KEY;
  delete process.env.PAGESPEED_DAILY_CALL_BUDGET;
  for (const s of logSpies) s.mockRestore();
});

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

describe("checkSpeedReportEligibility", () => {
  it("flag off: ineligible without reading the DB", async () => {
    delete process.env.SPEED_REPORT_LIVE_ENABLED;
    await expect(checkSpeedReportEligibility(SHOP_ID)).resolves.toEqual({
      eligible: false,
      reason: "disabled",
    });
    expect(mockDb.shop.findUnique).not.toHaveBeenCalled();
  });

  it("flag must be exactly 'true'", async () => {
    process.env.SPEED_REPORT_LIVE_ENABLED = "TRUE";
    expect((await checkSpeedReportEligibility(SHOP_ID)).eligible).toBe(false);
  });

  it.each([
    ["free", "not_in_plan"],
    ["Standard", "not_in_plan"],
    ["SomethingElse", "not_in_plan"],
  ])("plan %s is not eligible", async (plan, reason) => {
    mockDb.shop.findUnique.mockResolvedValue({ ...PRO, plan });
    await expect(checkSpeedReportEligibility(SHOP_ID)).resolves.toEqual({
      eligible: false,
      reason,
    });
  });

  it("an uninstalled or missing shop is not eligible", async () => {
    mockDb.shop.findUnique.mockResolvedValue({ ...PRO, uninstalledAt: NOW });
    expect(await checkSpeedReportEligibility(SHOP_ID)).toEqual({
      eligible: false,
      reason: "uninstalled",
    });
    mockDb.shop.findUnique.mockResolvedValue(null);
    expect(await checkSpeedReportEligibility(SHOP_ID)).toEqual({
      eligible: false,
      reason: "no_shop",
    });
  });

  it("Professional + installed + flag on is eligible", async () => {
    await expect(checkSpeedReportEligibility(SHOP_ID)).resolves.toEqual({
      eligible: true,
      shop: { id: SHOP_ID, domain: DOMAIN, plan: "Professional" },
    });
  });
});

// ---------------------------------------------------------------------------
// prepare
// ---------------------------------------------------------------------------

describe("prepareSpeedReportRun", () => {
  const RUN = "run-1";
  // The worker picks the run up 3 h after the click (queued behind a batch).
  const STARTED = new Date(NOW.getTime() + 3 * 3_600_000);

  it("SCHEDULED + eligible: starts the run's report row and proceeds", async () => {
    const r = await prepareSpeedReportRun({
      shopId: SHOP_ID,
      origin: "SCHEDULED",
      runId: RUN,
      now: STARTED,
    });
    expect(r).toEqual({
      proceed: true,
      reportId: "rep-1",
      shopDomain: DOMAIN,
      startedAt: STARTED.toISOString(),
    });
    expect(mockModel.startSpeedReportForRun).toHaveBeenCalledWith(
      SHOP_ID,
      "SCHEDULED",
      RUN,
      STARTED,
    );
    expect(mockModel.createSpeedReport).not.toHaveBeenCalled();
  });

  it("a retried prepare reuses the run's row: the same report, no orphan (gc-wt3y #8)", async () => {
    mockDb.shop.findUnique.mockResolvedValue(PRO);
    // First attempt: the row is made, then the step dies before returning.
    mockModel.finishSpeedReport.mockRejectedValueOnce(new Error("db blip"));
    delete process.env.PAGESPEED_API_KEY;
    await expect(
      prepareSpeedReportRun({ shopId: SHOP_ID, origin: "SCHEDULED", runId: RUN, now: STARTED }),
    ).rejects.toThrow("db blip");
    await prepareSpeedReportRun({ shopId: SHOP_ID, origin: "SCHEDULED", runId: RUN, now: STARTED });
    expect(mockModel.startSpeedReportForRun.mock.calls.map((c) => c[2])).toEqual([RUN, RUN]);
    expect(mockModel.createSpeedReport).not.toHaveBeenCalled();
  });

  it("MANUAL with a reportId: stamps the action's row with the run and the START time (gc-wt3y #3)", async () => {
    const r = await prepareSpeedReportRun({
      shopId: SHOP_ID,
      origin: "MANUAL",
      reportId: "rep-9",
      runId: RUN,
      now: STARTED,
    });
    expect(r).toMatchObject({ proceed: true, reportId: "rep-9", startedAt: STARTED.toISOString() });
    expect(mockModel.startManualSpeedReport).toHaveBeenCalledWith("rep-9", RUN, STARTED);
    expect(mockModel.startSpeedReportForRun).not.toHaveBeenCalled();
  });

  it("MANUAL row gone or no longer RUNNING: stops without a call", async () => {
    mockModel.startManualSpeedReport.mockResolvedValue(false);
    const r = await prepareSpeedReportRun({
      shopId: SHOP_ID,
      origin: "MANUAL",
      reportId: "rep-9",
      runId: RUN,
    });
    expect(r).toEqual({ proceed: false, outcome: "no_report" });
  });

  it("flag off: no row, no event", async () => {
    delete process.env.SPEED_REPORT_LIVE_ENABLED;
    const r = await prepareSpeedReportRun({ shopId: SHOP_ID, origin: "SCHEDULED", runId: RUN });
    expect(r).toEqual({ proceed: false, outcome: "disabled" });
    expect(mockModel.startSpeedReportForRun).not.toHaveBeenCalled();
    expect(mockRecordOpsEvent).not.toHaveBeenCalled();
  });

  it("downgraded since the click: closes the MANUAL row as FAILED/not_eligible", async () => {
    mockDb.shop.findUnique.mockResolvedValue({ ...PRO, plan: "Standard" });
    const r = await prepareSpeedReportRun({
      shopId: SHOP_ID,
      origin: "MANUAL",
      reportId: "rep-9",
      runId: RUN,
    });
    expect(r).toEqual({ proceed: false, outcome: "not_in_plan" });
    expect(mockModel.finishSpeedReport).toHaveBeenCalledWith("rep-9", {
      status: "FAILED",
      failureReason: "not_eligible",
      pages: null,
      psiCalls: 0,
    });
  });

  it("key missing while flag on: FAILED/not_configured row + a not-configured ops event, no crash", async () => {
    delete process.env.PAGESPEED_API_KEY;
    const r = await prepareSpeedReportRun({ shopId: SHOP_ID, origin: "SCHEDULED", runId: RUN });
    expect(r).toEqual({ proceed: false, outcome: "not_configured" });
    expect(mockModel.finishSpeedReport).toHaveBeenCalledWith("rep-1", {
      status: "FAILED",
      failureReason: "not_configured",
      pages: null,
      psiCalls: 0,
    });
    expect(mockRecordOpsEvent).toHaveBeenCalledWith({
      eventType: "speed_report",
      key: DOMAIN,
      metadata: {
        status: "FAILED",
        origin: "SCHEDULED",
        calls: 0,
        durationMs: 0,
        reason: "not_configured",
      },
    });
  });

  it("a blank key counts as missing", async () => {
    process.env.PAGESPEED_API_KEY = "   ";
    expect(
      await prepareSpeedReportRun({ shopId: SHOP_ID, origin: "SCHEDULED", runId: RUN }),
    ).toEqual({
      proceed: false,
      outcome: "not_configured",
    });
  });
});

describe("closeAbandonedSpeedReport (gc-wt3y #2/#3)", () => {
  const base = { shopId: SHOP_ID, runId: "run-1" };
  const claimedAt = "2026-10-11T11:00:00.000Z";
  const previous = "2026-10-01T00:00:00.000Z";

  beforeEach(() => {
    mockModel.failAbandonedSpeedReport.mockResolvedValue(1);
  });

  it("MANUAL: closes the row FAILED, writes the ops event and hands the Run-now slot back", async () => {
    await closeAbandonedSpeedReport(
      {
        ...base,
        origin: "MANUAL",
        reportId: "rep-9",
        runNowClaimedAt: claimedAt,
        runNowPrevious: previous,
      },
      "worker_failed",
      NOW,
    );
    expect(mockModel.failAbandonedSpeedReport).toHaveBeenCalledWith(
      { shopId: SHOP_ID, runId: "run-1", reportId: "rep-9" },
      "worker_failed",
      NOW,
    );
    expect(mockModel.releaseSpeedReportRunNow).toHaveBeenCalledWith(
      SHOP_ID,
      new Date(claimedAt),
      new Date(previous),
    );
    expect(mockRecordOpsEvent).toHaveBeenCalledWith({
      eventType: "speed_report",
      key: DOMAIN,
      metadata: {
        status: "FAILED",
        origin: "MANUAL",
        calls: 0,
        durationMs: 0,
        reason: "worker_failed",
      },
    });
  });

  it("MANUAL first click (no previous claim): the slot goes back to null", async () => {
    await closeAbandonedSpeedReport(
      {
        ...base,
        origin: "MANUAL",
        reportId: "rep-9",
        runNowClaimedAt: claimedAt,
        runNowPrevious: null,
      },
      "stuck",
      NOW,
    );
    expect(mockModel.releaseSpeedReportRunNow).toHaveBeenCalledWith(
      SHOP_ID,
      new Date(claimedAt),
      null,
    );
  });

  it("SCHEDULED: closes by run id, never touches the Run-now slot", async () => {
    await closeAbandonedSpeedReport({ ...base, origin: "SCHEDULED" }, "stuck", NOW);
    expect(mockModel.failAbandonedSpeedReport).toHaveBeenCalledWith(
      { shopId: SHOP_ID, runId: "run-1" },
      "stuck",
      NOW,
    );
    expect(mockModel.releaseSpeedReportRunNow).not.toHaveBeenCalled();
    expect(mockRecordOpsEvent.mock.calls[0][0].metadata).toMatchObject({ reason: "stuck" });
  });

  it("no RUNNING row (finished, or the shop was redacted): no ops event is written", async () => {
    mockModel.failAbandonedSpeedReport.mockResolvedValue(0);
    await closeAbandonedSpeedReport({ ...base, origin: "SCHEDULED" }, "worker_failed", NOW);
    expect(mockRecordOpsEvent).not.toHaveBeenCalled();
  });

  it("row closed but the shop row is gone: no ops event keyed on a redacted shop", async () => {
    mockDb.shop.findUnique.mockResolvedValue(null);
    await closeAbandonedSpeedReport({ ...base, origin: "SCHEDULED" }, "worker_failed", NOW);
    expect(mockRecordOpsEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

function adminWith(...bodies: Array<unknown | Error>) {
  const graphql = vi.fn();
  for (const b of bodies) {
    if (b instanceof Error) graphql.mockRejectedValueOnce(b);
    else graphql.mockResolvedValueOnce({ json: async () => b });
  }
  return { graphql };
}

const SHOP_BODY = {
  data: {
    shop: {
      primaryDomain: { url: `https://${STORE_HOST.toUpperCase()}`, host: STORE_HOST },
      myshopifyDomain: MYSHOPIFY_HOST,
    },
  },
};

/** A storefront fetch that must never run. */
function noStorefront() {
  return vi.fn(async () => {
    throw new Error("storefront must not be read");
  });
}

function resolve(admin: ReturnType<typeof adminWith>): ReturnType<typeof resolveSpeedTargets> {
  return resolveSpeedTargets(admin as unknown as Parameters<typeof resolveSpeedTargets>[0]);
}

describe("resolveSpeedTargets", () => {
  it("homepage on the primary domain + the first product with an online store URL", async () => {
    const admin = adminWith(SHOP_BODY, {
      data: {
        products: {
          nodes: [
            { onlineStoreUrl: null },
            { onlineStoreUrl: `https://${STORE_HOST}/products/duck-treats?variant=1#x` },
            { onlineStoreUrl: `https://${STORE_HOST}/products/second` },
          ],
        },
      },
    });
    await expect(resolve(admin)).resolves.toEqual({
      ok: true,
      targets: {
        homeUrl: HOME,
        primaryHost: STORE_HOST,
        storeHosts: STORE_HOSTS,
        product: { status: "OK", url: `https://${STORE_HOST}/products/duck-treats` },
      },
    });
    // Stable choice: oldest active product first.
    expect(admin.graphql.mock.calls[1][0]).toContain("sortKey: ID");
    expect(admin.graphql.mock.calls[1][0]).toContain("status:active");
  });

  it("moves a product URL on another host (e.g. myshopify) onto the primary host", async () => {
    const admin = adminWith(SHOP_BODY, {
      data: { products: { nodes: [{ onlineStoreUrl: `https://${MYSHOPIFY_HOST}/products/a` }] } },
    });
    const r = await resolve(admin);
    expect(r.ok && r.targets.product).toEqual({
      status: "OK",
      url: `https://${STORE_HOST}/products/a`,
    });
  });

  it("NO_PRODUCT when no product is published to the online store", async () => {
    for (const nodes of [[], [{ onlineStoreUrl: null }, { onlineStoreUrl: "not a url" }]]) {
      const r = await resolve(adminWith(SHOP_BODY, { data: { products: { nodes } } }));
      expect(r.ok && r.targets.product).toEqual({ status: "NO_PRODUCT" });
    }
  });

  it("NEEDS_PRODUCT_ACCESS when read_products is not granted (returned or thrown); the public fallback is a later, separate step", async () => {
    const returned = adminWith(SHOP_BODY, {
      errors: [
        { message: "Access denied for products field.", extensions: { code: "ACCESS_DENIED" } },
      ],
    });
    expect(((await resolve(returned)) as { targets: SpeedTargets }).targets.product).toEqual({
      status: "NEEDS_PRODUCT_ACCESS",
    });
    const thrownErr = Object.assign(new Error("GraphQL Client: Forbidden"), {
      body: { errors: { graphQLErrors: [{ extensions: { code: "ACCESS_DENIED" } }] } },
    });
    expect(
      ((await resolve(adminWith(SHOP_BODY, thrownErr))) as { targets: SpeedTargets }).targets
        .product,
    ).toEqual({ status: "NEEDS_PRODUCT_ACCESS" });
  });

  it("product lookup FAILED on any other error, homepage still tested", async () => {
    const r = await resolve(adminWith(SHOP_BODY, new Error("THROTTLED")));
    expect(r).toMatchObject({
      ok: true,
      targets: { homeUrl: HOME, product: { status: "FAILED" } },
    });
    const r2 = await resolve(adminWith(SHOP_BODY, { errors: [{ message: "Internal" }] }));
    expect(r2).toMatchObject({ ok: true, targets: { product: { status: "FAILED" } } });
  });

  it("no usable primary domain (missing, IP literal) -> not ok, no_domain", async () => {
    for (const shop of [
      { primaryDomain: null },
      { primaryDomain: { url: "https://10.0.0.1", host: "10.0.0.1" } },
      { primaryDomain: { url: "::bad", host: "http://evil" } },
    ]) {
      expect(await resolve(adminWith({ data: { shop } }))).toEqual({
        ok: false,
        reason: "no_domain",
      });
    }
  });

  it("the Admin API call failing (thrown, or GraphQL errors) is admin_unavailable, not no_domain (gc-wt3y #12)", async () => {
    expect(await resolve(adminWith(new Error("401")))).toEqual({
      ok: false,
      reason: "admin_unavailable",
    });
    expect(await resolve(adminWith({ errors: [{ message: "Throttled" }] }))).toEqual({
      ok: false,
      reason: "admin_unavailable",
    });
  });
});

describe("target hygiene", () => {
  it("isAllowedSpeedTarget: https on exactly the primary host, no creds/port", () => {
    expect(isAllowedSpeedTarget(HOME, STORE_HOST)).toBe(true);
    expect(isAllowedSpeedTarget(`https://${STORE_HOST}/products/a`, STORE_HOST)).toBe(true);
    for (const bad of [
      `http://${STORE_HOST}/`,
      `https://evil.example/`,
      `https://sub.${STORE_HOST}/`,
      `https://${STORE_HOST}:8443/`,
      `https://user:pw@${STORE_HOST}/`,
      "javascript:alert(1)",
      "not a url",
    ]) {
      expect(isAllowedSpeedTarget(bad, STORE_HOST)).toBe(false);
    }
    expect(isAllowedSpeedTarget("https://127.0.0.1/", "127.0.0.1")).toBe(false);
  });

  it("productUrlOnPrimaryHost keeps only a product path", () => {
    expect(productUrlOnPrimaryHost(`https://x.example/en-ca/products/a/`, STORE_HOST)).toBe(
      `https://${STORE_HOST}/en-ca/products/a/`,
    );
    expect(productUrlOnPrimaryHost(`https://x.example/collections/a`, STORE_HOST)).toBeNull();
    expect(productUrlOnPrimaryHost(`ftp://x.example/products/a`, STORE_HOST)).toBeNull();
    expect(productUrlOnPrimaryHost(null, STORE_HOST)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Product fallback without read_products (gc-9mbw): public /products.json
// ---------------------------------------------------------------------------

type PublicProduct = {
  id?: unknown;
  handle?: unknown;
  created_at?: unknown;
  published_at?: unknown;
};

function product(handle: unknown, createdAt: string, extra: Partial<PublicProduct> = {}) {
  return {
    id: 1,
    handle,
    created_at: createdAt,
    published_at: createdAt,
    ...extra,
  };
}

function productsJson(products: PublicProduct[]): Response {
  return new Response(JSON.stringify({ products }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

/** A storefront fetch answering each request in turn. */
function storefront(...responses: Array<() => Response>) {
  const fn = vi.fn();
  for (const r of responses) fn.mockImplementationOnce(async () => r());
  return fn;
}

function fallbackProduct(fetchImpl: StorefrontFetch) {
  return resolvePublicProductTarget({
    shopId: SHOP_ID,
    primaryHost: STORE_HOST,
    storeHosts: STORE_HOSTS,
    fetchImpl,
  });
}

describe("product fallback without read_products (gc-9mbw)", () => {
  it("picks the OLDEST published product from /products.json on the primary host", async () => {
    const fetchImpl = storefront(() =>
      productsJson([
        product("newest", "2026-09-01T00:00:00Z", { id: 30 }),
        product("oldest", "2024-01-02T00:00:00-05:00", { id: 20 }),
        product("middle", "2025-05-01T00:00:00Z", { id: 10 }),
        // Same instant as "oldest": the lower id wins the tie.
        product("oldest-tie-higher-id", "2024-01-02T05:00:00Z", { id: 21 }),
      ]),
    );

    expect(await fallbackProduct(fetchImpl)).toEqual({
      status: "OK",
      url: `https://${STORE_HOST}/products/oldest`,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [URL, Record<string, unknown>];
    expect(url.toString()).toBe(`https://${STORE_HOST}/products.json?limit=250`);
    expect(init.redirect).toBe("manual");
    expect(init.dispatcher).toBeDefined();
    expect((init.headers as Record<string, string>).Accept).toBe("application/json");
  });

  it("skips unpublished products and ones without a parseable created_at", async () => {
    const fetchImpl = storefront(() =>
      productsJson([
        product("draft", "2020-01-01T00:00:00Z", { published_at: null }),
        product("no-date", "not a date"),
        product("live", "2026-01-01T00:00:00Z"),
      ]),
    );
    expect(await fallbackProduct(fetchImpl)).toEqual({
      status: "OK",
      url: `https://${STORE_HOST}/products/live`,
    });
  });

  it("encodes a non-Latin handle into a single path segment", async () => {
    const fetchImpl = storefront(() =>
      productsJson([product("ドッグ-treats", "2026-01-01T00:00:00Z")]),
    );
    expect(await fallbackProduct(fetchImpl)).toEqual({
      status: "OK",
      url: `https://${STORE_HOST}/products/${encodeURIComponent("ドッグ-treats")}`,
    });
  });

  it("follows a redirect to the shop's myshopify host, still testing the primary host", async () => {
    const fetchImpl = storefront(
      () => redirect(`https://${MYSHOPIFY_HOST}/products.json?limit=250`, 301),
      () => productsJson([product("a", "2026-01-01T00:00:00Z")]),
    );
    expect(await fallbackProduct(fetchImpl)).toEqual({
      status: "OK",
      url: `https://${STORE_HOST}/products/a`,
    });
  });

  it.each([
    ["password page (redirect to /password)", () => redirect("/password")],
    ["404 (endpoint disabled)", () => new Response("Not found", { status: 404 })],
    ["500", () => new Response("oops", { status: 500 })],
    ["malformed JSON", () => new Response("{ products: [", { status: 200 })],
    [
      "an HTML page served with 200",
      () => new Response("<!doctype html><html></html>", { status: 200 }),
    ],
    ["JSON without a products array", () => new Response('{"products":{}}', { status: 200 })],
    ["an empty product list", () => productsJson([])],
    ["JSON null", () => new Response("null", { status: 200 })],
  ])("%s: homepage only, same NEEDS_PRODUCT_ACCESS message", async (_label, response) => {
    expect(await fallbackProduct(storefront(response))).toEqual({
      status: "NEEDS_PRODUCT_ACCESS",
    });
  });

  it("refuses a redirect to another domain (no request to it)", async () => {
    const fetchImpl = storefront(
      () => redirect("https://evil.example/products.json"),
      () => productsJson([product("a", "2026-01-01T00:00:00Z")]),
    );
    expect(await fallbackProduct(fetchImpl)).toEqual({ status: "NEEDS_PRODUCT_ACCESS" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses a malformed redirect (http, credentials, IP literal)", async () => {
    for (const location of [
      `http://${STORE_HOST}/products.json`,
      `https://user:pw@${STORE_HOST}/products.json`,
      "https://10.0.0.1/products.json",
    ]) {
      const fetchImpl = storefront(() => redirect(location));
      expect(await fallbackProduct(fetchImpl)).toEqual({ status: "NEEDS_PRODUCT_ACCESS" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  describe("handle injection never leaves the primary host or the product path", () => {
    const BAD_HANDLES: unknown[] = [
      "a/b",
      "..",
      "../admin",
      "//evil.com",
      "%2F%2Fevil.com",
      "a%2Fb",
      "evil.com",
      "a?b=1",
      "a#b",
      "a b",
      "\\evil.com",
      "@evil.com",
      "https://evil.com",
      "",
      "-leading-dash",
      "a\nb",
      42,
      null,
      "x".repeat(256),
    ];

    it.each(BAD_HANDLES.map((h) => [JSON.stringify(h), h]))(
      "handle %s alone: no product, homepage only",
      async (_label, handle) => {
        const fetchImpl = storefront(() => productsJson([product(handle, "2020-01-01T00:00:00Z")]));
        expect(await fallbackProduct(fetchImpl)).toEqual({ status: "NEEDS_PRODUCT_ACCESS" });
      },
    );

    it("an older product with a bad handle is skipped for the next safe one", async () => {
      const fetchImpl = storefront(() =>
        productsJson([
          ...BAD_HANDLES.map((h) => product(h, "2019-01-01T00:00:00Z")),
          product("safe-one", "2026-01-01T00:00:00Z"),
        ]),
      );
      expect(await fallbackProduct(fetchImpl)).toEqual({
        status: "OK",
        url: `https://${STORE_HOST}/products/safe-one`,
      });
    });

    it("isSafeProductHandle / pickPublicProductUrl agree with isAllowedSpeedTarget", () => {
      for (const h of BAD_HANDLES) expect(isSafeProductHandle(h)).toBe(false);
      const url = pickPublicProductUrl(
        JSON.stringify({ products: [product("ok-1_2", "2026-01-01T00:00:00Z")] }),
        STORE_HOST,
      );
      expect(url).toBe(`https://${STORE_HOST}/products/ok-1_2`);
      expect(isAllowedSpeedTarget(url!, STORE_HOST)).toBe(true);
    });
  });

  describe("gate: never reads the storefront unless the feature is live for a Pro shop", () => {
    it("flag off: no storefront request", async () => {
      delete process.env.SPEED_REPORT_LIVE_ENABLED;
      const fetchImpl = noStorefront();
      const r = await resolvePublicProductTarget({
        shopId: SHOP_ID,
        primaryHost: STORE_HOST,
        storeHosts: STORE_HOSTS,
        fetchImpl,
      });
      expect(r).toEqual({ status: "NEEDS_PRODUCT_ACCESS" });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(mockDb.shop.findUnique).not.toHaveBeenCalled();
    });

    it.each([
      ["Standard", { ...PRO, plan: "Standard" }],
      ["free", { ...PRO, plan: "free" }],
      ["uninstalled", { ...PRO, uninstalledAt: NOW }],
      ["unknown shop", null],
    ])("%s: no storefront request", async (_label, shop) => {
      mockDb.shop.findUnique.mockResolvedValue(shop);
      const fetchImpl = noStorefront();
      expect(await fallbackProduct(fetchImpl as never)).toEqual({ status: "NEEDS_PRODUCT_ACCESS" });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("a gate DB error falls back to homepage only (never throws)", async () => {
      mockDb.shop.findUnique.mockRejectedValue(new Error("db down"));
      const fetchImpl = noStorefront();
      expect(await fallbackProduct(fetchImpl as never)).toEqual({ status: "NEEDS_PRODUCT_ACCESS" });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it("logs host + outcome only: never the products.json URL, a handle or the body", async () => {
    await fallbackProduct(
      storefront(() => productsJson([product("secret-handle", "2026-01-01T00:00:00Z")])),
    );
    await fallbackProduct(storefront(() => new Response("Not found", { status: 404 })));
    const logged = everythingLogged();
    expect(logged).toContain('"event":"speed_product_fallback"');
    expect(logged).toContain(`"host":"${STORE_HOST}"`);
    expect(logged).toContain('"outcome":"ok"');
    expect(logged).toContain('"outcome":"http_status"');
    expect(logged).not.toContain("products.json");
    expect(logged).not.toContain("secret-handle");
    expect(logged).not.toContain("/products/");
  });
});

// ---------------------------------------------------------------------------
// One attempt
// ---------------------------------------------------------------------------

function attemptInput(fetchImpl: PageSpeedFetch) {
  return {
    shopId: SHOP_ID,
    page: "home" as const,
    pageUrl: HOME,
    primaryHost: STORE_HOST,
    storeHosts: STORE_HOSTS,
    fetchImpl,
    now: () => NOW,
  };
}

describe("runPageSpeedAttempt", () => {
  it("ok: reserves the call BEFORE fetching, then returns the summarized run", async () => {
    const order: string[] = [];
    mockModel.reservePageSpeedCall.mockImplementation(async () => {
      order.push("reserve");
      return true;
    });
    const fetchImpl = vi.fn(async () => {
      order.push("fetch");
      return json(200, buildPageSpeedResponse());
    }) as unknown as PageSpeedFetch;
    const a = await runPageSpeedAttempt(attemptInput(fetchImpl));
    expect(order).toEqual(["reserve", "fetch"]);
    expect(mockModel.reservePageSpeedCall).toHaveBeenCalledWith(5000, NOW);
    expect(a.kind).toBe("ok");
    if (a.kind === "ok") {
      expect(a.run.metrics.score).toBe(28);
      expect(a.run.apps.map((x) => x.name)).toEqual(["Klaviyo", "Recharge"]);
    }
  });

  it("uses PAGESPEED_DAILY_CALL_BUDGET when set", async () => {
    process.env.PAGESPEED_DAILY_CALL_BUDGET = "12";
    await runPageSpeedAttempt(
      attemptInput(fetchReturning(() => json(200, buildPageSpeedResponse()))),
    );
    expect(mockModel.reservePageSpeedCall).toHaveBeenCalledWith(12, NOW);
  });

  it("budget exhausted: no call at all", async () => {
    mockModel.reservePageSpeedCall.mockResolvedValue(false);
    const fetchImpl = vi.fn() as unknown as PageSpeedFetch;
    await expect(runPageSpeedAttempt(attemptInput(fetchImpl))).resolves.toEqual({ kind: "budget" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["flag off", () => delete process.env.SPEED_REPORT_LIVE_ENABLED, "not_eligible"],
    [
      "downgraded to Standard",
      () => mockDb.shop.findUnique.mockResolvedValue({ ...PRO, plan: "Standard" }),
      "not_eligible",
    ],
    [
      "downgraded to Free",
      () => mockDb.shop.findUnique.mockResolvedValue({ ...PRO, plan: "free" }),
      "not_eligible",
    ],
    [
      "uninstalled",
      () => mockDb.shop.findUnique.mockResolvedValue({ ...PRO, uninstalledAt: NOW }),
      "not_eligible",
    ],
    ["key removed", () => delete process.env.PAGESPEED_API_KEY, "not_configured"],
  ])("%s mid-run: zero fetch calls, nothing reserved", async (_label, arrange, kind) => {
    arrange();
    const fetchImpl = vi.fn() as unknown as PageSpeedFetch;
    await expect(runPageSpeedAttempt(attemptInput(fetchImpl))).resolves.toEqual({ kind });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mockModel.reservePageSpeedCall).not.toHaveBeenCalled();
  });

  it("a URL off the primary domain is never sent", async () => {
    const fetchImpl = vi.fn() as unknown as PageSpeedFetch;
    const a = await runPageSpeedAttempt({
      ...attemptInput(fetchImpl),
      pageUrl: "https://evil.example/",
    });
    expect(a).toEqual({ kind: "bad_target" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mockModel.reservePageSpeedCall).not.toHaveBeenCalled();
  });

  it("password page: the run ended on /password", async () => {
    const fetchImpl = fetchReturning(() =>
      json(200, buildPageSpeedResponse({ finalDisplayedUrl: `https://${STORE_HOST}/password` })),
    );
    await expect(runPageSpeedAttempt(attemptInput(fetchImpl))).resolves.toEqual({
      kind: "password",
    });
  });

  it("password page: Lighthouse got a 401 for the document (gc-wt3y #1)", async () => {
    const fetchImpl = fetchReturning(() =>
      json(
        400,
        buildPageSpeedError(
          400,
          "Lighthouse returned error: ERRORED_DOCUMENT_REQUEST. Lighthouse was unable to reliably load the page you requested. (Status code: 401)",
        ),
      ),
    );
    await expect(runPageSpeedAttempt(attemptInput(fetchImpl))).resolves.toEqual({
      kind: "password",
    });
  });

  it("a document failure with another status stays document_failed", async () => {
    const fetchImpl = fetchReturning(() =>
      json(400, buildPageSpeedError(400, "ERRORED_DOCUMENT_REQUEST. (Status code: 403)")),
    );
    await expect(runPageSpeedAttempt(attemptInput(fetchImpl))).resolves.toEqual({
      kind: "error",
      code: "document_failed",
    });
  });

  it.each([
    [429, buildPageSpeedError(429, "Quota exceeded"), "rate_limited"],
    [500, buildPageSpeedError(500, "Backend Error"), "server_error"],
    [
      500,
      buildPageSpeedError(500, "Lighthouse returned error: FAILED_DOCUMENT_REQUEST."),
      "document_failed",
    ],
    [400, buildPageSpeedError(400, "API key not valid."), "http_error"],
  ])("HTTP %i -> error %s", async (status, body, code) => {
    const a = await runPageSpeedAttempt(attemptInput(fetchReturning(() => json(status, body))));
    expect(a).toEqual({ kind: "error", code });
  });

  it("a 200 that is not a usable lighthouseResult -> bad_response", async () => {
    const a = await runPageSpeedAttempt(
      attemptInput(fetchReturning(() => json(200, { lighthouseResult: { categories: {} } }))),
    );
    expect(a).toEqual({ kind: "error", code: "bad_response" });
  });

  it("logs the host and outcome, never the request URL or the key", async () => {
    const echo = buildPageSpeedError(400, `bad https://www.googleapis.com/x?key=${KEY}`);
    await runPageSpeedAttempt(attemptInput(fetchReturning(() => json(400, echo))));
    await runPageSpeedAttempt(
      attemptInput(fetchReturning(() => json(200, buildPageSpeedResponse()))),
    );
    const info = logSpies[0].mock.calls.map((c: unknown[]) => c[1] as Record<string, unknown>);
    expect(info[0]).toMatchObject({ host: STORE_HOST, outcome: "http_error", httpStatus: 400 });
    expect(info[1]).toMatchObject({ host: STORE_HOST, outcome: "ok", httpStatus: 200 });
    const logged = everythingLogged();
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain("googleapis.com");
    expect(logged).not.toContain("key=");
  });
});

describe("precheckStorefrontPassword (gc-wt3y #1)", () => {
  const SHOPIFY_MARKER = `<script>Shopify.shop = "${MYSHOPIFY_HOST}";</script>`;
  const PASSWORD_HTML = `<html><head>${SHOPIFY_MARKER}</head><body class="password-page"><form method="post" action="/password" id="login_form"><input type="password" name="password"></form></body></html>`;
  const STORE_HTML = `<html><head>${SHOPIFY_MARKER}</head><body class="template-index">Shop</body></html>`;

  function page(body: string, status = 200): Response {
    return new Response(body, { status, headers: { "content-type": "text/html" } });
  }

  function precheck(fetchImpl: StorefrontFetch) {
    return precheckStorefrontPassword({
      shopId: SHOP_ID,
      primaryHost: STORE_HOST,
      storeHosts: STORE_HOSTS,
      fetchImpl,
    });
  }

  it("redirect to /password -> password, reading only the shop's own hosts", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: `https://${STORE_HOST}/password` },
        }),
      )
      .mockResolvedValueOnce(page(PASSWORD_HTML));
    expect(await precheck(fetchImpl as unknown as StorefrontFetch)).toBe("password");
    expect(String(fetchImpl.mock.calls[0][0])).toBe(`https://${STORE_HOST}/`);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });

  it("password page served at / with a 200 (no redirect) -> password", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(page(PASSWORD_HTML));
    expect(await precheck(fetchImpl as unknown as StorefrontFetch)).toBe("password");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("password page served at / with a 401 -> password", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(page(PASSWORD_HTML, 401));
    expect(await precheck(fetchImpl as unknown as StorefrontFetch)).toBe("password");
  });

  it("an open storefront -> open", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(page(STORE_HTML));
    expect(await precheck(fetchImpl as unknown as StorefrontFetch)).toBe("open");
  });

  it("network failure -> unknown (the run goes on to PageSpeed, never blocked)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    expect(await precheck(fetchImpl as unknown as StorefrontFetch)).toBe("unknown");
  });

  it("a redirect off the shop's hosts is not followed -> unknown", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(null, { status: 301, headers: { location: "https://evil.example/" } }),
      );
    expect(await precheck(fetchImpl as unknown as StorefrontFetch)).toBe("unknown");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("flag off or shop no longer eligible: no fetch at all -> skipped", async () => {
    const fetchImpl = vi.fn();
    delete process.env.SPEED_REPORT_LIVE_ENABLED;
    expect(await precheck(fetchImpl as unknown as StorefrontFetch)).toBe("skipped");
    process.env.SPEED_REPORT_LIVE_ENABLED = "true";
    mockDb.shop.findUnique.mockResolvedValue({ ...PRO, plan: "Standard" });
    expect(await precheck(fetchImpl as unknown as StorefrontFetch)).toBe("skipped");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never reserves PageSpeed budget", async () => {
    await precheck(vi.fn().mockResolvedValue(page(PASSWORD_HTML)) as unknown as StorefrontFetch);
    expect(mockModel.reservePageSpeedCall).not.toHaveBeenCalled();
  });
});

describe("attempt control flow", () => {
  const ok: SpeedAttempt = { kind: "ok", run: {} as SpeedRunSummary };
  it("halts the run on password, budget, gate, key, 429 and 4xx", () => {
    for (const a of [
      { kind: "password" },
      { kind: "budget" },
      { kind: "not_eligible" },
      { kind: "not_configured" },
      { kind: "bad_target" },
      { kind: "error", code: "rate_limited" },
      { kind: "error", code: "http_error" },
    ] as SpeedAttempt[]) {
      expect(attemptHaltsRun(a)).toBe(true);
    }
  });

  it("keeps the run going on ok, timeouts and 5xx; a load failure or timeout stops only the page", () => {
    for (const a of [
      ok,
      { kind: "error", code: "timeout" },
      { kind: "error", code: "server_error" },
      { kind: "error", code: "network" },
      { kind: "error", code: "document_failed" },
    ] as SpeedAttempt[]) {
      expect(attemptHaltsRun(a)).toBe(false);
    }
    expect(attemptHaltsPage({ kind: "error", code: "document_failed" })).toBe(true);
    // gc-zees: a timed-out run would only time out again; skip the page's rest.
    expect(attemptHaltsPage({ kind: "error", code: "timeout" })).toBe(true);
    for (const a of [
      ok,
      { kind: "error", code: "server_error" },
      { kind: "error", code: "network" },
      { kind: "error", code: "bad_response" },
    ] as SpeedAttempt[]) {
      expect(attemptHaltsPage(a)).toBe(false);
    }
  });

  it("only attempts that reached Google count as calls", () => {
    expect(attemptCalledGoogle(ok)).toBe(true);
    expect(attemptCalledGoogle({ kind: "password" })).toBe(true);
    expect(attemptCalledGoogle({ kind: "error", code: "timeout" })).toBe(true);
    expect(attemptCalledGoogle({ kind: "budget" })).toBe(false);
    expect(attemptCalledGoogle({ kind: "not_eligible" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Page + report roll-up
// ---------------------------------------------------------------------------

function run(score: number, tag: string): SpeedAttempt {
  return {
    kind: "ok",
    run: {
      finalUrl: HOME,
      passwordProtected: false,
      metrics: {
        score,
        lcpMs: score * 100,
        tbtMs: 1,
        cls: 0,
        fcpMs: 1,
        speedIndexMs: 1,
        totalBytes: 1,
        requestCount: 1,
      },
      apps: [
        {
          name: tag,
          mainThreadMs: 1,
          transferBytes: 1,
          unusedPct: null,
          requestCount: 1,
        },
      ],
      otherThirdParty: [],
      firstParty: { mainThreadMs: 0, transferBytes: 0 },
    },
  };
}

describe("buildSpeedPageResult", () => {
  it("reports the median of 3 runs (its own numbers and app rows)", () => {
    const p = buildSpeedPageResult("home", HOME, [run(40, "a"), run(20, "b"), run(30, "c")]);
    expect(p).toMatchObject({ status: "OK", runsAttempted: 3, runsOk: 3, url: HOME });
    expect(p.metrics!.score).toBe(30);
    expect(p.apps![0].name).toBe("c");
  });

  it("a failed run among 3: median of the 2 results (lower)", () => {
    const p = buildSpeedPageResult("home", HOME, [
      run(40, "a"),
      { kind: "error", code: "timeout" },
      run(20, "b"),
    ]);
    expect(p).toMatchObject({ status: "OK", runsAttempted: 3, runsOk: 2 });
    expect(p.metrics!.score).toBe(20);
  });

  it("all 3 failed: FAILED with the last error's code", () => {
    const p = buildSpeedPageResult("home", HOME, [
      { kind: "error", code: "timeout" },
      { kind: "error", code: "server_error" },
      { kind: "error", code: "timeout" },
    ]);
    expect(p).toEqual({
      page: "home",
      url: HOME,
      status: "FAILED",
      runsAttempted: 3,
      runsOk: 0,
      failureCode: "timeout",
    });
  });

  it("ok then a timeout (the timeout ended the page): OK from the ok run alone (gc-zees)", () => {
    const p = buildSpeedPageResult("home", HOME, [
      run(40, "a"),
      { kind: "error", code: "timeout" },
    ]);
    expect(p).toMatchObject({ status: "OK", runsAttempted: 2, runsOk: 1, url: HOME });
    expect(p.metrics!.score).toBe(40);
    expect(p.failureCode).toBeUndefined();
  });

  it("two ok runs then a timeout: OK, median of the 2 ok runs (lower) (gc-zees)", () => {
    const p = buildSpeedPageResult("home", HOME, [
      run(40, "a"),
      run(20, "b"),
      { kind: "error", code: "timeout" },
    ]);
    expect(p).toMatchObject({ status: "OK", runsAttempted: 3, runsOk: 2 });
    expect(p.metrics!.score).toBe(20);
  });

  it("first run timed out (page ended): FAILED/timeout with 1 run attempted (gc-zees)", () => {
    expect(buildSpeedPageResult("home", HOME, [{ kind: "error", code: "timeout" }])).toEqual({
      page: "home",
      url: HOME,
      status: "FAILED",
      runsAttempted: 1,
      runsOk: 0,
      failureCode: "timeout",
    });
  });

  it("password beats ok runs", () => {
    expect(buildSpeedPageResult("home", HOME, [run(40, "a"), { kind: "password" }]).status).toBe(
      "PASSWORD",
    );
  });

  it("never reached: NOT_RUN labelled with the halt reason; budget-only: NOT_RUN/budget", () => {
    expect(buildSpeedPageResult("product", HOME, [], "rate_limited")).toMatchObject({
      status: "NOT_RUN",
      failureCode: "rate_limited",
      runsAttempted: 0,
    });
    expect(buildSpeedPageResult("home", HOME, [{ kind: "budget" }])).toMatchObject({
      status: "NOT_RUN",
      failureCode: "budget",
    });
  });
});

const TARGETS: SpeedTargets = {
  homeUrl: HOME,
  primaryHost: STORE_HOST,
  storeHosts: STORE_HOSTS,
  product: { status: "OK", url: `https://${STORE_HOST}/products/a` },
};

describe("finalizeSpeedReport", () => {
  const base = {
    reportId: "rep-1",
    shopDomain: DOMAIN,
    origin: "SCHEDULED" as const,
    startedAt: new Date(Date.now() - 1000).toISOString(),
  };

  it("COMPLETED: writes both pages, the call count and a speed_report ops event", async () => {
    const r = await finalizeSpeedReport({
      ...base,
      targets: TARGETS,
      tested: [
        { page: "home", url: HOME, attempts: [run(30, "a"), run(31, "b"), run(29, "c")] },
        {
          page: "product",
          url: TARGETS.product.status === "OK" ? TARGETS.product.url : "",
          attempts: [run(50, "d"), run(50, "e"), run(50, "f")],
        },
      ],
    });
    expect(r).toEqual({ status: "COMPLETED", calls: 6 });
    const written = mockModel.finishSpeedReport.mock.calls[0][1];
    expect(written).toMatchObject({ status: "COMPLETED", failureReason: null, psiCalls: 6 });
    expect(written.pages.map((p: { page: string; status: string }) => [p.page, p.status])).toEqual([
      ["home", "OK"],
      ["product", "OK"],
    ]);
    const event = mockRecordOpsEvent.mock.calls[0][0];
    expect(event).toMatchObject({
      eventType: "speed_report",
      key: DOMAIN,
      metadata: { status: "COMPLETED", origin: "SCHEDULED", calls: 6 },
    });
    expect(event.metadata.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(event)).not.toContain("http");
  });

  it("adds the untestable product page (NEEDS_PRODUCT_ACCESS) without failing the report", async () => {
    const r = await finalizeSpeedReport({
      ...base,
      targets: { ...TARGETS, product: { status: "NEEDS_PRODUCT_ACCESS" } },
      tested: [{ page: "home", url: HOME, attempts: [run(30, "a")] }],
    });
    expect(r.status).toBe("COMPLETED");
    expect(mockModel.finishSpeedReport.mock.calls[0][1].pages[1]).toEqual({
      page: "product",
      url: null,
      status: "NEEDS_PRODUCT_ACCESS",
      runsAttempted: 0,
      runsOk: 0,
    });
  });

  it("product lookup FAILED -> PARTIAL", async () => {
    const r = await finalizeSpeedReport({
      ...base,
      targets: { ...TARGETS, product: { status: "FAILED" } },
      tested: [{ page: "home", url: HOME, attempts: [run(30, "a")] }],
    });
    expect(r.status).toBe("PARTIAL");
  });

  it("password -> UNAVAILABLE_PASSWORD (product never tested)", async () => {
    const r = await finalizeSpeedReport({
      ...base,
      targets: TARGETS,
      tested: [
        { page: "home", url: HOME, attempts: [{ kind: "password" }] },
        { page: "product", url: HOME, attempts: [] },
      ],
    });
    expect(r).toEqual({ status: "UNAVAILABLE_PASSWORD", calls: 1 });
  });

  it("password found by the pre-check -> UNAVAILABLE_PASSWORD with 0 calls (gc-wt3y #1)", async () => {
    const r = await finalizeSpeedReport({
      ...base,
      targets: TARGETS,
      tested: [
        { page: "home", url: HOME, attempts: [] },
        { page: "product", url: HOME, attempts: [] },
      ],
      passwordProtected: true,
    });
    expect(r).toEqual({ status: "UNAVAILABLE_PASSWORD", calls: 0 });
    const written = mockModel.finishSpeedReport.mock.calls[0][1];
    expect(written).toMatchObject({ status: "UNAVAILABLE_PASSWORD", psiCalls: 0 });
    expect(written.pages.map((p: { status: string }) => p.status)).toEqual([
      "PASSWORD",
      "PASSWORD",
    ]);
    expect(mockRecordOpsEvent.mock.calls[0][0].metadata).toMatchObject({
      status: "UNAVAILABLE_PASSWORD",
      calls: 0,
    });
  });

  it("budget before any result -> SKIPPED_BUDGET with reason budget and 0 calls", async () => {
    const r = await finalizeSpeedReport({
      ...base,
      targets: TARGETS,
      tested: [
        { page: "home", url: HOME, attempts: [{ kind: "budget" }] },
        { page: "product", url: HOME, attempts: [] },
      ],
      haltCode: "budget",
    });
    expect(r).toEqual({ status: "SKIPPED_BUDGET", calls: 0 });
    expect(mockModel.finishSpeedReport.mock.calls[0][1].failureReason).toBe("budget");
    expect(mockRecordOpsEvent.mock.calls[0][0].metadata).toMatchObject({
      status: "SKIPPED_BUDGET",
      reason: "budget",
      calls: 0,
    });
  });

  it("budget after the homepage -> PARTIAL", async () => {
    const r = await finalizeSpeedReport({
      ...base,
      targets: TARGETS,
      tested: [
        { page: "home", url: HOME, attempts: [run(30, "a"), run(30, "b"), run(30, "c")] },
        { page: "product", url: HOME, attempts: [{ kind: "budget" }] },
      ],
      haltCode: "budget",
    });
    expect(r.status).toBe("PARTIAL");
  });

  it("all failed -> FAILED with the page's failure code", async () => {
    const r = await finalizeSpeedReport({
      ...base,
      targets: { ...TARGETS, product: { status: "NO_PRODUCT" } },
      tested: [{ page: "home", url: HOME, attempts: [{ kind: "error", code: "rate_limited" }] }],
      haltCode: "rate_limited",
    });
    expect(r.status).toBe("FAILED");
    expect(mockModel.finishSpeedReport.mock.calls[0][1].failureReason).toBe("rate_limited");
  });

  it("no targets because the Admin API failed -> FAILED/admin_unavailable (gc-wt3y #12)", async () => {
    await finalizeSpeedReport({
      ...base,
      targets: null,
      targetsFailure: "admin_unavailable",
      tested: [],
    });
    expect(mockModel.finishSpeedReport.mock.calls[0][1]).toMatchObject({
      status: "FAILED",
      failureReason: "admin_unavailable",
    });
    expect(mockRecordOpsEvent.mock.calls[0][0].metadata).toMatchObject({
      reason: "admin_unavailable",
    });
  });

  it("no targets (domain lookup failed) -> FAILED/no_domain, no pages", async () => {
    const r = await finalizeSpeedReport({ ...base, targets: null, tested: [] });
    expect(r).toEqual({ status: "FAILED", calls: 0 });
    expect(mockModel.finishSpeedReport).toHaveBeenCalledWith("rep-1", {
      status: "FAILED",
      failureReason: "no_domain",
      pages: null,
      psiCalls: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Run now
// ---------------------------------------------------------------------------

describe("requestSpeedReportRunNow", () => {
  const shop = { id: SHOP_ID, domain: DOMAIN, plan: "Professional" };

  beforeEach(() => {
    mockModel.getRecentSpeedReports.mockResolvedValue([]);
    mockModel.getSpeedReportRequestedAt.mockResolvedValue(null);
    mockModel.claimSpeedReportRunNow.mockResolvedValue(true);
    mockModel.createSpeedReport.mockResolvedValue({ id: "rep-7", createdAt: NOW });
    mockSend.mockResolvedValue({ ids: ["e1"] });
  });

  it("claims the slot, creates a MANUAL row and sends the event", async () => {
    await expect(requestSpeedReportRunNow(shop, NOW)).resolves.toEqual({
      ok: true,
      reportId: "rep-7",
    });
    expect(mockModel.claimSpeedReportRunNow).toHaveBeenCalledWith(SHOP_ID, NOW);
    expect(mockModel.createSpeedReport).toHaveBeenCalledWith(SHOP_ID, "MANUAL");
    expect(mockSend).toHaveBeenCalledWith({
      name: "speed-report/requested",
      data: {
        shopId: SHOP_ID,
        origin: "MANUAL",
        reportId: "rep-7",
        runNowClaimedAt: NOW.toISOString(),
        runNowPrevious: null,
      },
    });
  });

  it("carries the previous claim so a failed run can hand the slot back", async () => {
    const prev = new Date("2026-10-01T00:00:00Z");
    mockModel.getSpeedReportRequestedAt.mockResolvedValue(prev);
    await requestSpeedReportRunNow(shop, NOW);
    expect(mockSend.mock.calls[0][0].data.runNowPrevious).toBe(prev.toISOString());
  });

  it("creating the row fails after the claim: the slot is handed back (gc-wt3y #7)", async () => {
    const prev = new Date("2026-10-01T00:00:00Z");
    mockModel.getSpeedReportRequestedAt.mockResolvedValue(prev);
    mockModel.createSpeedReport.mockRejectedValue(new Error("db down"));
    await expect(requestSpeedReportRunNow(shop, NOW)).resolves.toEqual({
      ok: false,
      error: RUN_NOW_ERRORS.dispatch,
    });
    expect(mockModel.releaseSpeedReportRunNow).toHaveBeenCalledWith(SHOP_ID, NOW, prev);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each(["free", "Standard"])("plan %s: refused, nothing claimed or sent", async (plan) => {
    await expect(requestSpeedReportRunNow({ ...shop, plan }, NOW)).resolves.toEqual({
      ok: false,
      error: RUN_NOW_ERRORS.notInPlan,
    });
    expect(mockModel.claimSpeedReportRunNow).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("key missing: refused BEFORE the 24h slot is used, with a not-configured ops event", async () => {
    delete process.env.PAGESPEED_API_KEY;
    const r = await requestSpeedReportRunNow(shop, NOW);
    expect(r).toEqual({ ok: false, error: "Speed tests aren't available right now." });
    expect(mockModel.claimSpeedReportRunNow).not.toHaveBeenCalled();
    expect(mockRecordOpsEvent.mock.calls[0][0]).toMatchObject({
      eventType: "speed_report",
      key: DOMAIN,
      metadata: { status: "FAILED", origin: "MANUAL", reason: "not_configured" },
    });
  });

  it("key missing: repeated clicks write at most one not-configured event per hour (gc-wt3y #9)", async () => {
    delete process.env.PAGESPEED_API_KEY;
    mockModel.hasRecentSpeedReportEvent.mockResolvedValue(true);
    const r = await requestSpeedReportRunNow(shop, NOW);
    expect(r).toEqual({ ok: false, error: "Speed tests aren't available right now." });
    expect(mockModel.hasRecentSpeedReportEvent).toHaveBeenCalledWith(
      DOMAIN,
      "not_configured",
      new Date(NOW.getTime() - 60 * 60_000),
    );
    expect(mockRecordOpsEvent).not.toHaveBeenCalled();
    expect(mockModel.claimSpeedReportRunNow).not.toHaveBeenCalled();
  });

  it("a run already in progress: refused without claiming", async () => {
    mockModel.getRecentSpeedReports.mockResolvedValue([
      {
        id: "r1",
        origin: "SCHEDULED",
        status: "RUNNING",
        failureReason: null,
        pages: null,
        createdAt: new Date(NOW.getTime() - 5 * 60_000),
        completedAt: null,
      },
    ]);
    await expect(requestSpeedReportRunNow(shop, NOW)).resolves.toEqual({
      ok: false,
      error: RUN_NOW_ERRORS.running,
    });
    expect(mockModel.claimSpeedReportRunNow).not.toHaveBeenCalled();
  });

  it("an abandoned RUNNING row (started over an hour ago) does not block a new run", async () => {
    mockModel.getRecentSpeedReports.mockResolvedValue([
      {
        id: "r1",
        origin: "SCHEDULED",
        status: "RUNNING",
        failureReason: null,
        pages: null,
        createdAt: new Date(NOW.getTime() - 2 * 60 * 60_000),
        startedAt: new Date(NOW.getTime() - 2 * 60 * 60_000),
        completedAt: null,
      },
    ]);
    expect((await requestSpeedReportRunNow(shop, NOW)).ok).toBe(true);
  });

  it("a run still queued hours after the click blocks a second one (gc-wt3y #3)", async () => {
    mockModel.getRecentSpeedReports.mockResolvedValue([
      {
        id: "r1",
        origin: "MANUAL",
        status: "RUNNING",
        failureReason: null,
        pages: null,
        createdAt: new Date(NOW.getTime() - 2 * 60 * 60_000),
        startedAt: null,
        completedAt: null,
      },
    ]);
    await expect(requestSpeedReportRunNow(shop, NOW)).resolves.toEqual({
      ok: false,
      error: RUN_NOW_ERRORS.running,
    });
  });

  it("within 24h: refused with when the next test is available", async () => {
    const last = new Date(NOW.getTime() - 60 * 60_000);
    mockModel.getSpeedReportRequestedAt.mockResolvedValue(last);
    mockModel.claimSpeedReportRunNow.mockResolvedValue(false);
    await expect(requestSpeedReportRunNow(shop, NOW)).resolves.toEqual({
      ok: false,
      error: RUN_NOW_ERRORS.cooldown,
      nextAvailableAt: new Date(last.getTime() + 24 * 60 * 60_000).toISOString(),
    });
    expect(mockModel.createSpeedReport).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("send fails: row closed FAILED/dispatch_failed and the slot handed back", async () => {
    const prev = new Date("2026-10-01T00:00:00Z");
    mockModel.getSpeedReportRequestedAt.mockResolvedValue(prev);
    mockSend.mockRejectedValue(new Error("inngest down"));
    await expect(requestSpeedReportRunNow(shop, NOW)).resolves.toEqual({
      ok: false,
      error: RUN_NOW_ERRORS.dispatch,
    });
    expect(mockModel.finishSpeedReport).toHaveBeenCalledWith("rep-7", {
      status: "FAILED",
      failureReason: "dispatch_failed",
      pages: null,
      psiCalls: 0,
    });
    expect(mockModel.releaseSpeedReportRunNow).toHaveBeenCalledWith(SHOP_ID, NOW, prev);
  });
});

// ---------------------------------------------------------------------------
// Secrets end to end
// ---------------------------------------------------------------------------

describe("the API key never leaves the request", () => {
  it("across prepare, attempts (ok / error / timeout-ish) and finalize", async () => {
    const prep = await prepareSpeedReportRun({
      shopId: SHOP_ID,
      origin: "SCHEDULED",
      runId: "run-1",
    });
    expect(prep.proceed).toBe(true);
    const attempts: SpeedAttempt[] = [];
    for (const fetchImpl of [
      fetchReturning(() => json(200, buildPageSpeedResponse())),
      fetchReturning(() => json(500, buildPageSpeedError(500, `echo key=${KEY}`))),
      vi.fn(async () => {
        throw new Error(`socket hang up key=${KEY}`);
      }) as unknown as PageSpeedFetch,
    ]) {
      attempts.push(await runPageSpeedAttempt(attemptInput(fetchImpl)));
    }
    await finalizeSpeedReport({
      reportId: "rep-1",
      shopDomain: DOMAIN,
      origin: "SCHEDULED",
      startedAt: NOW.toISOString(),
      targets: { ...TARGETS, product: { status: "NO_PRODUCT" } },
      tested: [{ page: "home", url: HOME, attempts }],
    });
    expect(JSON.stringify(attempts)).not.toContain(KEY);
    expect(everythingLogged()).not.toContain(KEY);
  });
});

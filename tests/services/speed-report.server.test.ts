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
  finalizeSpeedReport,
  isAllowedSpeedTarget,
  prepareSpeedReportRun,
  productUrlOnPrimaryHost,
  requestSpeedReportRunNow,
  resolveSpeedTargets,
  RUN_NOW_ERRORS,
  runPageSpeedAttempt,
  type SpeedAttempt,
  type SpeedTargets,
} from "../../app/services/speed-report.server";
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
  it("SCHEDULED + eligible: creates the report row and proceeds", async () => {
    const r = await prepareSpeedReportRun({ shopId: SHOP_ID, origin: "SCHEDULED" });
    expect(r).toEqual({
      proceed: true,
      reportId: "rep-1",
      shopDomain: DOMAIN,
      startedAt: NOW.toISOString(),
    });
    expect(mockModel.createSpeedReport).toHaveBeenCalledWith(SHOP_ID, "SCHEDULED");
  });

  it("MANUAL with a reportId: uses the action's row, creates none", async () => {
    const r = await prepareSpeedReportRun({ shopId: SHOP_ID, origin: "MANUAL", reportId: "rep-9" });
    expect(r).toMatchObject({ proceed: true, reportId: "rep-9" });
    expect(mockModel.createSpeedReport).not.toHaveBeenCalled();
  });

  it("flag off: no row, no event", async () => {
    delete process.env.SPEED_REPORT_LIVE_ENABLED;
    const r = await prepareSpeedReportRun({ shopId: SHOP_ID, origin: "SCHEDULED" });
    expect(r).toEqual({ proceed: false, outcome: "disabled" });
    expect(mockModel.createSpeedReport).not.toHaveBeenCalled();
    expect(mockRecordOpsEvent).not.toHaveBeenCalled();
  });

  it("downgraded since the click: closes the MANUAL row as FAILED/not_eligible", async () => {
    mockDb.shop.findUnique.mockResolvedValue({ ...PRO, plan: "Standard" });
    const r = await prepareSpeedReportRun({ shopId: SHOP_ID, origin: "MANUAL", reportId: "rep-9" });
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
    const r = await prepareSpeedReportRun({ shopId: SHOP_ID, origin: "SCHEDULED" });
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
    expect(await prepareSpeedReportRun({ shopId: SHOP_ID, origin: "SCHEDULED" })).toEqual({
      proceed: false,
      outcome: "not_configured",
    });
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
    await expect(resolveSpeedTargets(admin)).resolves.toEqual({
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
    const r = await resolveSpeedTargets(admin);
    expect(r.ok && r.targets.product).toEqual({
      status: "OK",
      url: `https://${STORE_HOST}/products/a`,
    });
  });

  it("NO_PRODUCT when no product is published to the online store", async () => {
    for (const nodes of [[], [{ onlineStoreUrl: null }, { onlineStoreUrl: "not a url" }]]) {
      const r = await resolveSpeedTargets(adminWith(SHOP_BODY, { data: { products: { nodes } } }));
      expect(r.ok && r.targets.product).toEqual({ status: "NO_PRODUCT" });
    }
  });

  it("NEEDS_PRODUCT_ACCESS when read_products is not granted (returned or thrown)", async () => {
    const returned = adminWith(SHOP_BODY, {
      errors: [
        { message: "Access denied for products field.", extensions: { code: "ACCESS_DENIED" } },
      ],
    });
    expect(
      ((await resolveSpeedTargets(returned)) as { targets: SpeedTargets }).targets.product,
    ).toEqual({
      status: "NEEDS_PRODUCT_ACCESS",
    });
    const thrownErr = Object.assign(new Error("GraphQL Client: Forbidden"), {
      body: { errors: { graphQLErrors: [{ extensions: { code: "ACCESS_DENIED" } }] } },
    });
    expect(
      ((await resolveSpeedTargets(adminWith(SHOP_BODY, thrownErr))) as { targets: SpeedTargets })
        .targets.product,
    ).toEqual({ status: "NEEDS_PRODUCT_ACCESS" });
  });

  it("product lookup FAILED on any other error, homepage still tested", async () => {
    const r = await resolveSpeedTargets(adminWith(SHOP_BODY, new Error("THROTTLED")));
    expect(r).toMatchObject({
      ok: true,
      targets: { homeUrl: HOME, product: { status: "FAILED" } },
    });
    const r2 = await resolveSpeedTargets(
      adminWith(SHOP_BODY, { errors: [{ message: "Internal" }] }),
    );
    expect(r2).toMatchObject({ ok: true, targets: { product: { status: "FAILED" } } });
  });

  it("no usable primary domain (missing, IP literal, Admin error) -> not ok", async () => {
    for (const shop of [
      { primaryDomain: null },
      { primaryDomain: { url: "https://10.0.0.1", host: "10.0.0.1" } },
      { primaryDomain: { url: "::bad", host: "http://evil" } },
    ]) {
      expect(await resolveSpeedTargets(adminWith({ data: { shop } }))).toEqual({ ok: false });
    }
    expect(await resolveSpeedTargets(adminWith(new Error("401")))).toEqual({ ok: false });
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

  it("keeps going on ok, timeouts and 5xx; stops only the page when it can't load", () => {
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
    expect(attemptHaltsPage({ kind: "error", code: "timeout" })).toBe(false);
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
          blockingMs: 0,
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
      data: { shopId: SHOP_ID, origin: "MANUAL", reportId: "rep-7" },
    });
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

  it("an abandoned RUNNING row does not block a new run", async () => {
    mockModel.getRecentSpeedReports.mockResolvedValue([
      {
        id: "r1",
        origin: "SCHEDULED",
        status: "RUNNING",
        failureReason: null,
        pages: null,
        createdAt: new Date(NOW.getTime() - 2 * 60 * 60_000),
        completedAt: null,
      },
    ]);
    expect((await requestSpeedReportRunNow(shop, NOW)).ok).toBe(true);
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
    const prep = await prepareSpeedReportRun({ shopId: SHOP_ID, origin: "SCHEDULED" });
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

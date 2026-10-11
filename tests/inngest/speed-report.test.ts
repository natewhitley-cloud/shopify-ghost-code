/**
 * Tests for inngest/functions/speed-report.ts (gc-wt3y): the weekly
 * coordinator (dark => no work; Professional fan-out with idempotent event
 * ids) and the per-shop worker's step graph (each PageSpeed call its own
 * step, 3 runs per page, halts, finalize), plus the quota-related function
 * config (retries, concurrency, priority, finish timeout).
 *
 * The orchestration functions in app/services/speed-report.server are mocked
 * (they have their own tests); the halt predicates stay real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const created = vi.hoisted(
  () => [] as Array<{ config: Record<string, unknown>; trigger: Record<string, unknown> }>,
);

vi.mock("../../inngest/client", () => ({
  inngest: {
    send: vi.fn(),
    createFunction: vi.fn(
      (
        config: Record<string, unknown>,
        trigger: Record<string, unknown>,
        handler: (...args: unknown[]) => unknown,
      ) => {
        created.push({ config, trigger });
        return { fn: handler, config, trigger };
      },
    ),
  },
}));

vi.mock("../../app/models/ops-event.server", async (importActual) => {
  const actual = await importActual<typeof import("../../app/models/ops-event.server")>();
  return { ...actual, recordCronHeartbeat: vi.fn() };
});

const mockDb = vi.hoisted(() => ({ shop: { findMany: vi.fn() } }));
vi.mock("../../app/db.server", () => ({ default: mockDb }));

vi.mock("../../app/shopify.server", () => ({ unauthenticated: { admin: vi.fn() } }));

const svc = vi.hoisted(() => ({
  prepareSpeedReportRun: vi.fn(),
  resolveSpeedTargets: vi.fn(),
  precheckStorefrontPassword: vi.fn(),
  runPageSpeedAttempt: vi.fn(),
  finalizeSpeedReport: vi.fn(),
  closeAbandonedSpeedReport: vi.fn(),
}));
vi.mock("../../app/services/speed-report.server", async (importActual) => {
  const actual = await importActual<typeof import("../../app/services/speed-report.server")>();
  return { ...actual, ...svc };
});

import { recordCronHeartbeat } from "../../app/models/ops-event.server";
import { unauthenticated } from "../../app/shopify.server";
import { inngest } from "../../inngest/client";
import {
  SPEED_REPORT_CRON,
  speedReportCancelled,
  speedReportRun,
  speedReportWeekly,
} from "../../inngest/functions/speed-report";
import { createMockInngestStep, getInngestHandler } from "../mocks/inngest";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const HOME = "https://shop.example/";
const PRODUCT = "https://shop.example/products/a";

function okAttempt(score = 30) {
  return { kind: "ok", run: { metrics: { score } } };
}

function stepNames(step: ReturnType<typeof createMockInngestStep>): string[] {
  return step.run.mock.calls.map((c) => c[0] as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SPEED_REPORT_LIVE_ENABLED = "true";
  svc.prepareSpeedReportRun.mockResolvedValue({
    proceed: true,
    reportId: "rep-1",
    shopDomain: "shop.myshopify.com",
    startedAt: "2026-10-11T08:10:00.000Z",
  });
  (unauthenticated.admin as ReturnType<typeof vi.fn>).mockResolvedValue({
    admin: { graphql: vi.fn() },
  });
  svc.resolveSpeedTargets.mockResolvedValue({
    ok: true,
    targets: {
      homeUrl: HOME,
      primaryHost: "shop.example",
      storeHosts: ["shop.example", "shop.myshopify.com"],
      product: { status: "OK", url: PRODUCT },
    },
  });
  svc.precheckStorefrontPassword.mockResolvedValue("open");
  svc.runPageSpeedAttempt.mockResolvedValue(okAttempt());
  svc.finalizeSpeedReport.mockResolvedValue({ status: "COMPLETED", calls: 6 });
});

afterEach(() => {
  delete process.env.SPEED_REPORT_LIVE_ENABLED;
});

describe("function config (quota guardrails)", () => {
  it("coordinator: Sunday 08:10 UTC cron", () => {
    const c = created.find((f) => f.config.id === "speed-report-weekly")!;
    expect(c.trigger).toEqual({ cron: "10 8 * * 0" });
    expect(SPEED_REPORT_CRON).toBe("10 8 * * 0");
  });

  it("worker: one at a time globally and per shop, 1 retry, start + finish timeouts, manual priority", () => {
    const c = created.find((f) => f.config.id === "speed-report-run")!;
    expect(c.trigger).toEqual({ event: "speed-report/requested" });
    expect(c.config.retries).toBe(1);
    expect(c.config.concurrency).toEqual([{ limit: 1 }, { key: "event.data.shopId", limit: 1 }]);
    expect(c.config.timeouts).toEqual({ start: "6h", finish: "45m" });
    expect((c.config.priority as { run: string }).run).toContain("MANUAL");
  });
});

describe("abandoned runs are closed (gc-wt3y #2/#3)", () => {
  const manual = {
    name: "speed-report/requested",
    data: {
      shopId: "s1",
      origin: "MANUAL",
      reportId: "rep-9",
      runNowClaimedAt: "2026-10-11T11:00:00.000Z",
      runNowPrevious: null,
    },
  };

  it("onFailure (retries exhausted): closes the run's report as worker_failed", async () => {
    const c = created.find((f) => f.config.id === "speed-report-run")!;
    const onFailure = c.config.onFailure as (ctx: unknown) => Promise<unknown>;
    expect(typeof onFailure).toBe("function");
    await onFailure({
      event: {
        name: "inngest/function.failed",
        data: {
          function_id: "ghost-code-speed-report-run",
          run_id: "run-1",
          error: {},
          event: manual,
        },
      },
      error: new Error("boom"),
      step: createMockInngestStep(),
      logger,
    });
    expect(svc.closeAbandonedSpeedReport).toHaveBeenCalledWith(
      {
        shopId: "s1",
        origin: "MANUAL",
        runId: "run-1",
        reportId: "rep-9",
        runNowClaimedAt: "2026-10-11T11:00:00.000Z",
        runNowPrevious: null,
      },
      "worker_failed",
    );
  });

  it("a cancelled run (start or finish timeout) is closed as stuck, only for this function", async () => {
    const c = created.find((f) => f.config.id === "speed-report-cancelled")!;
    expect(c.trigger).toEqual({
      event: "inngest/function.cancelled",
      if: "event.data.function_id == 'ghost-code-speed-report-run'",
    });
    const handler = getInngestHandler(speedReportCancelled);
    await handler({
      event: {
        name: "inngest/function.cancelled",
        data: {
          function_id: "ghost-code-speed-report-run",
          run_id: "run-2",
          event: { ...manual, data: { shopId: "s2", origin: "SCHEDULED" } },
        },
      },
      step: createMockInngestStep(),
      logger,
    });
    expect(svc.closeAbandonedSpeedReport).toHaveBeenCalledWith(
      { shopId: "s2", origin: "SCHEDULED", runId: "run-2" },
      "stuck",
    );
  });

  it("a cancel event without the original event data is ignored (nothing to close)", async () => {
    const handler = getInngestHandler(speedReportCancelled);
    await handler({
      event: { name: "inngest/function.cancelled", data: { function_id: "x", run_id: "run-3" } },
      step: createMockInngestStep(),
      logger,
    });
    expect(svc.closeAbandonedSpeedReport).not.toHaveBeenCalled();
  });
});

describe("speed-report-weekly (coordinator)", () => {
  const handler = getInngestHandler(speedReportWeekly);

  it("dark: no DB read, no events, but still heartbeats", async () => {
    delete process.env.SPEED_REPORT_LIVE_ENABLED;
    const step = createMockInngestStep();
    const r = await handler({ step, logger });
    expect(r).toEqual({ total: 0, dispatched: 0, disabled: true });
    expect(mockDb.shop.findMany).not.toHaveBeenCalled();
    expect(step.run).not.toHaveBeenCalled();
    expect(inngest.send).not.toHaveBeenCalled();
    expect(recordCronHeartbeat).toHaveBeenCalledWith("speed-report-weekly");
  });

  it("fans out one SCHEDULED event per active Professional shop with a per-day idempotency id", async () => {
    mockDb.shop.findMany.mockResolvedValue([{ id: "s1" }, { id: "s2" }]);
    const step = createMockInngestStep();
    const r = await handler({ step, logger });
    expect(r).toEqual({ total: 2, dispatched: 2 });
    expect(mockDb.shop.findMany).toHaveBeenCalledWith({
      where: { plan: "Professional", uninstalledAt: null },
      select: { id: true },
    });
    const events = (inngest.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      name: "speed-report/requested",
      data: { shopId: "s1", origin: "SCHEDULED" },
    });
    expect(events[0].id).toMatch(/^speed-report-s1-\d{4}-\d{2}-\d{2}$/);
    expect(stepNames(step)).toEqual(["fetch-professional-shops", "fan-out-speed-reports-chunk-0"]);
  });

  it("no Professional shops: nothing sent", async () => {
    mockDb.shop.findMany.mockResolvedValue([]);
    const step = createMockInngestStep();
    expect(await handler({ step, logger })).toEqual({ total: 0, dispatched: 0 });
    expect(inngest.send).not.toHaveBeenCalled();
  });
});

describe("speed-report-run (worker)", () => {
  const handler = getInngestHandler(speedReportRun);
  const event = { name: "speed-report/requested", data: { shopId: "s1", origin: "SCHEDULED" } };

  it("runs each PageSpeed call as its own step: 3 per page, then finalize", async () => {
    const step = createMockInngestStep();
    const r = await handler({ event, step, logger });
    expect(r).toEqual({ outcome: "COMPLETED", calls: 6 });
    expect(stepNames(step)).toEqual([
      "prepare",
      "resolve-urls",
      "password-check",
      "psi-home-1",
      "psi-home-2",
      "psi-home-3",
      "psi-product-1",
      "psi-product-2",
      "psi-product-3",
      "finalize",
    ]);
    expect(svc.runPageSpeedAttempt).toHaveBeenCalledTimes(6);
    expect(svc.runPageSpeedAttempt.mock.calls[3][0]).toMatchObject({
      shopId: "s1",
      page: "product",
      pageUrl: PRODUCT,
      primaryHost: "shop.example",
    });
    const fin = svc.finalizeSpeedReport.mock.calls[0][0];
    expect(fin.tested.map((t: { attempts: unknown[] }) => t.attempts.length)).toEqual([3, 3]);
    expect(fin.haltCode).toBeUndefined();
  });

  it("refused at prepare (dark, not Pro, no key): no URL lookup, no calls", async () => {
    svc.prepareSpeedReportRun.mockResolvedValue({ proceed: false, outcome: "not_in_plan" });
    const step = createMockInngestStep();
    expect(await handler({ event, step, logger })).toEqual({ outcome: "not_in_plan" });
    expect(stepNames(step)).toEqual(["prepare"]);
    expect(svc.runPageSpeedAttempt).not.toHaveBeenCalled();
  });

  it("passes the MANUAL report id and the run id through to prepare", async () => {
    const step = createMockInngestStep();
    await handler({
      event: { ...event, data: { shopId: "s1", origin: "MANUAL", reportId: "rep-9" } },
      step,
      logger,
      runId: "run-7",
    });
    expect(svc.prepareSpeedReportRun).toHaveBeenCalledWith({
      shopId: "s1",
      origin: "MANUAL",
      reportId: "rep-9",
      runId: "run-7",
    });
  });

  it("URL lookup failed (or the Admin session is gone): finalize FAILED, no calls", async () => {
    (unauthenticated.admin as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("no session"));
    svc.finalizeSpeedReport.mockResolvedValue({ status: "FAILED", calls: 0 });
    const step = createMockInngestStep();
    expect(await handler({ event, step, logger })).toEqual({ outcome: "FAILED" });
    expect(stepNames(step)).toEqual(["prepare", "resolve-urls", "finalize"]);
    expect(svc.finalizeSpeedReport.mock.calls[0][0]).toMatchObject({ targets: null, tested: [] });
  });

  it("no testable product: homepage only", async () => {
    svc.resolveSpeedTargets.mockResolvedValue({
      ok: true,
      targets: {
        homeUrl: HOME,
        primaryHost: "shop.example",
        storeHosts: ["shop.example"],
        product: { status: "NEEDS_PRODUCT_ACCESS" },
      },
    });
    const step = createMockInngestStep();
    await handler({ event, step, logger });
    expect(stepNames(step).filter((n) => n.startsWith("psi-"))).toEqual([
      "psi-home-1",
      "psi-home-2",
      "psi-home-3",
    ]);
  });

  it("password found by the pre-check: no PageSpeed call at all, finalize as password (gc-wt3y #1)", async () => {
    svc.precheckStorefrontPassword.mockResolvedValue("password");
    svc.finalizeSpeedReport.mockResolvedValue({ status: "UNAVAILABLE_PASSWORD", calls: 0 });
    const step = createMockInngestStep();
    expect(await handler({ event, step, logger })).toEqual({
      outcome: "UNAVAILABLE_PASSWORD",
      calls: 0,
    });
    expect(stepNames(step)).toEqual(["prepare", "resolve-urls", "password-check", "finalize"]);
    expect(svc.runPageSpeedAttempt).not.toHaveBeenCalled();
    expect(svc.precheckStorefrontPassword).toHaveBeenCalledWith({
      shopId: "s1",
      primaryHost: "shop.example",
      storeHosts: ["shop.example", "shop.myshopify.com"],
    });
    expect(svc.finalizeSpeedReport.mock.calls[0][0]).toMatchObject({
      passwordProtected: true,
      tested: [
        { page: "home", url: HOME, attempts: [] },
        { page: "product", url: PRODUCT, attempts: [] },
      ],
    });
  });

  it.each(["unknown", "skipped", "open"])(
    "pre-check %s: the run goes on to PageSpeed",
    async (outcome) => {
      svc.precheckStorefrontPassword.mockResolvedValue(outcome);
      const step = createMockInngestStep();
      await handler({ event, step, logger });
      expect(svc.runPageSpeedAttempt).toHaveBeenCalledTimes(6);
      expect(svc.finalizeSpeedReport.mock.calls[0][0].passwordProtected).toBeUndefined();
    },
  );

  it("password on the first call: stops everything (1 call), product never tested", async () => {
    svc.runPageSpeedAttempt.mockResolvedValueOnce({ kind: "password" });
    const step = createMockInngestStep();
    await handler({ event, step, logger });
    expect(svc.runPageSpeedAttempt).toHaveBeenCalledTimes(1);
    const fin = svc.finalizeSpeedReport.mock.calls[0][0];
    expect(fin.tested).toEqual([
      { page: "home", url: HOME, attempts: [{ kind: "password" }] },
      { page: "product", url: PRODUCT, attempts: [] },
    ]);
  });

  it.each([
    [{ kind: "budget" }, "budget"],
    [{ kind: "error", code: "rate_limited" }, "rate_limited"],
    [{ kind: "error", code: "http_error" }, "http_error"],
    [{ kind: "not_eligible" }, "not_eligible"],
    [{ kind: "not_configured" }, "not_configured"],
  ])("%o on call 2 halts the run with that reason", async (attempt, haltCode) => {
    svc.runPageSpeedAttempt.mockResolvedValueOnce(okAttempt()).mockResolvedValueOnce(attempt);
    const step = createMockInngestStep();
    await handler({ event, step, logger });
    expect(svc.runPageSpeedAttempt).toHaveBeenCalledTimes(2);
    expect(svc.finalizeSpeedReport.mock.calls[0][0].haltCode).toBe(haltCode);
  });

  it("a page that can't load stops that page only; the product page still runs", async () => {
    svc.runPageSpeedAttempt.mockResolvedValueOnce({ kind: "error", code: "document_failed" });
    const step = createMockInngestStep();
    await handler({ event, step, logger });
    expect(stepNames(step).filter((n) => n.startsWith("psi-"))).toEqual([
      "psi-home-1",
      "psi-product-1",
      "psi-product-2",
      "psi-product-3",
    ]);
  });

  it("timeouts and 5xx keep trying (3 runs per page)", async () => {
    svc.runPageSpeedAttempt
      .mockResolvedValueOnce({ kind: "error", code: "timeout" })
      .mockResolvedValueOnce({ kind: "error", code: "server_error" });
    const step = createMockInngestStep();
    await handler({ event, step, logger });
    expect(svc.runPageSpeedAttempt).toHaveBeenCalledTimes(6);
  });
});

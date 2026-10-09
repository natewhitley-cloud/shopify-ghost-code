/**
 * Tests for the plan-cadence scheduled-scan coordinators (gc-iefo):
 * weekly-scan (Professional) and monthly-scan (Standard), both built by
 * createPlanScanCoordinator. Per-shop logic lives in poll-check-shop.ts.
 *
 * Key invariants:
 *   - each coordinator queries exactly its plan (canonical capitalised value)
 *   - uninstalled-pending-redact shops are excluded (gc-grd)
 *   - only id + domain are selected (no token leak)
 *   - one poll/check-shop event per shop; empty cohort sends nothing
 *   - the heartbeat key is the function id
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../app/db.server", () => ({
  default: { shop: { findMany: vi.fn() } },
}));

vi.mock("../../../inngest/client", () => ({
  inngest: {
    send: vi.fn(),
    createFunction: vi.fn(
      (config: unknown, trigger: unknown, handler: (...args: unknown[]) => unknown) => ({
        config,
        trigger,
        fn: handler,
      }),
    ),
  },
}));

vi.mock("../../../app/models/ops-event.server", () => ({
  recordCronHeartbeat: vi.fn(),
}));

import db from "../../../app/db.server";
import { recordCronHeartbeat } from "../../../app/models/ops-event.server";
import { inngest } from "../../../inngest/client";
import { monthlyScan, MONTHLY_SCAN_CRON } from "../../../inngest/functions/monthly-scan";
import { weeklyScan, WEEKLY_SCAN_CRON } from "../../../inngest/functions/weekly-scan";
import { createMockInngestStep, getInngestHandler } from "../../mocks/inngest";

const mockFindMany = (db as unknown as { shop: { findMany: ReturnType<typeof vi.fn> } }).shop
  .findMany;
const mockSend = (inngest as unknown as { send: ReturnType<typeof vi.fn> }).send;
const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

type Registered = { config: { id: string }; trigger: { cron: string } };

const COORDINATORS = [
  {
    label: "weekly-scan",
    fn: weeklyScan,
    id: "weekly-scan",
    cron: WEEKLY_SCAN_CRON,
    decidedCron: "40 6 * * 0",
    plan: "Professional",
  },
  {
    label: "monthly-scan",
    fn: monthlyScan,
    id: "monthly-scan",
    cron: MONTHLY_SCAN_CRON,
    decidedCron: "20 7 1 * *",
    plan: "Standard",
  },
] as const;

const SHOPS = [
  { id: "shop-1", domain: "one.myshopify.com" },
  { id: "shop-2", domain: "two.myshopify.com" },
  { id: "shop-3", domain: "three.myshopify.com" },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockFindMany.mockResolvedValue([SHOPS[0]]);
  mockSend.mockResolvedValue(undefined);
});

describe.each(COORDINATORS)("$label coordinator", ({ fn, id, cron, decidedCron, plan }) => {
  const run = () =>
    getInngestHandler(fn)({
      event: { name: "cron", data: {}, ts: Date.now(), id: "e" },
      step: createMockInngestStep(),
      logger: mockLogger,
    });

  it(`keeps id "${id}" and the decided cron`, () => {
    const registered = fn as unknown as Registered;
    expect(registered.config.id).toBe(id);
    expect(cron).toBe(decidedCron);
    expect(registered.trigger.cron).toBe(decidedCron);
  });

  it(`queries only ${plan} shops (canonical capitalisation), excluding uninstalled ones`, async () => {
    await run();
    expect(mockFindMany).toHaveBeenCalledOnce();
    const arg = mockFindMany.mock.calls[0][0];
    expect(arg.where).toEqual({ plan, uninstalledAt: null });
    expect(arg.where.plan).not.toBe(plan.toLowerCase());
  });

  it("selects only id and domain (no accessToken leak)", async () => {
    await run();
    expect(mockFindMany.mock.calls[0][0].select).toEqual({ id: true, domain: true });
  });

  it("sends one poll/check-shop event per shop and reports the totals", async () => {
    mockFindMany.mockResolvedValue(SHOPS);
    await expect(run()).resolves.toEqual({ total: 3, dispatched: 3 });
    expect(mockSend).toHaveBeenCalledOnce();
    expect(mockSend.mock.calls[0][0]).toEqual(
      SHOPS.map((s) => ({ name: "poll/check-shop", data: { shopId: s.id, shopDomain: s.domain } })),
    );
  });

  it("empty cohort: no send, zero totals", async () => {
    mockFindMany.mockResolvedValue([]);
    await expect(run()).resolves.toEqual({ total: 0, dispatched: 0 });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("records its heartbeat under the function id", async () => {
    await run();
    expect(recordCronHeartbeat).toHaveBeenCalledWith(id);
  });
});

describe("plan cohorts", () => {
  it("are disjoint and Free has no coordinator", () => {
    const plans = COORDINATORS.map((c) => c.plan);
    expect(new Set(plans).size).toBe(plans.length);
    expect(plans).not.toContain("free");
  });
});

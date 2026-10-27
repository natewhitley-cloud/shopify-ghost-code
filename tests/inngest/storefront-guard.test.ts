/**
 * storefront-guard cron (gc-1q1s.5): dark by default, batched chunk steps,
 * heartbeat on every successful run.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const svc = vi.hoisted(() => ({
  isGuardDue: vi.fn(() => true),
  checkGuardShop: vi.fn(),
  mapPool: vi.fn(),
}));
const model = vi.hoisted(() => ({ listGuardCandidateShops: vi.fn() }));
const mockRecordCronHeartbeat = vi.hoisted(() => vi.fn());

vi.mock("../../inngest/client", () => ({
  inngest: {
    createFunction: vi.fn((config: unknown, trigger: unknown, fn: unknown) => ({
      config,
      trigger,
      fn,
    })),
  },
}));
vi.mock("../../app/services/storefront-guard.server", () => svc);
vi.mock("../../app/models/storefront-guard.server", () => model);
vi.mock("../../app/shopify.server", () => ({
  unauthenticated: { admin: vi.fn(async () => ({ admin: {} })) },
}));
vi.mock("../../app/models/ops-event.server", () => ({
  recordCronHeartbeat: mockRecordCronHeartbeat,
}));

import {
  GUARD_CHUNK_SIZE,
  storefrontGuard,
  STOREFRONT_GUARD_CRON,
} from "../../inngest/functions/storefront-guard";
import { createMockInngestStep, getInngestHandler } from "../mocks/inngest";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const run = (step = createMockInngestStep()) =>
  getInngestHandler(storefrontGuard)({ step, logger, event: {}, runId: "r" });

function shops(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    domain: `s${i}.myshopify.com`,
    plan: "Standard",
    storefrontGuardState: null,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  svc.mapPool.mockImplementation(
    async (items: unknown[], _limit: number, fn: (x: unknown) => Promise<unknown>) =>
      Promise.all(items.map(fn)),
  );
  svc.checkGuardShop.mockResolvedValue({ status: "checked", outcome: "ok", opened: [] });
});
afterEach(() => {
  delete process.env.STOREFRONT_GUARD_LIVE_ENABLED;
});

describe("storefront-guard cron", () => {
  it("is hourly at :17 with concurrency 1", () => {
    const fn = storefrontGuard as unknown as {
      config: { concurrency: { limit: number } };
      trigger: { cron: string };
    };
    expect(STOREFRONT_GUARD_CRON).toBe("17 * * * *");
    expect(fn.trigger.cron).toBe(STOREFRONT_GUARD_CRON);
    expect(fn.config.concurrency.limit).toBe(1);
  });

  it("is dark by default: no DB read, no check, still heartbeats", async () => {
    const step = createMockInngestStep();
    expect(await run(step)).toEqual({ due: 0, disabled: true });
    expect(step.run).not.toHaveBeenCalled();
    expect(model.listGuardCandidateShops).not.toHaveBeenCalled();
    expect(mockRecordCronHeartbeat).toHaveBeenCalledWith("storefront-guard");
  });

  it("does nothing when no shop is due", async () => {
    process.env.STOREFRONT_GUARD_LIVE_ENABLED = "true";
    model.listGuardCandidateShops.mockResolvedValue(shops(3));
    svc.isGuardDue.mockReturnValue(false);
    expect(await run()).toEqual({ due: 0 });
    expect(svc.checkGuardShop).not.toHaveBeenCalled();
    svc.isGuardDue.mockReturnValue(true);
  });

  it("checks due shops in chunk steps of GUARD_CHUNK_SIZE and counts outcomes", async () => {
    process.env.STOREFRONT_GUARD_LIVE_ENABLED = "true";
    model.listGuardCandidateShops.mockResolvedValue(shops(GUARD_CHUNK_SIZE + 2));
    svc.checkGuardShop
      .mockResolvedValueOnce({
        status: "checked",
        outcome: "ok",
        opened: [{ shopId: "s0", incidentId: "i", kind: "KNOWN_MALICIOUS", openedAt: "x" }],
      })
      .mockResolvedValueOnce({ status: "failed" })
      .mockResolvedValueOnce({ status: "checked", outcome: "paused_password", opened: [] });
    const step = createMockInngestStep();
    const out = await run(step);
    const names = step.run.mock.calls.map((c) => c[0]);
    expect(names).toEqual(["select-due-shops", "check-chunk-0", "check-chunk-1"]);
    expect(svc.checkGuardShop).toHaveBeenCalledTimes(GUARD_CHUNK_SIZE + 2);
    expect(out).toEqual({
      due: GUARD_CHUNK_SIZE + 2,
      byOutcome: { ok: GUARD_CHUNK_SIZE, failed: 1, paused_password: 1 },
      opened: 1,
    });
    expect(mockRecordCronHeartbeat).toHaveBeenCalledWith("storefront-guard");
  });

  it("passes only id, domain and plan forward from selection", async () => {
    process.env.STOREFRONT_GUARD_LIVE_ENABLED = "true";
    model.listGuardCandidateShops.mockResolvedValue(shops(1));
    await run();
    expect(svc.checkGuardShop.mock.calls[0][0]).toEqual({
      id: "s0",
      domain: "s0.myshopify.com",
      plan: "Standard",
    });
  });
});

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
const model = vi.hoisted(() => ({
  listGuardCandidateShops: vi.fn(),
  getGuardEmailShop: vi.fn(),
}));
const email = vi.hoisted(() => ({ sendGuardIncidentEmail: vi.fn() }));
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
vi.mock("../../app/services/storefront-guard-email.server", () => email);
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
  delete process.env.STOREFRONT_GUARD_EMAIL_ENABLED;
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
      // Email flag off: no notify step.
      emailed: {},
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

  describe("incident email (gc-1q1s.7)", () => {
    const opened = (shopId: string, incidentId: string, kind: string) => ({
      status: "checked",
      outcome: "ok",
      opened: [{ shopId, incidentId, kind, openedAt: "2026-10-27T05:17:00.000Z" }],
    });

    beforeEach(() => {
      process.env.STOREFRONT_GUARD_LIVE_ENABLED = "true";
      model.listGuardCandidateShops.mockResolvedValue(shops(3));
      model.getGuardEmailShop.mockImplementation(async (id: string) => ({
        id,
        domain: `${id}.myshopify.com`,
      }));
      email.sendGuardIncidentEmail.mockResolvedValue({ sent: true, reason: "sent" });
      svc.checkGuardShop
        .mockResolvedValueOnce(opened("s0", "a", "KNOWN_MALICIOUS"))
        .mockResolvedValueOnce(opened("s1", "b", "NEW_SCRIPT_HOST"))
        .mockResolvedValueOnce({
          status: "checked",
          outcome: "ok",
          opened: [
            { shopId: "s2", incidentId: "c", kind: "SCRIPT_LOADER", openedAt: "x" },
            { shopId: "s2", incidentId: "d", kind: "KNOWN_MALICIOUS", openedAt: "x" },
          ],
        });
    });

    it("one notify step per shop with an emailable incident, incidents batched; new hosts never", async () => {
      process.env.STOREFRONT_GUARD_EMAIL_ENABLED = "true";
      const step = createMockInngestStep();
      const out = await run(step);
      const names = step.run.mock.calls.map((c) => c[0]);
      expect(names).toEqual(["select-due-shops", "check-chunk-0", "notify-s0", "notify-s2"]);
      expect(email.sendGuardIncidentEmail.mock.calls.map((c) => c[0].incidentIds)).toEqual([
        ["a"],
        ["c", "d"],
      ]);
      expect(out.emailed).toEqual({ s0: "sent", s2: "sent" });
    });

    it("no notify step while the email flag is off", async () => {
      const step = createMockInngestStep();
      await run(step);
      expect(step.run.mock.calls.map((c) => c[0])).toEqual(["select-due-shops", "check-chunk-0"]);
      expect(email.sendGuardIncidentEmail).not.toHaveBeenCalled();
    });

    it("a dead offline token still emails with the cached address (admin null)", async () => {
      process.env.STOREFRONT_GUARD_EMAIL_ENABLED = "true";
      const { unauthenticated } = await import("../../app/shopify.server");
      (unauthenticated.admin as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("401"));
      await run();
      expect(email.sendGuardIncidentEmail.mock.calls[0][0].admin).toBeNull();
    });
  });
});

/**
 * storefront-guard cron (gc-1q1s.5): dark by default, batched chunk steps,
 * heartbeat on every successful run.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const svc = vi.hoisted(() => ({
  isGuardDue: vi.fn(() => true),
  guardEmailConsentAt: vi.fn<(s: { guardEmailNoticeShownAt: Date | null }) => Date | null>(
    () => null,
  ),
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
vi.mock("../../app/services/storefront-guard.server", async (orig) => ({
  ...svc,
  compareGuardCandidates: (
    await orig<typeof import("../../app/services/storefront-guard.server")>()
  ).compareGuardCandidates,
}));
vi.mock("../../app/models/storefront-guard.server", () => model);
vi.mock("../../app/services/storefront-guard-email.server", () => email);
vi.mock("../../app/shopify.server", () => ({
  unauthenticated: { admin: vi.fn(async () => ({ admin: {} })) },
}));
vi.mock("../../app/models/ops-event.server", () => ({
  recordCronHeartbeat: mockRecordCronHeartbeat,
}));
const mockAlertGuardQuotaOnce = vi.hoisted(() => vi.fn());
vi.mock("../../app/services/storefront-guard-quota.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/services/storefront-guard-quota.server")>()),
  alertGuardQuotaOnce: mockAlertGuardQuotaOnce,
}));

import {
  GUARD_CHUNK_SIZE,
  MAX_GUARD_SHOPS_PER_RUN,
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
  svc.checkGuardShop.mockResolvedValue({
    status: "checked",
    outcome: "ok",
    opened: [],
    toEmail: [],
  });
});
afterEach(() => {
  delete process.env.STOREFRONT_GUARD_LIVE_ENABLED;
  delete process.env.STOREFRONT_GUARD_EMAIL_ENABLED;
  delete process.env.STOREFRONT_GUARD_MONTHLY_STEP_ALERT;
});

describe("storefront-guard cron: Inngest quota tripwire (gc-1q1s.9)", () => {
  it("under the threshold: no alert step", async () => {
    process.env.STOREFRONT_GUARD_LIVE_ENABLED = "true";
    model.listGuardCandidateShops.mockResolvedValue(shops(GUARD_CHUNK_SIZE * 2));
    const step = createMockInngestStep();
    await run(step);
    // 2 + 2 chunks = 4 steps a run, 2,880 a month: far under 20k.
    expect(step.run.mock.calls.map((c) => c[0])).not.toContain("quota-alert");
    expect(mockAlertGuardQuotaOnce).not.toHaveBeenCalled();
  });

  it("over the threshold: one alert step with the projection, the alert step counted", async () => {
    process.env.STOREFRONT_GUARD_LIVE_ENABLED = "true";
    // 3 chunks: (2 + 3) x 720 = 3,600 > 3,000; with the alert step (wave 3
    // B6) the run is 6 steps, 4,320 a month.
    process.env.STOREFRONT_GUARD_MONTHLY_STEP_ALERT = "3000";
    model.listGuardCandidateShops.mockResolvedValue(shops(GUARD_CHUNK_SIZE * 2 + 1));
    mockAlertGuardQuotaOnce.mockResolvedValue("alerted");
    const step = createMockInngestStep();
    await run(step);
    expect(step.run.mock.calls.map((c) => c[0]).at(-1)).toBe("quota-alert");
    expect(mockAlertGuardQuotaOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        projected: 4320,
        threshold: 3000,
        runSteps: 6,
        due: GUARD_CHUNK_SIZE * 2 + 1,
      }),
    );
  });

  it("counts notify steps in the projection", async () => {
    process.env.STOREFRONT_GUARD_LIVE_ENABLED = "true";
    process.env.STOREFRONT_GUARD_EMAIL_ENABLED = "true";
    // 1 chunk + 1 notify: (2 + 1 + 1) x 720 = 2,880 > 2,500; without notify
    // 2,160. The alert step makes it 5 steps, 3,600 a month.
    process.env.STOREFRONT_GUARD_MONTHLY_STEP_ALERT = "2500";
    model.listGuardCandidateShops.mockResolvedValue(shops(1));
    model.getGuardEmailShop.mockResolvedValue({ id: "s0", domain: "s0.myshopify.com" });
    email.sendGuardIncidentEmail.mockResolvedValue({ sent: true, reason: "sent" });
    const item = { shopId: "s0", incidentId: "a", kind: "KNOWN_MALICIOUS", openedAt: "x" };
    svc.checkGuardShop.mockResolvedValue({
      status: "checked",
      outcome: "ok",
      opened: [item],
      toEmail: [item],
    });
    await run();
    expect(mockAlertGuardQuotaOnce).toHaveBeenCalledWith(
      expect.objectContaining({ runSteps: 5, projected: 3600 }),
    );
  });
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
        toEmail: [],
      })
      .mockResolvedValueOnce({ status: "failed" })
      .mockResolvedValueOnce({
        status: "checked",
        outcome: "paused_password",
        opened: [],
        toEmail: [],
      });
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

  it("caps a run at MAX_GUARD_SHOPS_PER_RUN, never-checked and longest-waiting first", async () => {
    process.env.STOREFRONT_GUARD_LIVE_ENABLED = "true";
    const many = shops(MAX_GUARD_SHOPS_PER_RUN + 5).map((s, i) => ({
      ...s,
      storefrontGuardState:
        i === 0
          ? null
          : { lastCheckedAt: new Date(Date.UTC(2026, 9, 1, 0, i)), backoffUntil: null },
    }));
    model.listGuardCandidateShops.mockResolvedValue([...many].reverse());
    const out = await run();
    expect(out.due).toBe(MAX_GUARD_SHOPS_PER_RUN);
    expect(svc.checkGuardShop.mock.calls[0][0].id).toBe("s0");
    expect(svc.checkGuardShop.mock.calls[1][0].id).toBe("s1");
    const checked = new Set(svc.checkGuardShop.mock.calls.map((c) => c[0].id));
    expect(checked.has(`s${MAX_GUARD_SHOPS_PER_RUN + 4}`)).toBe(false);
  });

  it("passes only id, domain, plan and the email consent time forward from selection", async () => {
    process.env.STOREFRONT_GUARD_LIVE_ENABLED = "true";
    const consentAt = new Date("2026-10-20T10:00:00Z");
    svc.guardEmailConsentAt.mockImplementation(
      (s: { guardEmailNoticeShownAt: Date | null }) => s.guardEmailNoticeShownAt,
    );
    model.listGuardCandidateShops.mockResolvedValue([
      { ...shops(1)[0], guardEmailNoticeShownAt: consentAt },
      { ...shops(2)[1], guardEmailNoticeShownAt: null },
    ]);
    await run();
    expect(svc.checkGuardShop.mock.calls.map((c) => c[0])).toEqual([
      {
        id: "s0",
        domain: "s0.myshopify.com",
        plan: "Standard",
        emailConsentAt: consentAt.toISOString(),
      },
      { id: "s1", domain: "s1.myshopify.com", plan: "Standard", emailConsentAt: null },
    ]);
  });

  // Audit fix (M5): every chunk stamps the RUN's fire time, so a long run's
  // late chunks never make their shops skip the next hour.
  it("passes the run's fire time to every chunk, however late it runs", async () => {
    process.env.STOREFRONT_GUARD_LIVE_ENABLED = "true";
    const fired = new Date("2026-10-27T05:17:00Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(fired);
      model.listGuardCandidateShops.mockResolvedValue(shops(GUARD_CHUNK_SIZE * 3));
      const step = createMockInngestStep();
      step.run.mockImplementation(async (name: string, fn: () => unknown) => {
        // Each chunk starts 20 minutes after the previous one.
        if (name.startsWith("check-chunk-")) vi.setSystemTime(new Date(Date.now() + 20 * 60_000));
        return fn();
      });
      await run(step);

      const runAts = svc.checkGuardShop.mock.calls.map((c) => (c[3] as Date).toISOString());
      expect(new Set(runAts)).toEqual(new Set([fired.toISOString()]));
      // The last chunk ran at :17 + 60 min; its shops are due at the next run
      // (an hour after the fire time) under the real cadence rule.
      const lastChunkNow = svc.checkGuardShop.mock.calls.at(-1)![1] as Date;
      expect(lastChunkNow.getTime() - fired.getTime()).toBe(60 * 60_000);
      const { isGuardDue } = await vi.importActual<
        typeof import("../../app/services/storefront-guard.server")
      >("../../app/services/storefront-guard.server");
      const nextRun = new Date(fired.getTime() + 60 * 60_000);
      const stampedWithRun = { lastCheckedAt: fired, backoffUntil: null };
      const stampedWithChunk = { lastCheckedAt: lastChunkNow, backoffUntil: null };
      const shop = { id: "s0", plan: "Standard" };
      expect(isGuardDue({ ...shop, storefrontGuardState: stampedWithRun }, nextRun)).toBe(true);
      // What the chunk clock would have done (the bug): skipped an hour.
      expect(isGuardDue({ ...shop, storefrontGuardState: stampedWithChunk }, nextRun)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts a retried chunk's already-checked shops on their own", async () => {
    process.env.STOREFRONT_GUARD_LIVE_ENABLED = "true";
    model.listGuardCandidateShops.mockResolvedValue(shops(2));
    svc.checkGuardShop
      .mockResolvedValueOnce({ status: "already_checked" })
      .mockResolvedValueOnce({ status: "checked", outcome: "ok", opened: [], toEmail: [] });
    const out = await run();
    expect(out.byOutcome).toEqual({ already_checked: 1, ok: 1 });
  });

  describe("incident email (gc-1q1s.7)", () => {
    // checkGuardShop decides what is offered (emailable kinds, paid plans):
    // the cron only groups toEmail by shop.
    const opened = (shopId: string, incidentId: string, kind: string, offered = true) => {
      const item = { shopId, incidentId, kind, openedAt: "2026-10-27T05:17:00.000Z" };
      return { status: "checked", outcome: "ok", opened: [item], toEmail: offered ? [item] : [] };
    };

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
        .mockResolvedValueOnce(opened("s1", "b", "NEW_SCRIPT_HOST", false))
        .mockResolvedValueOnce({
          status: "checked",
          outcome: "ok",
          opened: [],
          // An earlier run's unemailed episodes are offered again.
          toEmail: [
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

describe("storefront-guard cron: paid shops first (wave 3 B7)", () => {
  it("a backlog of Free shops never pushes a paid hourly check out of the run", async () => {
    process.env.STOREFRONT_GUARD_LIVE_ENABLED = "true";
    const free = Array.from({ length: MAX_GUARD_SHOPS_PER_RUN }, (_, i) => ({
      id: `f${i}`,
      domain: `f${i}.myshopify.com`,
      plan: "free",
      storefrontGuardState: null,
    }));
    const paid = {
      id: "paid",
      domain: "paid.myshopify.com",
      plan: "Standard",
      storefrontGuardState: {
        lastCheckedAt: new Date(Date.now() - 60 * 60 * 1000),
        backoffUntil: null,
      },
    };
    model.listGuardCandidateShops.mockResolvedValue([...free, paid]);
    await run();
    const checked = svc.checkGuardShop.mock.calls.map((c) => (c[0] as { id: string }).id);
    expect(checked).toHaveLength(MAX_GUARD_SHOPS_PER_RUN);
    expect(checked[0]).toBe("paid");
  });
});

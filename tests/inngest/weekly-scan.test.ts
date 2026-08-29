/**
 * Tests for the weekly-scan Inngest coordinator function.
 *
 * This coordinator runs weekly (Sunday 6 AM UTC) and fans out a
 * `poll/check-shop` event for every Standard-plan shop. Per-shop logic
 * lives in poll-check-shop.ts (tested separately).
 *
 * Mirrors the structure of poll-theme-changes.test.ts for consistency.
 *
 * Key invariants tested:
 *   - DB query uses PLANS.STANDARD ("Standard") not "standard" (lowercase)
 *   - Only id and domain are selected (no accessToken leak)
 *   - Events are batched in a single inngest.send() call
 *   - Empty cohort returns { total: 0, dispatched: 0 } without calling send()
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (hoisted by Vitest before imports)
// ---------------------------------------------------------------------------

vi.mock("../../app/db.server", () => ({
  default: {
    shop: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("../../inngest/client", () => ({
  inngest: {
    send: vi.fn(),
    // createFunction is called at module load time by weekly-scan.ts.
    // We return a real-looking function object with a `.fn` accessor so that
    // weeklyScan.fn({ event, step, logger }) still works in tests.
    createFunction: vi.fn(
      (_config: unknown, _trigger: unknown, handler: (...args: unknown[]) => unknown) => ({
        fn: handler,
      }),
    ),
  },
}));

// The real withCronHeartbeat wrapper runs the handler then records a heartbeat.
// Stub the heartbeat write so it does not touch the DB or logger in these tests.
vi.mock("../../app/models/ops-event.server", () => ({
  recordCronHeartbeat: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

import db from "../../app/db.server";
import { inngest } from "../../inngest/client";
import { weeklyScan } from "../../inngest/functions/weekly-scan";
import { createMockInngestStep, getInngestHandler } from "../mocks/inngest";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockDb = db as unknown as {
  shop: { findMany: ReturnType<typeof vi.fn> };
};
const mockInngestSend = (inngest as unknown as { send: ReturnType<typeof vi.fn> }).send;

// ---------------------------------------------------------------------------
// Test data constants
// ---------------------------------------------------------------------------

const SHOP_STD_1 = { id: "shop-std-001", domain: "std-shop-1.myshopify.com" };
const SHOP_STD_2 = { id: "shop-std-002", domain: "std-shop-2.myshopify.com" };
const SHOP_STD_3 = { id: "shop-std-003", domain: "std-shop-3.myshopify.com" };

// ---------------------------------------------------------------------------
// Mock logger (Inngest logger interface)
// ---------------------------------------------------------------------------

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

// ---------------------------------------------------------------------------
// Helper: invoke function handler
// ---------------------------------------------------------------------------

async function runWeeklyScan(stepOverrides?: Partial<ReturnType<typeof createMockInngestStep>>) {
  const step = { ...createMockInngestStep(), ...stepOverrides };
  const event = { name: "scheduled/weekly", data: {}, ts: Date.now(), id: "test-event-weekly" };
  return getInngestHandler(weeklyScan)({ event, step, logger: mockLogger });
}

// ---------------------------------------------------------------------------
// Setup: reset mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Default: one Standard shop
  mockDb.shop.findMany.mockResolvedValue([SHOP_STD_1]);
  mockInngestSend.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Plan filter invariant
// ---------------------------------------------------------------------------

describe("weeklyScan coordinator — plan filter", () => {
  it("queries DB with plan: 'Standard' (capital S), not 'standard' (lowercase)", async () => {
    await runWeeklyScan();

    expect(mockDb.shop.findMany).toHaveBeenCalledOnce();
    const callArg = mockDb.shop.findMany.mock.calls[0][0];

    expect(callArg.where.plan).toBe("Standard");
    expect(callArg.where.plan).not.toBe("standard");
  });

  it("selects only id and domain fields from shop (no accessToken leak)", async () => {
    await runWeeklyScan();

    const callArg = mockDb.shop.findMany.mock.calls[0][0];
    expect(callArg.select).toEqual({
      id: true,
      domain: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Happy path — one Standard shop
// ---------------------------------------------------------------------------

describe("weeklyScan coordinator — happy path", () => {
  it("returns total: 1 and dispatched: 1 when one shop is found", async () => {
    const result = await runWeeklyScan();

    expect(result.total).toBe(1);
    expect(result.dispatched).toBe(1);
  });

  it("sends one poll/check-shop event for the shop", async () => {
    await runWeeklyScan();

    expect(mockInngestSend).toHaveBeenCalledOnce();
    const payload = mockInngestSend.mock.calls[0][0];

    // send() receives an array of events (batch send pattern)
    expect(Array.isArray(payload)).toBe(true);
    expect(payload).toHaveLength(1);
    expect(payload[0].name).toBe("poll/check-shop");
    expect(payload[0].data.shopId).toBe(SHOP_STD_1.id);
    expect(payload[0].data.shopDomain).toBe(SHOP_STD_1.domain);
  });
});

// ---------------------------------------------------------------------------
// Multiple shops — fan-out sends correct event batch
// ---------------------------------------------------------------------------

describe("weeklyScan coordinator — multiple Standard shops", () => {
  beforeEach(() => {
    mockDb.shop.findMany.mockResolvedValue([SHOP_STD_1, SHOP_STD_2, SHOP_STD_3]);
  });

  it("returns total: 3 and dispatched: 3", async () => {
    const result = await runWeeklyScan();

    expect(result.total).toBe(3);
    expect(result.dispatched).toBe(3);
  });

  it("sends one poll/check-shop event per shop in a single batch", async () => {
    await runWeeklyScan();

    expect(mockInngestSend).toHaveBeenCalledOnce();
    const payload = mockInngestSend.mock.calls[0][0];

    expect(Array.isArray(payload)).toBe(true);
    expect(payload).toHaveLength(3);

    const names = payload.map((e: Record<string, unknown>) => e.name);
    expect(names).toEqual(["poll/check-shop", "poll/check-shop", "poll/check-shop"]);

    const shopIds = payload.map(
      (e: Record<string, unknown>) => (e.data as Record<string, unknown>).shopId,
    );
    expect(shopIds).toContain(SHOP_STD_1.id);
    expect(shopIds).toContain(SHOP_STD_2.id);
    expect(shopIds).toContain(SHOP_STD_3.id);
  });

  it("includes the correct shopDomain in each event", async () => {
    await runWeeklyScan();

    const payload = mockInngestSend.mock.calls[0][0];
    const domainMap = Object.fromEntries(
      payload.map((e: Record<string, unknown>) => {
        const data = e.data as Record<string, unknown>;
        return [data.shopId, data.shopDomain];
      }),
    );

    expect(domainMap[SHOP_STD_1.id]).toBe(SHOP_STD_1.domain);
    expect(domainMap[SHOP_STD_2.id]).toBe(SHOP_STD_2.domain);
    expect(domainMap[SHOP_STD_3.id]).toBe(SHOP_STD_3.domain);
  });
});

// ---------------------------------------------------------------------------
// No shops — empty Standard cohort
// ---------------------------------------------------------------------------

describe("weeklyScan coordinator — no Standard shops", () => {
  beforeEach(() => {
    mockDb.shop.findMany.mockResolvedValue([]);
  });

  it("returns total: 0 and dispatched: 0", async () => {
    const result = await runWeeklyScan();

    expect(result.total).toBe(0);
    expect(result.dispatched).toBe(0);
  });

  it("does not call inngest.send when there are no shops", async () => {
    await runWeeklyScan();

    expect(mockInngestSend).not.toHaveBeenCalled();
  });
});

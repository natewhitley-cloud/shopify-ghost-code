/**
 * Tests for the poll-theme-changes Inngest coordinator function.
 *
 * After the fan-out refactor this function is a lean coordinator:
 *   1. Fetch all Professional-plan shops from DB.
 *   2. Send one `poll/check-shop` event per shop via inngest.send().
 *   3. Return { total, dispatched }.
 *
 * Per-shop logic (theme fetch, timestamp comparison, scan dispatch) has moved
 * to poll-check-shop.ts (tested separately in poll-check-shop.test.ts).
 *
 * Strategy:
 *   - Mock db.server and inngest client so only orchestration is tested.
 *   - Key invariant (S-02 regression): DB query uses PLANS.PROFESSIONAL
 *     ("Professional") NOT "professional" (lowercase).
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

// Stub expireStaleScans so the coordinator's Step 0 does not reach through to
// a real Prisma client.  Tests that need to verify the cleanup step behaviour
// live in tests/models/scan.server.test.ts.
vi.mock("../../app/models/scan.server", () => ({
  expireStaleScans: vi.fn().mockResolvedValue(0),
}));

vi.mock("../../inngest/client", () => ({
  inngest: {
    send: vi.fn(),
    // createFunction is called at module load time by poll-theme-changes.ts.
    // We return a real-looking function object with a `.fn` accessor so that
    // pollThemeChanges.fn({ event, step, logger }) still works in tests.
    createFunction: vi.fn(
      (_config: unknown, _trigger: unknown, handler: (...args: unknown[]) => unknown) => ({
        fn: handler,
      }),
    ),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

import db from "../../app/db.server";
import { inngest } from "../../inngest/client";
import { pollThemeChanges } from "../../inngest/functions/poll-theme-changes";
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

const SHOP_1 = { id: "shop-pro-001", domain: "pro-shop-1.myshopify.com" };
const SHOP_2 = { id: "shop-pro-002", domain: "pro-shop-2.myshopify.com" };
const SHOP_3 = { id: "shop-pro-003", domain: "pro-shop-3.myshopify.com" };

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

async function runPollThemeChanges(
  stepOverrides?: Partial<ReturnType<typeof createMockInngestStep>>,
) {
  const step = { ...createMockInngestStep(), ...stepOverrides };
  const event = { name: "scheduled/daily", data: {}, ts: Date.now(), id: "test-event-poll" };
  return getInngestHandler(pollThemeChanges)({ event, step, logger: mockLogger });
}

// ---------------------------------------------------------------------------
// Setup: reset mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Default: one Professional shop
  mockDb.shop.findMany.mockResolvedValue([SHOP_1]);
  mockInngestSend.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Plan filter invariant — S-02 regression test
// ---------------------------------------------------------------------------

describe("pollThemeChanges coordinator — plan filter (S-02 regression)", () => {
  it("queries DB with plan: 'Professional' (capital P), not 'professional' (lowercase)", async () => {
    await runPollThemeChanges();

    expect(mockDb.shop.findMany).toHaveBeenCalledOnce();
    const callArg = mockDb.shop.findMany.mock.calls[0][0];

    expect(callArg.where.plan).toBe("Professional");
    expect(callArg.where.plan).not.toBe("professional");
  });

  it("selects only id and domain fields from shop", async () => {
    await runPollThemeChanges();

    const callArg = mockDb.shop.findMany.mock.calls[0][0];
    // S-14: accessToken removed from select — unauthenticated.admin() handles
    // session lookup internally in the worker function.
    expect(callArg.select).toEqual({
      id: true,
      domain: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Happy path — one Professional shop
// ---------------------------------------------------------------------------

describe("pollThemeChanges coordinator — happy path", () => {
  it("returns total: 1 and dispatched: 1 when one shop is found", async () => {
    const result = await runPollThemeChanges();

    expect(result.total).toBe(1);
    expect(result.dispatched).toBe(1);
  });

  it("sends one poll/check-shop event for the shop", async () => {
    await runPollThemeChanges();

    expect(mockInngestSend).toHaveBeenCalledOnce();
    const payload = mockInngestSend.mock.calls[0][0];

    // send() receives an array of events (batch send pattern)
    expect(Array.isArray(payload)).toBe(true);
    expect(payload).toHaveLength(1);
    expect(payload[0].name).toBe("poll/check-shop");
    expect(payload[0].data.shopId).toBe(SHOP_1.id);
    expect(payload[0].data.shopDomain).toBe(SHOP_1.domain);
  });
});

// ---------------------------------------------------------------------------
// Multiple shops — fan-out sends correct event batch
// ---------------------------------------------------------------------------

describe("pollThemeChanges coordinator — multiple shops", () => {
  beforeEach(() => {
    mockDb.shop.findMany.mockResolvedValue([SHOP_1, SHOP_2, SHOP_3]);
  });

  it("returns total: 3 and dispatched: 3", async () => {
    const result = await runPollThemeChanges();

    expect(result.total).toBe(3);
    expect(result.dispatched).toBe(3);
  });

  it("sends one poll/check-shop event per shop in a single batch", async () => {
    await runPollThemeChanges();

    expect(mockInngestSend).toHaveBeenCalledOnce();
    const payload = mockInngestSend.mock.calls[0][0];

    expect(Array.isArray(payload)).toBe(true);
    expect(payload).toHaveLength(3);

    const names = payload.map((e: Record<string, unknown>) => e.name);
    expect(names).toEqual(["poll/check-shop", "poll/check-shop", "poll/check-shop"]);

    const shopIds = payload.map(
      (e: Record<string, unknown>) => (e.data as Record<string, unknown>).shopId,
    );
    expect(shopIds).toContain(SHOP_1.id);
    expect(shopIds).toContain(SHOP_2.id);
    expect(shopIds).toContain(SHOP_3.id);
  });

  it("includes the correct shopDomain in each event", async () => {
    await runPollThemeChanges();

    const payload = mockInngestSend.mock.calls[0][0];
    const domainMap = Object.fromEntries(
      payload.map((e: Record<string, unknown>) => {
        const data = e.data as Record<string, unknown>;
        return [data.shopId, data.shopDomain];
      }),
    );

    expect(domainMap[SHOP_1.id]).toBe(SHOP_1.domain);
    expect(domainMap[SHOP_2.id]).toBe(SHOP_2.domain);
    expect(domainMap[SHOP_3.id]).toBe(SHOP_3.domain);
  });
});

// ---------------------------------------------------------------------------
// No shops — empty Professional cohort
// ---------------------------------------------------------------------------

describe("pollThemeChanges coordinator — no Professional shops", () => {
  beforeEach(() => {
    mockDb.shop.findMany.mockResolvedValue([]);
  });

  it("returns total: 0 and dispatched: 0", async () => {
    const result = await runPollThemeChanges();

    expect(result.total).toBe(0);
    expect(result.dispatched).toBe(0);
  });

  it("does not call inngest.send when there are no shops", async () => {
    await runPollThemeChanges();

    expect(mockInngestSend).not.toHaveBeenCalled();
  });
});

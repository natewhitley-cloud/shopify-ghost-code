/**
 * Tests for the shared cron fan-out helper.
 *
 * The helper chunks `poll/check-shop` fan-out into batches of
 * FAN_OUT_CHUNK_SIZE (500) to respect Inngest's 512-event send() hard cap, and
 * sends each chunk inside its own named step for retry-safe redelivery.
 *
 * Key invariants tested:
 *   - 0 shops -> no send, no step
 *   - <= 500 shops -> exactly 1 send
 *   - 1001 shops -> 3 chunks of 500 / 500 / 1, each sent
 *   - No chunk ever exceeds FAN_OUT_CHUNK_SIZE
 *   - Each chunk runs in its own named step (fan-out-shops-chunk-N)
 *   - Every event is a poll/check-shop with the shop's id + domain
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (hoisted by Vitest before imports)
// ---------------------------------------------------------------------------

vi.mock("../../../inngest/client", () => ({
  inngest: {
    send: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

import { inngest } from "../../../inngest/client";
import {
  fanOutShopChecks,
  FAN_OUT_CHUNK_SIZE,
  type FanOutShop,
} from "../../../inngest/lib/fan-out";
import { createMockInngestStep } from "../../mocks/inngest";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockInngestSend = (inngest as unknown as { send: ReturnType<typeof vi.fn> }).send;

function makeShops(count: number): FanOutShop[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `shop-${i}`,
    domain: `shop-${i}.myshopify.com`,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInngestSend.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Empty cohort
// ---------------------------------------------------------------------------

describe("fanOutShopChecks — empty cohort", () => {
  it("does not call inngest.send or step.run when there are no shops", async () => {
    const step = createMockInngestStep();

    await fanOutShopChecks(step, []);

    expect(mockInngestSend).not.toHaveBeenCalled();
    expect(step.run).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Within a single chunk
// ---------------------------------------------------------------------------

describe("fanOutShopChecks — single chunk", () => {
  it("sends exactly one batch for 1 shop", async () => {
    const step = createMockInngestStep();

    await fanOutShopChecks(step, makeShops(1));

    expect(mockInngestSend).toHaveBeenCalledOnce();
    expect(mockInngestSend.mock.calls[0][0]).toHaveLength(1);
  });

  it("sends exactly one batch for exactly 500 shops (boundary)", async () => {
    const step = createMockInngestStep();

    await fanOutShopChecks(step, makeShops(FAN_OUT_CHUNK_SIZE));

    expect(mockInngestSend).toHaveBeenCalledOnce();
    expect(mockInngestSend.mock.calls[0][0]).toHaveLength(FAN_OUT_CHUNK_SIZE);
  });

  it("emits well-formed poll/check-shop events carrying id + domain", async () => {
    const step = createMockInngestStep();
    const shops = makeShops(2);

    await fanOutShopChecks(step, shops);

    const batch = mockInngestSend.mock.calls[0][0];
    expect(batch[0]).toEqual({
      name: "poll/check-shop",
      data: { shopId: shops[0].id, shopDomain: shops[0].domain },
    });
    expect(batch[1]).toEqual({
      name: "poll/check-shop",
      data: { shopId: shops[1].id, shopDomain: shops[1].domain },
    });
  });
});

// ---------------------------------------------------------------------------
// Multiple chunks
// ---------------------------------------------------------------------------

describe("fanOutShopChecks — chunking across the 512 cap", () => {
  it("splits 501 shops into 2 chunks of 500 / 1", async () => {
    const step = createMockInngestStep();

    await fanOutShopChecks(step, makeShops(FAN_OUT_CHUNK_SIZE + 1));

    expect(mockInngestSend).toHaveBeenCalledTimes(2);
    expect(mockInngestSend.mock.calls[0][0]).toHaveLength(500);
    expect(mockInngestSend.mock.calls[1][0]).toHaveLength(1);
  });

  it("splits 1001 shops into 3 chunks of 500 / 500 / 1", async () => {
    const step = createMockInngestStep();

    await fanOutShopChecks(step, makeShops(1001));

    expect(mockInngestSend).toHaveBeenCalledTimes(3);
    const sizes = mockInngestSend.mock.calls.map((call) => call[0].length);
    expect(sizes).toEqual([500, 500, 1]);
  });

  it("never sends a chunk larger than FAN_OUT_CHUNK_SIZE", async () => {
    const step = createMockInngestStep();

    await fanOutShopChecks(step, makeShops(1001));

    for (const call of mockInngestSend.mock.calls) {
      expect(call[0].length).toBeLessThanOrEqual(FAN_OUT_CHUNK_SIZE);
    }
  });

  it("dispatches every shop exactly once across all chunks", async () => {
    const step = createMockInngestStep();
    const shops = makeShops(1001);

    await fanOutShopChecks(step, shops);

    const dispatchedIds = mockInngestSend.mock.calls.flatMap((call) =>
      call[0].map((event: { data: { shopId: string } }) => event.data.shopId),
    );
    expect(dispatchedIds).toHaveLength(1001);
    expect(new Set(dispatchedIds).size).toBe(1001);
    expect(dispatchedIds).toEqual(shops.map((s) => s.id));
  });

  it("runs each chunk in its own named step for retry-safe redelivery", async () => {
    const step = createMockInngestStep();

    await fanOutShopChecks(step, makeShops(1001));

    expect(step.run).toHaveBeenCalledTimes(3);
    const stepIds = step.run.mock.calls.map((call) => call[0]);
    expect(stepIds).toEqual([
      "fan-out-shops-chunk-0",
      "fan-out-shops-chunk-1",
      "fan-out-shops-chunk-2",
    ]);
  });
});

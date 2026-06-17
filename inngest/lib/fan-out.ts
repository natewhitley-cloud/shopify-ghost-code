/**
 * Shared fan-out helper for the cron coordinators.
 *
 * Both the weekly-scan (Standard plan) and poll-theme-changes (Professional
 * plan) coordinators fan out one `poll/check-shop` event per shop to the
 * poll-check-shop worker. This helper is the single source of truth for that
 * fan-out so the two coordinators cannot drift apart.
 *
 * Why chunking matters:
 *   `inngest.send()` accepts at most 512 events in a single call — that is a
 *   HARD CAP, not auto-batching. If a plan cohort ever exceeds 512 shops, a
 *   single unchunked send() would fail and that week's/day's scans would never
 *   dispatch. We chunk at 500 (a safe margin under the cap) and send each chunk.
 *
 * Why one named step per chunk:
 *   Each chunk is sent inside its OWN named `step.run(...)`. Inngest memoizes
 *   named steps independently, so if one chunk's send() fails and the step
 *   retries, only the FAILED chunk is re-sent — not every chunk. A single step
 *   wrapping the whole loop would, on retry, re-send every chunk and double-fire
 *   `poll/check-shop` events, risking duplicate scan dispatch downstream.
 */

/** Minimal shop shape the fan-out needs — matches the coordinator DB select. */
export type FanOutShop = {
  id: string;
  domain: string;
};

/**
 * Minimal structural type for the Inngest `step` tool the helper uses. Matches
 * both the real Inngest step and the test mock (`createMockInngestStep`).
 */
export type FanOutStep = {
  run: (id: string, fn: () => Promise<unknown>) => unknown;
};

/** Max events per `inngest.send()` chunk — safe margin under the 512 hard cap. */
export const FAN_OUT_CHUNK_SIZE = 500;

/**
 * Fan out one `poll/check-shop` event per shop, chunked to respect Inngest's
 * 512-event send() cap. Each chunk is sent inside its own named step so retries
 * only re-send the failed chunk (see module docstring).
 *
 * No-op when `shops` is empty (no chunks, no send). Callers should still keep
 * their own early return for the empty cohort so they can short-circuit logging.
 *
 * @param step  Inngest step tool from the coordinator handler.
 * @param shops Shops to dispatch a check event for.
 */
export async function fanOutShopChecks(step: FanOutStep, shops: FanOutShop[]): Promise<void> {
  for (let offset = 0; offset < shops.length; offset += FAN_OUT_CHUNK_SIZE) {
    const chunk = shops.slice(offset, offset + FAN_OUT_CHUNK_SIZE);
    const chunkIndex = offset / FAN_OUT_CHUNK_SIZE;

    await step.run(`fan-out-shops-chunk-${chunkIndex}`, async () => {
      // Dynamic import matches the coordinators' existing in-step idiom and
      // keeps the client mockable in tests via the resolved module path.
      const { inngest } = await import("../client");
      await inngest.send(
        chunk.map((shop) => ({
          name: "poll/check-shop" as const,
          data: {
            shopId: shop.id,
            shopDomain: shop.domain,
          },
        })),
      );
    });
  }
}

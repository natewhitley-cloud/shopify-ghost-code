/**
 * Tests for app/services/review-request.server.ts (gc-97k.7) with the real
 * claimShopStamp (shop model) and the real nudge emitters, against a mocked
 * Prisma client whose Shop.updateMany keeps state, so concurrent claims race
 * for real on one row.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = vi.hoisted(() => ({
  shop: { updateMany: vi.fn() },
  opsEvent: { create: vi.fn() },
}));

vi.mock("../../app/db.server", () => ({ default: mockDb }));

const mockLoggerError = vi.fn();
vi.mock("../../app/lib/logger.server", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));

import { REVIEW_REQUEST_CODES } from "../../app/lib/review-request";
import { recordReviewRequestResult } from "../../app/services/review-request.server";

const DOMAIN = "merchant.myshopify.com";

/** One Shop row; updateMany applies the where-guard like Postgres would. */
let row: { domain: string; reviewPopupRequestedAt: Date | null };

beforeEach(() => {
  vi.clearAllMocks();
  row = { domain: DOMAIN, reviewPopupRequestedAt: null };
  mockDb.opsEvent.create.mockResolvedValue({ id: "e1" });
  mockDb.shop.updateMany.mockImplementation(
    async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: { reviewPopupRequestedAt: Date };
    }) => {
      // Yield first so concurrent callers interleave before either writes.
      await Promise.resolve();
      if (where.domain !== row.domain) return { count: 0 };
      if (where.reviewPopupRequestedAt !== null || row.reviewPopupRequestedAt !== null) {
        return { count: 0 };
      }
      row.reviewPopupRequestedAt = data.reviewPopupRequestedAt;
      return { count: 1 };
    },
  );
});

function recordedEvents() {
  return mockDb.opsEvent.create.mock.calls.map(
    ([arg]) => arg.data as { eventType: string; key: string; metadata: unknown },
  );
}

describe("recordReviewRequestResult", () => {
  it("stamps reviewPopupRequestedAt (only while null) and records `shown` when displayed", async () => {
    await expect(recordReviewRequestResult(DOMAIN, "success")).resolves.toBe(true);

    expect(mockDb.shop.updateMany).toHaveBeenCalledWith({
      where: { domain: DOMAIN, reviewPopupRequestedAt: null },
      data: { reviewPopupRequestedAt: expect.any(Date) },
    });
    expect(row.reviewPopupRequestedAt).toBeInstanceOf(Date);
    expect(recordedEvents()).toEqual([
      expect.objectContaining({
        eventType: "nudge_shown",
        key: DOMAIN,
        metadata: { nudgeKey: "review_request" },
      }),
    ]);
  });

  it.each(REVIEW_REQUEST_CODES.filter((c) => c !== "success"))(
    "records `not_shown` with the code (never `shown`) for %s, and still stamps",
    async (code) => {
      await expect(recordReviewRequestResult(DOMAIN, code)).resolves.toBe(true);

      expect(row.reviewPopupRequestedAt).toBeInstanceOf(Date);
      expect(recordedEvents()).toEqual([
        expect.objectContaining({
          eventType: "nudge_not_shown",
          key: DOMAIN,
          metadata: { nudgeKey: "review_request", code },
        }),
      ]);
    },
  );

  it("records nothing once already requested (once ever)", async () => {
    row.reviewPopupRequestedAt = new Date("2026-01-01T00:00:00Z");

    await expect(recordReviewRequestResult(DOMAIN, "success")).resolves.toBe(false);
    expect(mockDb.opsEvent.create).not.toHaveBeenCalled();
  });

  it("claims the stamp exactly once under concurrency (two tabs, one event)", async () => {
    const results = await Promise.all([
      recordReviewRequestResult(DOMAIN, "success"),
      recordReviewRequestResult(DOMAIN, "already-open"),
      recordReviewRequestResult(DOMAIN, "success"),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(mockDb.shop.updateMany).toHaveBeenCalledTimes(3);
    expect(mockDb.opsEvent.create).toHaveBeenCalledTimes(1);
  });

  it("never throws: a failed claim logs, returns false, and records nothing", async () => {
    mockDb.shop.updateMany.mockRejectedValueOnce(new Error("db down"));

    await expect(recordReviewRequestResult(DOMAIN, "success")).resolves.toBe(false);
    expect(mockDb.opsEvent.create).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledWith(
      "review-request-claim-failed",
      expect.objectContaining({ shop: DOMAIN, code: "success", error: "db down" }),
    );
  });
});

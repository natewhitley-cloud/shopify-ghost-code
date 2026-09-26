/**
 * Tests for app/services/review-request.server.ts (gc-97k.7) with the real
 * shop-model writes and the real nudge emitters, against a mocked Prisma
 * client whose Shop.updateMany keeps state (tests/mocks/fake-shop-row), so
 * concurrent and replayed reports race for real on one row.
 *
 * Changed on purpose (audit): every result used to stamp the once-ever
 * reviewPopupRequestedAt. Now only TERMINAL codes stamp it; RETRYABLE codes
 * back off (reviewPopupRetryAfter), and only "success" claims the prompt slot.
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

import { REVIEW_REQUEST_CODES, REVIEW_RESULT_POLICY } from "../../app/lib/review-request";
import type { ReviewRequestCode } from "../../app/lib/review-request";
import {
  claimReviewRequestAttempt,
  recordReviewRequestResult,
} from "../../app/services/review-request.server";
import { installFakeShopRow } from "../mocks/fake-shop-row";
import type { FakeRow } from "../mocks/fake-shop-row";

const DOMAIN = "merchant.myshopify.com";
const NOW = new Date("2026-09-26T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ATTEMPT_AT = new Date(NOW.getTime() - 5_000);

const TERMINAL: ReviewRequestCode[] = [
  "success",
  "already-reviewed",
  "merchant-ineligible",
  "annual-limit-reached",
  "cancelled",
];
const RETRYABLE: Array<[ReviewRequestCode, number]> = [
  ["recently-installed", DAY],
  ["mobile-app", DAY],
  ["cooldown-period", 60 * DAY],
  ["already-open", HOUR],
  ["open-in-progress", HOUR],
  ["error", DAY],
  ["unavailable", DAY],
  ["unknown", DAY],
];

/** A shop whose loader just recorded attempt #1 (no result yet). */
let row: FakeRow;

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.opsEvent.create.mockResolvedValue({ id: "e1" });
  row = installFakeShopRow(mockDb.shop, {
    domain: DOMAIN,
    reviewPopupRequestedAt: null,
    reviewPopupRetryAfter: null,
    reviewPopupAttemptCount: 1,
    reviewPopupLastAttemptAt: ATTEMPT_AT,
    reviewPopupLastResult: null,
    lastPromptKey: null,
    lastPromptShownAt: null,
  });
});

function recordedEvents() {
  return mockDb.opsEvent.create.mock.calls.map(
    ([arg]) => arg.data as { eventType: string; key: string; metadata: unknown },
  );
}

describe("the result policy table", () => {
  it("covers every code exactly once, as terminal or retryable", () => {
    expect([...TERMINAL, ...RETRYABLE.map(([c]) => c)].sort()).toEqual(
      [...REVIEW_REQUEST_CODES].sort(),
    );
  });
});

describe("recordReviewRequestResult: success", () => {
  it("stamps terminal, records the code, claims the 24h prompt slot, and emits `shown`", async () => {
    await expect(recordReviewRequestResult(DOMAIN, "success", NOW)).resolves.toBe(true);

    expect(mockDb.shop.updateMany).toHaveBeenCalledWith({
      where: { domain: DOMAIN, reviewPopupRequestedAt: null },
      data: {
        reviewPopupRequestedAt: NOW,
        reviewPopupLastResult: "success",
        lastPromptKey: "review_popup",
        lastPromptShownAt: NOW,
      },
    });
    expect(row.reviewPopupRequestedAt).toEqual(NOW);
    expect(row.lastPromptKey).toBe("review_popup");
    expect(recordedEvents()).toEqual([
      expect.objectContaining({
        eventType: "nudge_shown",
        key: DOMAIN,
        metadata: { nudgeKey: "review_request" },
      }),
    ]);
  });
});

describe("recordReviewRequestResult: other terminal codes", () => {
  it.each(TERMINAL.filter((c) => c !== "success"))(
    "%s: stamps terminal and the code, claims NO slot, emits `not_shown` with the code",
    async (code) => {
      expect(REVIEW_RESULT_POLICY[code]).toEqual({ kind: "terminal" });

      await expect(recordReviewRequestResult(DOMAIN, code, NOW)).resolves.toBe(true);

      expect(row.reviewPopupRequestedAt).toEqual(NOW);
      expect(row.reviewPopupLastResult).toBe(code);
      expect(row.lastPromptKey).toBeNull();
      expect(row.lastPromptShownAt).toBeNull();
      expect(recordedEvents()).toEqual([
        expect.objectContaining({
          eventType: "nudge_not_shown",
          metadata: { nudgeKey: "review_request", code },
        }),
      ]);
    },
  );

  it("records nothing once a terminal result exists (once ever)", async () => {
    row.reviewPopupRequestedAt = new Date("2026-01-01T00:00:00Z");

    await expect(recordReviewRequestResult(DOMAIN, "success", NOW)).resolves.toBe(false);
    await expect(recordReviewRequestResult(DOMAIN, "cancelled", NOW)).resolves.toBe(false);
    expect(mockDb.opsEvent.create).not.toHaveBeenCalled();
    expect(row.lastPromptKey).toBeNull();
  });
});

describe("recordReviewRequestResult: retryable codes", () => {
  it.each(RETRYABLE)(
    "%s: backs off by exactly its delay, never stamps terminal, claims no slot",
    async (code, delay) => {
      expect(REVIEW_RESULT_POLICY[code]).toEqual({ kind: "retry", afterMs: delay });

      await expect(recordReviewRequestResult(DOMAIN, code, NOW)).resolves.toBe(true);

      expect(mockDb.shop.updateMany).toHaveBeenCalledWith({
        where: {
          domain: DOMAIN,
          reviewPopupRequestedAt: null,
          reviewPopupLastAttemptAt: { not: null },
          reviewPopupLastResult: null,
        },
        data: {
          reviewPopupRetryAfter: new Date(NOW.getTime() + delay),
          reviewPopupLastResult: code,
        },
      });
      expect(row.reviewPopupRequestedAt).toBeNull();
      expect(row.lastPromptKey).toBeNull();
      expect(recordedEvents()).toEqual([
        expect.objectContaining({
          eventType: "nudge_not_shown",
          metadata: { nudgeKey: "review_request", code },
        }),
      ]);
    },
  );

  it("a replayed retryable report for the same attempt is a no-op (counted once)", async () => {
    await recordReviewRequestResult(DOMAIN, "already-open", NOW);
    const firstRetryAfter = row.reviewPopupRetryAfter;

    await expect(
      recordReviewRequestResult(DOMAIN, "already-open", new Date(NOW.getTime() + HOUR)),
    ).resolves.toBe(false);

    expect(row.reviewPopupRetryAfter).toEqual(firstRetryAfter);
    expect(mockDb.opsEvent.create).toHaveBeenCalledTimes(1);
  });

  it("a retryable report with no recorded attempt (stale tab) is ignored", async () => {
    row.reviewPopupLastAttemptAt = null;

    await expect(recordReviewRequestResult(DOMAIN, "mobile-app", NOW)).resolves.toBe(false);
    expect(row.reviewPopupRetryAfter).toBeNull();
  });

  it("a terminal result still lands after a retryable one on a later attempt", async () => {
    await recordReviewRequestResult(DOMAIN, "recently-installed", NOW);
    // The loader records attempt #2 a day later (clears the last result)...
    Object.assign(row, {
      reviewPopupAttemptCount: 2,
      reviewPopupLastAttemptAt: new Date(NOW.getTime() + DAY + HOUR),
      reviewPopupLastResult: null,
    });

    await expect(
      recordReviewRequestResult(DOMAIN, "success", new Date(NOW.getTime() + DAY + HOUR)),
    ).resolves.toBe(true);
    expect(row.reviewPopupRequestedAt).toBeInstanceOf(Date);
    expect(row.lastPromptKey).toBe("review_popup");
  });
});

describe("recordReviewRequestResult: concurrency and failure", () => {
  it("two tabs reporting at once: one write and one event", async () => {
    const results = await Promise.all([
      recordReviewRequestResult(DOMAIN, "success", NOW),
      recordReviewRequestResult(DOMAIN, "success", NOW),
      recordReviewRequestResult(DOMAIN, "cancelled", NOW),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(mockDb.opsEvent.create).toHaveBeenCalledTimes(1);
  });

  it("never throws: a failed write logs, returns false, and records nothing", async () => {
    mockDb.shop.updateMany.mockRejectedValueOnce(new Error("db down"));

    await expect(recordReviewRequestResult(DOMAIN, "success", NOW)).resolves.toBe(false);
    expect(mockDb.opsEvent.create).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledWith(
      "review-request-record-failed",
      expect.objectContaining({ shop: DOMAIN, code: "success", error: "db down" }),
    );
  });
});

describe("claimReviewRequestAttempt (the attempt is recorded only when the client calls the API)", () => {
  beforeEach(() => {
    row = installFakeShopRow(mockDb.shop, {
      domain: DOMAIN,
      reviewPopupRequestedAt: null,
      reviewPopupRetryAfter: null,
      reviewPopupAttemptCount: 0,
      reviewPopupLastAttemptAt: null,
      reviewPopupLastResult: "mobile-app",
    });
  });

  it("first attempt (nonce none): records it, increments, clears the last result", async () => {
    await expect(claimReviewRequestAttempt(DOMAIN, null, NOW)).resolves.toBe(true);

    expect(row.reviewPopupAttemptCount).toBe(1);
    expect(row.reviewPopupLastAttemptAt).toEqual(NOW);
    expect(row.reviewPopupLastResult).toBeNull();
  });

  it("two tabs holding the same nonce: exactly one records the attempt", async () => {
    const results = await Promise.all([
      claimReviewRequestAttempt(DOMAIN, null, NOW),
      claimReviewRequestAttempt(DOMAIN, null, NOW),
      claimReviewRequestAttempt(DOMAIN, null, NOW),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(row.reviewPopupAttemptCount).toBe(1);
  });

  it("a stale nonce (an attempt happened since the load) records nothing", async () => {
    row.reviewPopupLastAttemptAt = new Date(NOW.getTime() - 2 * DAY);
    row.reviewPopupAttemptCount = 1;

    await expect(claimReviewRequestAttempt(DOMAIN, null, NOW)).resolves.toBe(false);
    expect(row.reviewPopupAttemptCount).toBe(1);
  });

  it("refuses without a write while the nonce's attempt is inside its 24h cooldown (exactly 24h too)", async () => {
    const last = new Date(NOW.getTime() - DAY);
    row.reviewPopupLastAttemptAt = last;

    await expect(claimReviewRequestAttempt(DOMAIN, last, NOW)).resolves.toBe(false);
    expect(mockDb.shop.updateMany).not.toHaveBeenCalled();

    await expect(
      claimReviewRequestAttempt(DOMAIN, last, new Date(NOW.getTime() + 1)),
    ).resolves.toBe(true);
  });

  it("stops at 5 attempts", async () => {
    const last = new Date(NOW.getTime() - 2 * DAY);
    Object.assign(row, { reviewPopupAttemptCount: 5, reviewPopupLastAttemptAt: last });

    await expect(claimReviewRequestAttempt(DOMAIN, last, NOW)).resolves.toBe(false);
    expect(row.reviewPopupAttemptCount).toBe(5);
  });

  it("never after a terminal result", async () => {
    row.reviewPopupRequestedAt = new Date(NOW.getTime() - DAY);

    await expect(claimReviewRequestAttempt(DOMAIN, null, NOW)).resolves.toBe(false);
  });

  it("never throws: a failed write logs and is false", async () => {
    mockDb.shop.updateMany.mockRejectedValueOnce(new Error("db down"));

    await expect(claimReviewRequestAttempt(DOMAIN, null, NOW)).resolves.toBe(false);
    expect(mockLoggerError).toHaveBeenCalledWith(
      "review-request-attempt-claim-failed",
      expect.objectContaining({ shop: DOMAIN, error: "db down" }),
    );
  });
});

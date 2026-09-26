/**
 * Tests for app/services/review-request.server.ts (gc-97k.7) with the real
 * shop-model writes and the real nudge emitters, against a mocked Prisma
 * client whose Shop row keeps state (tests/mocks/fake-shop-row), so
 * concurrent and replayed requests race for real on one row.
 *
 * Changed on purpose:
 *   - (audit) every result used to stamp the once-ever reviewPopupRequestedAt.
 *     Now only TERMINAL codes stamp it; RETRYABLE codes back off.
 *   - (re-audit #3) the prompt slot is claimed by the ATTEMPT, not by a
 *     `success` report: success keeps it, any other result hands it back to the
 *     holder the attempt replaced (only while the popup still holds it).
 *   - (re-audit #4) the attempt re-checks the retry backoff and the 2h since
 *     the first results view, so a hand-made POST cannot skip them.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = vi.hoisted(() => ({
  shop: { updateMany: vi.fn(), findUnique: vi.fn() },
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
const ago = (ms: number) => new Date(NOW.getTime() - ms);

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

/** The feedback nudge held the slot 3 days ago (an expired window). */
const OLD_HOLDER = { lastPromptKey: "feedback", lastPromptShownAt: ago(3 * DAY) };

let row: FakeRow;

/** A shop eligible for the popup: first results view 3h ago, never attempted. */
function eligibleShop(overrides: FakeRow = {}): FakeRow {
  return installFakeShopRow(mockDb.shop, {
    domain: DOMAIN,
    firstResultsViewedAt: ago(3 * HOUR),
    reviewPopupRequestedAt: null,
    reviewPopupRetryAfter: null,
    reviewPopupAttemptCount: 0,
    reviewPopupLastAttemptAt: null,
    reviewPopupLastResult: null,
    reviewPopupPrevPromptKey: null,
    reviewPopupPrevPromptShownAt: null,
    ...OLD_HOLDER,
    ...overrides,
  });
}

/** The same shop right after attempt #1 at NOW (claimed the slot, no result yet). */
async function attempted(): Promise<void> {
  row = eligibleShop();
  expect(await claimReviewRequestAttempt(DOMAIN, null, NOW)).toBe(true);
  mockDb.shop.updateMany.mockClear();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.opsEvent.create.mockResolvedValue({ id: "e1" });
  row = eligibleShop();
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

// ---------------------------------------------------------------------------
// The attempt (intent=attempt)
// ---------------------------------------------------------------------------

describe("claimReviewRequestAttempt", () => {
  it("records the attempt AND claims the prompt slot, remembering the holder it replaced", async () => {
    await expect(claimReviewRequestAttempt(DOMAIN, null, NOW)).resolves.toBe(true);

    expect(row.reviewPopupAttemptCount).toBe(1);
    expect(row.reviewPopupLastAttemptAt).toEqual(NOW);
    expect(row.reviewPopupLastResult).toBeNull();
    expect(row.lastPromptKey).toBe("review_popup");
    expect(row.lastPromptShownAt).toEqual(NOW);
    expect(row.reviewPopupPrevPromptKey).toBe("feedback");
    expect(row.reviewPopupPrevPromptShownAt).toEqual(OLD_HOLDER.lastPromptShownAt);
  });

  it("two tabs holding the same nonce: exactly one records the attempt and takes the slot", async () => {
    const results = await Promise.all([
      claimReviewRequestAttempt(DOMAIN, null, NOW),
      claimReviewRequestAttempt(DOMAIN, null, NOW),
      claimReviewRequestAttempt(DOMAIN, null, NOW),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(row.reviewPopupAttemptCount).toBe(1);
  });

  it("refuses while ANOTHER prompt holds an open 24h window (no two prompts within 24h)", async () => {
    row = eligibleShop({ lastPromptKey: "upgrade_return", lastPromptShownAt: ago(HOUR) });

    await expect(claimReviewRequestAttempt(DOMAIN, null, NOW)).resolves.toBe(false);
    expect(row.lastPromptKey).toBe("upgrade_return");
    expect(row.reviewPopupAttemptCount).toBe(0);
  });

  it("the slot compare-and-set loses to a prompt that claimed between the read and the write", async () => {
    // Another load takes the slot after this call's read.
    const original = mockDb.shop.findUnique.getMockImplementation()!;
    mockDb.shop.findUnique.mockImplementationOnce(async (...args: unknown[]) => {
      const snapshot = await original(...args);
      Object.assign(row, { lastPromptKey: "upgrade_return", lastPromptShownAt: NOW });
      return snapshot;
    });

    await expect(claimReviewRequestAttempt(DOMAIN, null, NOW)).resolves.toBe(false);
    expect(row.lastPromptKey).toBe("upgrade_return");
    expect(row.reviewPopupAttemptCount).toBe(0);
  });

  it("a stale nonce (an attempt happened since the load) records nothing", async () => {
    row = eligibleShop({ reviewPopupLastAttemptAt: ago(2 * DAY), reviewPopupAttemptCount: 1 });

    await expect(claimReviewRequestAttempt(DOMAIN, null, NOW)).resolves.toBe(false);
    expect(row.reviewPopupAttemptCount).toBe(1);
  });

  it("refuses without a write while the nonce's attempt is inside its 24h cooldown (exactly 24h too)", async () => {
    const last = ago(DAY);
    row = eligibleShop({ reviewPopupLastAttemptAt: last, reviewPopupAttemptCount: 1 });

    await expect(claimReviewRequestAttempt(DOMAIN, last, NOW)).resolves.toBe(false);
    expect(mockDb.shop.updateMany).not.toHaveBeenCalled();

    await expect(
      claimReviewRequestAttempt(DOMAIN, last, new Date(NOW.getTime() + 1)),
    ).resolves.toBe(true);
  });

  it("refuses while a retry backoff is running (1ms before retryAfter); allowed exactly at it", async () => {
    const last = ago(2 * DAY);
    const retryAfter = new Date(NOW.getTime() + 1);
    row = eligibleShop({
      reviewPopupLastAttemptAt: last,
      reviewPopupAttemptCount: 1,
      reviewPopupRetryAfter: retryAfter,
    });

    await expect(claimReviewRequestAttempt(DOMAIN, last, NOW)).resolves.toBe(false);
    expect(row.reviewPopupAttemptCount).toBe(1);

    await expect(claimReviewRequestAttempt(DOMAIN, last, retryAfter)).resolves.toBe(true);
  });

  it("refuses 1ms short of 2h since the first results view; allowed at exactly 2h", async () => {
    row = eligibleShop({ firstResultsViewedAt: ago(2 * HOUR - 1) });
    await expect(claimReviewRequestAttempt(DOMAIN, null, NOW)).resolves.toBe(false);

    row = eligibleShop({ firstResultsViewedAt: ago(2 * HOUR) });
    await expect(claimReviewRequestAttempt(DOMAIN, null, NOW)).resolves.toBe(true);
  });

  it("refuses when the first results view was never stamped", async () => {
    row = eligibleShop({ firstResultsViewedAt: null });

    await expect(claimReviewRequestAttempt(DOMAIN, null, NOW)).resolves.toBe(false);
  });

  it("the SQL guard alone rejects a backoff or a too-early first view (hand-made state)", async () => {
    // Bypass the JS checks by handing the model a row that turns ineligible
    // after the read: the compare-and-set's own where clause must refuse.
    for (const change of [
      { reviewPopupRetryAfter: new Date(NOW.getTime() + HOUR) },
      { firstResultsViewedAt: ago(HOUR) },
    ]) {
      row = eligibleShop();
      const original = mockDb.shop.findUnique.getMockImplementation()!;
      mockDb.shop.findUnique.mockImplementationOnce(async (...args: unknown[]) => {
        const snapshot = await original(...args);
        Object.assign(row, change);
        return snapshot;
      });

      await expect(claimReviewRequestAttempt(DOMAIN, null, NOW)).resolves.toBe(false);
      expect(row.reviewPopupAttemptCount).toBe(0);
    }
  });

  it("stops at 5 attempts", async () => {
    const last = ago(2 * DAY);
    row = eligibleShop({ reviewPopupAttemptCount: 5, reviewPopupLastAttemptAt: last });

    await expect(claimReviewRequestAttempt(DOMAIN, last, NOW)).resolves.toBe(false);
    expect(row.reviewPopupAttemptCount).toBe(5);
  });

  it("never after a terminal result", async () => {
    row = eligibleShop({ reviewPopupRequestedAt: ago(DAY) });

    await expect(claimReviewRequestAttempt(DOMAIN, null, NOW)).resolves.toBe(false);
  });

  it("a missing shop row: false", async () => {
    mockDb.shop.findUnique.mockResolvedValueOnce(null);

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

// ---------------------------------------------------------------------------
// The result report
// ---------------------------------------------------------------------------

describe("recordReviewRequestResult: success", () => {
  it("stamps terminal, KEEPS the slot the attempt took, and emits `shown`", async () => {
    await attempted();

    await expect(recordReviewRequestResult(DOMAIN, "success", NOW)).resolves.toBe(true);

    expect(row.reviewPopupRequestedAt).toEqual(NOW);
    expect(row.reviewPopupLastResult).toBe("success");
    expect(row.lastPromptKey).toBe("review_popup");
    expect(row.lastPromptShownAt).toEqual(NOW);
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
    "%s: stamps terminal, RELEASES the slot to the previous holder, emits `not_shown`",
    async (code) => {
      expect(REVIEW_RESULT_POLICY[code]).toEqual({ kind: "terminal" });
      await attempted();

      await expect(recordReviewRequestResult(DOMAIN, code, NOW)).resolves.toBe(true);

      expect(row.reviewPopupRequestedAt).toEqual(NOW);
      expect(row.reviewPopupLastResult).toBe(code);
      expect(row.lastPromptKey).toBe(OLD_HOLDER.lastPromptKey);
      expect(row.lastPromptShownAt).toEqual(OLD_HOLDER.lastPromptShownAt);
      expect(recordedEvents()).toEqual([
        expect.objectContaining({
          eventType: "nudge_not_shown",
          metadata: { nudgeKey: "review_request", code },
        }),
      ]);
    },
  );

  it("records nothing once a terminal result exists (once ever)", async () => {
    await attempted();
    row.reviewPopupRequestedAt = new Date("2026-01-01T00:00:00Z");

    await expect(recordReviewRequestResult(DOMAIN, "success", NOW)).resolves.toBe(false);
    await expect(recordReviewRequestResult(DOMAIN, "cancelled", NOW)).resolves.toBe(false);
    expect(mockDb.opsEvent.create).not.toHaveBeenCalled();
    expect(row.lastPromptKey).toBe("review_popup"); // nothing released on a replay
  });
});

describe("recordReviewRequestResult: retryable codes", () => {
  it.each(RETRYABLE)(
    "%s: backs off by exactly its delay, never stamps terminal, RELEASES the slot",
    async (code, delay) => {
      expect(REVIEW_RESULT_POLICY[code]).toEqual({ kind: "retry", afterMs: delay });
      await attempted();

      await expect(recordReviewRequestResult(DOMAIN, code, NOW)).resolves.toBe(true);

      expect(row.reviewPopupRetryAfter).toEqual(new Date(NOW.getTime() + delay));
      expect(row.reviewPopupLastResult).toBe(code);
      expect(row.reviewPopupRequestedAt).toBeNull();
      expect(row.lastPromptKey).toBe(OLD_HOLDER.lastPromptKey);
      expect(row.lastPromptShownAt).toEqual(OLD_HOLDER.lastPromptShownAt);
      expect(recordedEvents()).toEqual([
        expect.objectContaining({
          eventType: "nudge_not_shown",
          metadata: { nudgeKey: "review_request", code },
        }),
      ]);
    },
  );

  it("a replayed retryable report for the same attempt is a no-op (counted once)", async () => {
    await attempted();
    await recordReviewRequestResult(DOMAIN, "already-open", NOW);
    const firstRetryAfter = row.reviewPopupRetryAfter;

    await expect(
      recordReviewRequestResult(DOMAIN, "already-open", new Date(NOW.getTime() + HOUR)),
    ).resolves.toBe(false);

    expect(row.reviewPopupRetryAfter).toEqual(firstRetryAfter);
    expect(mockDb.opsEvent.create).toHaveBeenCalledTimes(1);
  });

  it("a retryable report with no recorded attempt (stale tab) is ignored", async () => {
    await expect(recordReviewRequestResult(DOMAIN, "mobile-app", NOW)).resolves.toBe(false);
    expect(row.reviewPopupRetryAfter).toBeNull();
  });

  it("a terminal result still lands after a retryable one on a later attempt", async () => {
    await attempted();
    await recordReviewRequestResult(DOMAIN, "recently-installed", NOW);
    const later = new Date(NOW.getTime() + 2 * DAY);
    const nonce = row.reviewPopupLastAttemptAt as Date;

    await expect(claimReviewRequestAttempt(DOMAIN, nonce, later)).resolves.toBe(true);
    await expect(recordReviewRequestResult(DOMAIN, "success", later)).resolves.toBe(true);
    expect(row.reviewPopupRequestedAt).toEqual(later);
    expect(row.lastPromptKey).toBe("review_popup");
    expect(row.lastPromptShownAt).toEqual(later);
  });
});

describe("recordReviewRequestResult: the release never clobbers another holder", () => {
  it("a prompt that took the slot since the attempt keeps it after a non-success result", async () => {
    await attempted();
    // e.g. the popup's 24h window lapsed and the return banner claimed.
    Object.assign(row, { lastPromptKey: "upgrade_return", lastPromptShownAt: ago(-HOUR) });

    await expect(recordReviewRequestResult(DOMAIN, "mobile-app", NOW)).resolves.toBe(true);

    expect(row.lastPromptKey).toBe("upgrade_return");
    expect(row.lastPromptShownAt).toEqual(ago(-HOUR));
  });

  it("a slot re-claimed by a LATER popup attempt is not released by an old attempt's report", async () => {
    await attempted();
    // A later attempt took the slot again at a different time.
    const later = new Date(NOW.getTime() + 2 * DAY);
    Object.assign(row, { lastPromptShownAt: later });

    await recordReviewRequestResult(DOMAIN, "cancelled", NOW);

    expect(row.lastPromptKey).toBe("review_popup");
    expect(row.lastPromptShownAt).toEqual(later);
  });

  it("a never-prompted shop is released back to an empty slot", async () => {
    row = eligibleShop({ lastPromptKey: null, lastPromptShownAt: null });
    await claimReviewRequestAttempt(DOMAIN, null, NOW);

    await recordReviewRequestResult(DOMAIN, "cancelled", NOW);

    expect(row.lastPromptKey).toBeNull();
    expect(row.lastPromptShownAt).toBeNull();
  });

  it("a failed release is logged and the result still counts", async () => {
    await attempted();
    mockDb.shop.findUnique.mockRejectedValueOnce(new Error("read failed"));

    await expect(recordReviewRequestResult(DOMAIN, "mobile-app", NOW)).resolves.toBe(true);
    expect(mockLoggerError).toHaveBeenCalledWith(
      "review-request-slot-release-failed",
      expect.objectContaining({ shop: DOMAIN, error: "read failed" }),
    );
  });
});

describe("recordReviewRequestResult: concurrency and failure", () => {
  it("two tabs reporting at once: one write and one event", async () => {
    await attempted();

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

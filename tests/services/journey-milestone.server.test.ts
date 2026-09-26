/**
 * Tests for app/services/journey-milestone.server.ts (gc-dpm.1): the durable
 * firstOpenedAt / firstResultsViewedAt stamps, exercised with the REAL
 * claimShopStamp (shop model) against a mocked Prisma client, so the once-only
 * `where <column> IS NULL` guard is asserted end to end.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = vi.hoisted(() => ({
  shop: { updateMany: vi.fn() },
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

import { recordJourneyMilestoneOnce } from "../../app/services/journey-milestone.server";

const DOMAIN = "merchant.myshopify.com";

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each(["firstOpenedAt", "firstResultsViewedAt"] as const)("milestone %s", (column) => {
  it("stamps the column once, only while it is null, keyed on the shop domain", async () => {
    mockDb.shop.updateMany.mockResolvedValueOnce({ count: 1 });

    await expect(recordJourneyMilestoneOnce(column, DOMAIN)).resolves.toBe(true);

    expect(mockDb.shop.updateMany).toHaveBeenCalledTimes(1);
    const call = mockDb.shop.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ domain: DOMAIN, [column]: null });
    expect(Object.keys(call.data)).toEqual([column]);
    expect(call.data[column]).toBeInstanceOf(Date);
  });

  it("does not re-stamp: an already-set column (count 0) reports false", async () => {
    mockDb.shop.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(recordJourneyMilestoneOnce(column, DOMAIN)).resolves.toBe(false);
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it("never throws: a failed claim logs and reports false", async () => {
    mockDb.shop.updateMany.mockRejectedValueOnce(new Error("db down"));

    await expect(recordJourneyMilestoneOnce(column, DOMAIN)).resolves.toBe(false);
    expect(mockLoggerError).toHaveBeenCalledWith("journey-milestone-claim-failed", {
      shop: DOMAIN,
      milestone: column,
      error: "db down",
    });
  });

  it("never throws on a non-Error rejection either", async () => {
    mockDb.shop.updateMany.mockRejectedValueOnce("boom");

    await expect(recordJourneyMilestoneOnce(column, DOMAIN)).resolves.toBe(false);
    expect(mockLoggerError).toHaveBeenCalledWith(
      "journey-milestone-claim-failed",
      expect.objectContaining({ error: "boom" }),
    );
  });
});

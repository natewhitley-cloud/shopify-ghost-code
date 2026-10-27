/**
 * Tests for app/services/install-source.server.ts (gc-3twe): the answer is
 * stored at most once, `converted` is emitted only on a win, a failed write
 * is reported (not thrown), and a telemetry failure never fails a stored
 * answer. The claim is mocked at the shop model; the telemetry emitter is the
 * REAL one over a mocked Prisma client, so its never-throw contract is
 * exercised rather than assumed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = vi.hoisted(() => ({ opsEvent: { create: vi.fn() } }));
vi.mock("../../app/db.server", () => ({ default: mockDb }));

vi.mock("../../app/models/shop.server", () => ({
  claimInstallSourceAnswer: vi.fn(),
}));

vi.mock("../../app/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from "../../app/lib/logger.server";
import { claimInstallSourceAnswer } from "../../app/models/shop.server";
import { recordInstallSourceAnswer } from "../../app/services/install-source.server";

const mockClaim = vi.mocked(claimInstallSourceAnswer);
const DOMAIN = "merchant.myshopify.com";
const ANSWER = { source: "other" as const, other: "a podcast" };

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.opsEvent.create.mockResolvedValue({ id: "e1" });
});

describe("recordInstallSourceAnswer", () => {
  it("a win stores the answer and emits one install_source `converted` event", async () => {
    mockClaim.mockResolvedValue(true);

    await expect(recordInstallSourceAnswer(DOMAIN, ANSWER)).resolves.toBe("stored");

    expect(mockClaim).toHaveBeenCalledExactlyOnceWith(DOMAIN, ANSWER);
    expect(mockDb.opsEvent.create).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({
        eventType: "nudge_converted",
        key: DOMAIN,
        metadata: { nudgeKey: "install_source" },
      }),
    });
  });

  it("a loss (already answered or skipped, or never shown) is `lost` and emits nothing", async () => {
    mockClaim.mockResolvedValue(false);

    await expect(recordInstallSourceAnswer(DOMAIN, ANSWER)).resolves.toBe("lost");
    expect(mockDb.opsEvent.create).not.toHaveBeenCalled();
  });

  it("a failed claim is `failed`, logged without the answer text, and emits nothing", async () => {
    mockClaim.mockRejectedValue(new Error("Invalid data: a podcast"));

    await expect(recordInstallSourceAnswer(DOMAIN, ANSWER)).resolves.toBe("failed");
    expect(mockDb.opsEvent.create).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith("install-source-answer-failed", {
      shop: DOMAIN,
      errorName: "Error",
    });
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain("podcast");
  });

  it("a telemetry write failure does not throw; the stored answer still counts", async () => {
    mockClaim.mockResolvedValue(true);
    mockDb.opsEvent.create.mockRejectedValue(new Error("ops table down"));

    await expect(recordInstallSourceAnswer(DOMAIN, ANSWER)).resolves.toBe("stored");
  });
});

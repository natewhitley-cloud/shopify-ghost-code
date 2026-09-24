/**
 * Tests for app/services/upgrade-preview-nudge.server.ts (gc-97k.4) together
 * with the real claimUpgradePreviewStage (shop model) and the real nudge
 * emitters, against a mocked Prisma client.
 *
 * The dedupe contract: each stage claims its Shop stamp column with a
 * conditional updateMany (column IS NULL). Only the caller that gets
 * count === 1 emits, so reloads and concurrent requests never double-count.
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

import { recordUpgradePreviewStageOnce } from "../../app/services/upgrade-preview-nudge.server";

const DOMAIN = "merchant.myshopify.com";

const EVENT_FOR_STAGE = {
  shown: "nudge_shown",
  clicked: "nudge_clicked",
  converted: "nudge_converted",
} as const;

const COLUMN_FOR_STAGE = {
  shown: "upgradePreviewShownAt",
  clicked: "upgradePreviewClickedAt",
  converted: "upgradePreviewConvertedAt",
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.opsEvent.create.mockResolvedValue({ id: "e1" });
});

describe.each(["shown", "clicked", "converted"] as const)("stage %s", (stage) => {
  it("stamps its column only while null and emits one event on the first claim", async () => {
    mockDb.shop.updateMany.mockResolvedValueOnce({ count: 1 });

    await expect(recordUpgradePreviewStageOnce(stage, DOMAIN)).resolves.toBe(true);

    const column = COLUMN_FOR_STAGE[stage];
    const call = mockDb.shop.updateMany.mock.calls[0][0];
    expect(call.where).toMatchObject({ domain: DOMAIN, [column]: null });
    expect(call.data[column]).toBeInstanceOf(Date);
    expect(Object.keys(call.data)).toEqual([column]);

    expect(mockDb.opsEvent.create).toHaveBeenCalledTimes(1);
    expect(mockDb.opsEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: EVENT_FOR_STAGE[stage],
        key: DOMAIN,
        metadata: { nudgeKey: "upgrade_preview" },
      }),
    });
  });

  it("emits nothing when the stamp is already set (claim count 0)", async () => {
    mockDb.shop.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(recordUpgradePreviewStageOnce(stage, DOMAIN)).resolves.toBe(false);
    expect(mockDb.opsEvent.create).not.toHaveBeenCalled();
  });

  it("emits exactly once across two concurrent calls (only one claim wins)", async () => {
    mockDb.shop.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    const results = await Promise.all([
      recordUpgradePreviewStageOnce(stage, DOMAIN),
      recordUpgradePreviewStageOnce(stage, DOMAIN),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(mockDb.opsEvent.create).toHaveBeenCalledTimes(1);
  });

  it("never throws: a failed claim logs, returns false, and emits nothing", async () => {
    mockDb.shop.updateMany.mockRejectedValueOnce(new Error("db down"));

    await expect(recordUpgradePreviewStageOnce(stage, DOMAIN)).resolves.toBe(false);
    expect(mockDb.opsEvent.create).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledWith(
      "upgrade-preview-nudge-claim-failed",
      expect.objectContaining({ shop: DOMAIN, stage, error: "db down" }),
    );
  });
});

describe("converted requires a prior click", () => {
  it("only claims when upgradePreviewClickedAt is set", async () => {
    mockDb.shop.updateMany.mockResolvedValueOnce({ count: 1 });

    await recordUpgradePreviewStageOnce("converted", DOMAIN);

    expect(mockDb.shop.updateMany.mock.calls[0][0].where).toEqual({
      domain: DOMAIN,
      upgradePreviewConvertedAt: null,
      upgradePreviewClickedAt: { not: null },
    });
  });

  it("shown and clicked do not depend on any other stage", async () => {
    mockDb.shop.updateMany.mockResolvedValue({ count: 1 });

    await recordUpgradePreviewStageOnce("shown", DOMAIN);
    await recordUpgradePreviewStageOnce("clicked", DOMAIN);

    expect(mockDb.shop.updateMany.mock.calls[0][0].where).toEqual({
      domain: DOMAIN,
      upgradePreviewShownAt: null,
    });
    expect(mockDb.shop.updateMany.mock.calls[1][0].where).toEqual({
      domain: DOMAIN,
      upgradePreviewClickedAt: null,
    });
  });
});

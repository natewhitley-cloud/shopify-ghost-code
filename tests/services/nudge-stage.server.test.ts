/**
 * Tests for app/services/nudge-stage.server.ts (gc-97k.3): the shared
 * once-per-merchant nudge stage claim, exercised for the FEEDBACK nudge with the
 * real claimShopStamp (shop model) and the real emitters against a mocked
 * Prisma client. The upgrade-preview path through the same helper is covered by
 * tests/services/upgrade-preview-nudge.server.test.ts.
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

import { recordNudgeStageOnce } from "../../app/services/nudge-stage.server";

const DOMAIN = "merchant.myshopify.com";

const FEEDBACK_STAGES = {
  shown: { column: "feedbackNudgeShownAt", event: "nudge_shown" },
  clicked: { column: "feedbackNudgeClickedAt", event: "nudge_clicked" },
  dismissed: { column: "feedbackNudgeDismissedAt", event: "nudge_dismissed" },
  converted: { column: "feedbackSubmittedAt", event: "nudge_converted" },
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.opsEvent.create.mockResolvedValue({ id: "e1" });
});

describe.each(Object.keys(FEEDBACK_STAGES) as Array<keyof typeof FEEDBACK_STAGES>)(
  "feedback stage %s",
  (stage) => {
    const { column, event } = FEEDBACK_STAGES[stage];

    it("claims only its own column (no preconditions) and emits one feedback event", async () => {
      mockDb.shop.updateMany.mockResolvedValueOnce({ count: 1 });

      await expect(recordNudgeStageOnce("feedback", stage, DOMAIN)).resolves.toBe(true);

      const call = mockDb.shop.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ domain: DOMAIN, [column]: null });
      expect(Object.keys(call.data)).toEqual([column]);
      expect(call.data[column]).toBeInstanceOf(Date);
      expect(mockDb.opsEvent.create).toHaveBeenCalledTimes(1);
      expect(mockDb.opsEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          eventType: event,
          key: DOMAIN,
          metadata: { nudgeKey: "feedback" },
        }),
      });
    });

    it("emits nothing when already stamped (claim count 0)", async () => {
      mockDb.shop.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(recordNudgeStageOnce("feedback", stage, DOMAIN)).resolves.toBe(false);
      expect(mockDb.opsEvent.create).not.toHaveBeenCalled();
    });

    it("emits exactly once across concurrent calls (only one claim wins)", async () => {
      mockDb.shop.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 0 });

      const results = await Promise.all([
        recordNudgeStageOnce("feedback", stage, DOMAIN),
        recordNudgeStageOnce("feedback", stage, DOMAIN),
        recordNudgeStageOnce("feedback", stage, DOMAIN),
      ]);

      expect(results.filter(Boolean)).toHaveLength(1);
      expect(mockDb.opsEvent.create).toHaveBeenCalledTimes(1);
    });

    it("never throws: a failed claim logs feedback-nudge-claim-failed and emits nothing", async () => {
      mockDb.shop.updateMany.mockRejectedValueOnce(new Error("db down"));

      await expect(recordNudgeStageOnce("feedback", stage, DOMAIN)).resolves.toBe(false);
      expect(mockDb.opsEvent.create).not.toHaveBeenCalled();
      expect(mockLoggerError).toHaveBeenCalledWith(
        "feedback-nudge-claim-failed",
        expect.objectContaining({ shop: DOMAIN, stage, error: "db down" }),
      );
    });
  },
);

it("upgrade_preview converted keeps its prior-shown precondition through the shared helper", async () => {
  mockDb.shop.updateMany.mockResolvedValueOnce({ count: 1 });

  await recordNudgeStageOnce("upgrade_preview", "converted", DOMAIN);

  expect(mockDb.shop.updateMany.mock.calls[0][0].where).toEqual({
    domain: DOMAIN,
    upgradePreviewConvertedAt: null,
    upgradePreviewShownAt: { not: null },
  });
  expect(mockDb.opsEvent.create.mock.calls[0][0].data.metadata).toEqual({
    nudgeKey: "upgrade_preview",
  });
});

it("rejects, at compile time, a stage the nudge does not have", () => {
  // @ts-expect-error the upgrade preview has no dismiss control, so no `dismissed` stage
  const invalid = () => recordNudgeStageOnce("upgrade_preview", "dismissed", DOMAIN);
  expect(typeof invalid).toBe("function");
});

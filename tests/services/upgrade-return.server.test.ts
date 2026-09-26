/**
 * Tests for app/services/upgrade-return.server.ts (gc-97k.9) with the real
 * shop model (claimShopStamp, startUpgradeReturnEpisode,
 * recordUpgradeReturnDismissal), the real nudge-stage claim and the real
 * emitters, against a mocked Prisma client whose Shop.updateMany keeps state
 * on one row, so concurrent writes race for real.
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

import {
  dismissUpgradeReturn,
  markUpgradeReturnShown,
} from "../../app/services/upgrade-return.server";

const DOMAIN = "merchant.myshopify.com";
const NOW = new Date("2026-09-26T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

type Row = Record<string, Date | number | null> & { upgradeReturnDismissCount: number };
let row: Row;

/**
 * Applies a Prisma updateMany the way Postgres would on one row: every where
 * key must match (null = IS NULL, { not: null } = IS NOT NULL), then `data`
 * is applied, with { increment } evaluated against the row at write time.
 */
async function fakeUpdateMany({
  where,
  data,
}: {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
}) {
  await Promise.resolve(); // let concurrent callers interleave
  for (const [key, cond] of Object.entries(where)) {
    if (key === "domain") {
      if (cond !== DOMAIN) return { count: 0 };
    } else if (cond === null) {
      if (row[key] !== null) return { count: 0 };
    } else if (typeof cond === "object" && cond !== null && "not" in cond) {
      if (row[key] === null) return { count: 0 };
    }
  }
  for (const [key, value] of Object.entries(data)) {
    row[key] =
      typeof value === "object" && value !== null && "increment" in value
        ? (row[key] as number) + (value as { increment: number }).increment
        : (value as Date);
  }
  return { count: 1 };
}

function events(eventType?: string) {
  return mockDb.opsEvent.create.mock.calls
    .map(([arg]) => arg.data as { eventType: string; metadata: { nudgeKey: string } })
    .filter((d) => eventType === undefined || d.eventType === eventType);
}

beforeEach(() => {
  vi.clearAllMocks();
  row = {
    upgradeReturnLastShownAt: null,
    upgradeReturnLastDismissedAt: null,
    upgradeReturnDismissCount: 0,
    upgradeReturnShownAt: null,
    upgradeReturnDismissedAt: null,
  };
  mockDb.shop.updateMany.mockImplementation(fakeUpdateMany);
  mockDb.opsEvent.create.mockResolvedValue({ id: "e1" });
});

const state = () => ({
  upgradeReturnLastShownAt: row.upgradeReturnLastShownAt as Date | null,
  upgradeReturnLastDismissedAt: row.upgradeReturnLastDismissedAt as Date | null,
  upgradeReturnShownAt: row.upgradeReturnShownAt as Date | null,
});

describe("markUpgradeReturnShown", () => {
  it("first ever render: starts an episode at `now` and emits `shown` once", async () => {
    await markUpgradeReturnShown(DOMAIN, state(), NOW);

    expect(row.upgradeReturnLastShownAt).toEqual(NOW);
    expect(row.upgradeReturnShownAt).toBeInstanceOf(Date);
    expect(events()).toEqual([
      expect.objectContaining({
        eventType: "nudge_shown",
        key: DOMAIN,
        metadata: { nudgeKey: "upgrade_return" },
      }),
    ]);
  });

  it("a reload inside the open episode writes nothing and emits nothing", async () => {
    row.upgradeReturnLastShownAt = ago(HOUR);
    row.upgradeReturnShownAt = ago(HOUR);

    await markUpgradeReturnShown(DOMAIN, state(), NOW);

    expect(mockDb.shop.updateMany).not.toHaveBeenCalled();
    expect(row.upgradeReturnLastShownAt).toEqual(ago(HOUR));
    expect(events()).toEqual([]);
  });

  it("a later weekly episode moves upgradeReturnLastShownAt but never re-emits `shown`", async () => {
    row.upgradeReturnLastShownAt = ago(7 * 24 * HOUR);
    row.upgradeReturnShownAt = ago(7 * 24 * HOUR);

    await markUpgradeReturnShown(DOMAIN, state(), NOW);

    expect(row.upgradeReturnLastShownAt).toEqual(NOW);
    expect(events()).toEqual([]);
  });

  it("concurrent first renders emit `shown` exactly once", async () => {
    const s = state();
    await Promise.all([
      markUpgradeReturnShown(DOMAIN, s, NOW),
      markUpgradeReturnShown(DOMAIN, s, NOW),
    ]);

    expect(events("nudge_shown")).toHaveLength(1);
  });

  it("never throws when the episode write fails; still claims `shown`", async () => {
    mockDb.shop.updateMany
      .mockRejectedValueOnce(new Error("db down"))
      .mockImplementation(fakeUpdateMany);

    await expect(markUpgradeReturnShown(DOMAIN, state(), NOW)).resolves.toBeUndefined();
    expect(mockLoggerError).toHaveBeenCalledWith(
      "upgrade-return-episode-write-failed",
      expect.objectContaining({ shop: DOMAIN, error: "db down" }),
    );
    expect(events("nudge_shown")).toHaveLength(1);
  });
});

describe("dismissUpgradeReturn", () => {
  it("increments the count in SQL and ends the episode in ONE statement", async () => {
    await dismissUpgradeReturn(DOMAIN, NOW);

    expect(mockDb.shop.updateMany.mock.calls[0][0]).toEqual({
      where: { domain: DOMAIN },
      data: { upgradeReturnDismissCount: { increment: 1 }, upgradeReturnLastDismissedAt: NOW },
    });
    expect(row.upgradeReturnDismissCount).toBe(1);
    expect(row.upgradeReturnLastDismissedAt).toEqual(NOW);
  });

  it("emits `dismissed` once per merchant, however many dismissals", async () => {
    await dismissUpgradeReturn(DOMAIN, NOW);
    await dismissUpgradeReturn(DOMAIN, NOW);
    await dismissUpgradeReturn(DOMAIN, NOW);

    expect(row.upgradeReturnDismissCount).toBe(3);
    expect(events("nudge_dismissed")).toEqual([
      expect.objectContaining({ key: DOMAIN, metadata: { nudgeKey: "upgrade_return" } }),
    ]);
  });

  it("loses no increment under concurrency (two tabs dismiss at once)", async () => {
    await Promise.all([dismissUpgradeReturn(DOMAIN, NOW), dismissUpgradeReturn(DOMAIN, NOW)]);

    expect(row.upgradeReturnDismissCount).toBe(2);
    expect(events("nudge_dismissed")).toHaveLength(1);
  });

  it("never throws when the write fails: logs and records nothing", async () => {
    mockDb.shop.updateMany.mockRejectedValueOnce(new Error("db down"));

    await expect(dismissUpgradeReturn(DOMAIN, NOW)).resolves.toBeUndefined();
    expect(mockLoggerError).toHaveBeenCalledWith(
      "upgrade-return-dismiss-write-failed",
      expect.objectContaining({ shop: DOMAIN, error: "db down" }),
    );
    expect(events()).toEqual([]);
  });
});

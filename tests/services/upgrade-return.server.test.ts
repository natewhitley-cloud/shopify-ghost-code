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

import { PROMPT_CAP_WINDOW_MS } from "../../app/lib/prompt-cap";
import {
  dismissUpgradeReturn,
  markUpgradeReturnShown,
} from "../../app/services/upgrade-return.server";
import { installFakeShopRow } from "../mocks/fake-shop-row";
import type { FakeRow } from "../mocks/fake-shop-row";

const DOMAIN = "merchant.myshopify.com";
const NOW = new Date("2026-09-26T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

let row: FakeRow;

function events(eventType?: string) {
  return mockDb.opsEvent.create.mock.calls
    .map(([arg]) => arg.data as { eventType: string; metadata: { nudgeKey: string } })
    .filter((d) => eventType === undefined || d.eventType === eventType);
}

beforeEach(() => {
  vi.clearAllMocks();
  row = installFakeShopRow(mockDb.shop, {
    domain: DOMAIN,
    upgradeReturnLastShownAt: null,
    upgradeReturnLastDismissedAt: null,
    upgradeReturnDismissCount: 0,
    upgradeReturnShownAt: null,
    upgradeReturnDismissedAt: null,
  });
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
    mockDb.shop.updateMany.mockRejectedValueOnce(new Error("db down"));

    await expect(markUpgradeReturnShown(DOMAIN, state(), NOW)).resolves.toBeUndefined();
    expect(mockLoggerError).toHaveBeenCalledWith(
      "upgrade-return-episode-write-failed",
      expect.objectContaining({ shop: DOMAIN, error: "db down" }),
    );
    expect(events("nudge_shown")).toHaveLength(1);
  });
});

describe("dismissUpgradeReturn", () => {
  /** An episode that started `startedAgo` before NOW and was never dismissed. */
  function openEpisode(startedAgo = HOUR) {
    row.upgradeReturnLastShownAt = ago(startedAgo);
    row.upgradeReturnShownAt = ago(startedAgo);
  }

  it("inside an open episode: increments the count in SQL and ends the episode in ONE statement", async () => {
    openEpisode();

    await expect(dismissUpgradeReturn(DOMAIN, state(), NOW)).resolves.toBe(true);

    expect(mockDb.shop.updateMany).toHaveBeenCalledTimes(2); // the dismissal + the `dismissed` stamp
    expect(mockDb.shop.updateMany.mock.calls[0][0]).toEqual({
      where: {
        domain: DOMAIN,
        upgradeReturnLastShownAt: {
          equals: ago(HOUR),
          gt: new Date(NOW.getTime() - PROMPT_CAP_WINDOW_MS),
        },
        upgradeReturnLastDismissedAt: null,
      },
      data: { upgradeReturnDismissCount: { increment: 1 }, upgradeReturnLastDismissedAt: NOW },
    });
    expect(row.upgradeReturnDismissCount).toBe(1);
    expect(row.upgradeReturnLastDismissedAt).toEqual(NOW);
    expect(events("nudge_dismissed")).toHaveLength(1);
  });

  it("repeated submits in ONE episode count once (each re-reads the row)", async () => {
    openEpisode();

    const results = [];
    for (let i = 0; i < 3; i++) results.push(await dismissUpgradeReturn(DOMAIN, state(), NOW));

    expect(results).toEqual([true, false, false]);
    expect(row.upgradeReturnDismissCount).toBe(1);
  });

  it("concurrent submits that read the same open episode count once", async () => {
    openEpisode();
    const read = state();

    const results = await Promise.all([
      dismissUpgradeReturn(DOMAIN, read, NOW),
      dismissUpgradeReturn(DOMAIN, read, NOW),
      dismissUpgradeReturn(DOMAIN, read, NOW),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(row.upgradeReturnDismissCount).toBe(1);
    expect(events("nudge_dismissed")).toHaveLength(1);
  });

  it("never shown: no write, no event", async () => {
    await expect(dismissUpgradeReturn(DOMAIN, state(), NOW)).resolves.toBe(false);

    expect(mockDb.shop.updateMany).not.toHaveBeenCalled();
    expect(row.upgradeReturnDismissCount).toBe(0);
  });

  it("the episode's 24h window has passed (exactly 24h): no write", async () => {
    openEpisode(PROMPT_CAP_WINDOW_MS);

    await expect(dismissUpgradeReturn(DOMAIN, state(), NOW)).resolves.toBe(false);
    expect(mockDb.shop.updateMany).not.toHaveBeenCalled();
  });

  it("1ms inside the window still counts", async () => {
    openEpisode(PROMPT_CAP_WINDOW_MS - 1);

    await expect(dismissUpgradeReturn(DOMAIN, state(), NOW)).resolves.toBe(true);
  });

  it("already dismissed this episode (a stale second tab): no write", async () => {
    openEpisode();
    row.upgradeReturnLastDismissedAt = ago(HOUR / 2);
    row.upgradeReturnDismissCount = 1;

    await expect(dismissUpgradeReturn(DOMAIN, state(), NOW)).resolves.toBe(false);
    expect(row.upgradeReturnDismissCount).toBe(1);
  });

  it("the SQL guard alone rejects a stale read whose episode was dismissed since", async () => {
    openEpisode();
    const staleRead = state(); // read while still open
    row.upgradeReturnLastDismissedAt = ago(HOUR / 2); // another tab dismissed first
    row.upgradeReturnDismissCount = 1;

    await expect(dismissUpgradeReturn(DOMAIN, staleRead, NOW)).resolves.toBe(false);
    expect(row.upgradeReturnDismissCount).toBe(1);
  });

  it("the SQL guard alone rejects a stale read whose episode was replaced by a new one", async () => {
    openEpisode(8 * 24 * HOUR);
    row.upgradeReturnLastDismissedAt = ago(8 * 24 * HOUR - HOUR);
    const staleRead = { ...state(), upgradeReturnLastShownAt: ago(HOUR) };

    await expect(dismissUpgradeReturn(DOMAIN, staleRead, NOW)).resolves.toBe(false);
    expect(row.upgradeReturnDismissCount).toBe(0);
  });

  it("a new weekly episode can be dismissed again (one count per episode)", async () => {
    openEpisode(8 * 24 * HOUR);
    await dismissUpgradeReturn(DOMAIN, state(), ago(8 * 24 * HOUR - HOUR));
    openEpisode(); // a new episode started an hour ago

    await expect(dismissUpgradeReturn(DOMAIN, state(), NOW)).resolves.toBe(true);
    expect(row.upgradeReturnDismissCount).toBe(2);
    expect(events("nudge_dismissed")).toHaveLength(1); // once per merchant
  });

  it("never throws when the write fails: logs and records nothing", async () => {
    openEpisode();
    mockDb.shop.updateMany.mockRejectedValueOnce(new Error("db down"));

    await expect(dismissUpgradeReturn(DOMAIN, state(), NOW)).resolves.toBe(false);
    expect(mockLoggerError).toHaveBeenCalledWith(
      "upgrade-return-dismiss-write-failed",
      expect.objectContaining({ shop: DOMAIN, error: "db down" }),
    );
    expect(events()).toEqual([]);
  });
});

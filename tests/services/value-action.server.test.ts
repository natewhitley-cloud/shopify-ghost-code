/**
 * gc-np1d.2: the inputs for the value-action card, shared by Home and the scan
 * page so both offer the same count. Written before the module.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../app/services/clean-copy.server", async (orig) => ({
  ...(await orig<typeof import("../../app/services/clean-copy.server")>()),
  checkCleanCopyFreshness: vi.fn(),
  cleanCopyTrial: vi.fn(),
}));
vi.mock("../../app/models/scan-manifest.server", () => ({ getScanManifest: vi.fn() }));
vi.mock("../../app/models/fix-run.server", () => ({ countTrialRemovals: vi.fn() }));
vi.mock("../../app/models/finding.server", () => ({ countFindingsByApp: vi.fn() }));
vi.mock("../../app/services/soft-launch-flags.server", () => ({ isCleanCopyEnabled: vi.fn() }));
vi.mock("../../app/services/nudge-stage.server", () => ({ recordNudgeStageOnce: vi.fn() }));

import { countFindingsByApp } from "../../app/models/finding.server";
import { countTrialRemovals } from "../../app/models/fix-run.server";
import { getScanManifest } from "../../app/models/scan-manifest.server";
import { checkCleanCopyFreshness, cleanCopyTrial } from "../../app/services/clean-copy.server";
import { recordNudgeStageOnce } from "../../app/services/nudge-stage.server";
import { isCleanCopyEnabled } from "../../app/services/soft-launch-flags.server";
import {
  cleanCopyOfferFor,
  cleanCopyTrialFor,
  leftoversByApp,
  leftoversByAppForScan,
  loadValueAction,
} from "../../app/services/value-action.server";

const mockFresh = checkCleanCopyFreshness as ReturnType<typeof vi.fn>;
const mockTrial = cleanCopyTrial as ReturnType<typeof vi.fn>;
const mockManifest = getScanManifest as ReturnType<typeof vi.fn>;
const mockCount = countTrialRemovals as ReturnType<typeof vi.fn>;
const mockFlag = isCleanCopyEnabled as ReturnType<typeof vi.fn>;

const NO_IGNORES = { fingerprints: new Set<string>(), appNames: new Set<string>() };

const finding = (over: Record<string, unknown>) => ({
  id: "f",
  findingType: "GHOST_SCRIPT",
  filename: "layout/theme.liquid",
  lineNumber: 1,
  appName: "Privy",
  codeSnippet: "<script src=x></script>",
  spanStart: 0,
  spanEnd: 10,
  spanSha256: "h",
  ...over,
});

describe("leftoversByApp", () => {
  it("counts removable kinds only, by app, most first, unknown app in the total only", () => {
    const res = leftoversByApp(
      [
        finding({ id: "1", appName: "Privy" }),
        finding({ id: "2", appName: "Loox" }),
        finding({ id: "3", appName: "Loox", findingType: "GHOST_STYLE" }),
        finding({ id: "4", appName: null }),
        finding({ id: "5", appName: "Privy", findingType: "DUPLICATE_META" }),
      ],
      NO_IGNORES,
    );
    expect(res).toEqual({
      total: 4,
      apps: [
        { name: "Loox", count: 2 },
        { name: "Privy", count: 1 },
      ],
    });
  });

  it("leaves out ignored findings", () => {
    const res = leftoversByApp([finding({ appName: "Privy" })], {
      fingerprints: new Set(),
      appNames: new Set(["Privy"]),
    });
    expect(res).toEqual({ total: 0, apps: [] });
  });

  it("is empty for no findings", () => {
    expect(leftoversByApp([], NO_IGNORES)).toEqual({ total: 0, apps: [] });
  });
});

const shop = {
  id: "s1",
  domain: "a.myshopify.com",
  plan: "Professional",
  lastThemePublishAt: null,
};
const scan = {
  id: "scan1",
  themeId: "t1",
  status: "COMPLETED",
  completedAt: new Date(),
  liveAppHooks: { embedApps: [] } as unknown,
};
const admin = {} as never;

describe("cleanCopyOfferFor", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockFlag.mockReturnValue(true);
    mockFresh.mockResolvedValue({ ok: true, main: { id: "t1" } });
    mockManifest.mockResolvedValue({ entries: [["layout/theme.liquid", "md5"]] });
  });

  it("is ready with the count the select page would offer", async () => {
    const res = await cleanCopyOfferFor({
      shop,
      scan,
      loadFindings: async () => [finding({ id: "1" }), finding({ id: "2", lineNumber: 2 })],
      ignores: NO_IGNORES,
      admin,
    });
    expect(res).toEqual({ state: "ready", count: 2, findingIds: ["1", "2"] });
  });

  it("does not count a file with no scan-time md5", async () => {
    mockManifest.mockResolvedValue({ entries: [["layout/theme.liquid", ""]] });
    const res = await cleanCopyOfferFor({
      shop,
      scan,
      loadFindings: async () => [finding({})],
      ignores: NO_IGNORES,
      admin,
    });
    expect(res).toEqual({ state: "none", count: 0, findingIds: [] });
  });

  it("is stale when the scan is too old to remove from", async () => {
    mockFresh.mockResolvedValue({ ok: false, reason: "SCAN_STALE" });
    const res = await cleanCopyOfferFor({
      shop,
      scan,
      loadFindings: async () => [finding({})],
      ignores: NO_IGNORES,
      admin,
    });
    expect(res).toEqual({ state: "stale", count: 0, findingIds: [] });
  });

  it.each(["ADMIN_UNAVAILABLE", "ACCESS_DENIED", "NO_MAIN_THEME", "CANVAS_THEME"])(
    "is none on %s (nothing we can offer now)",
    async (reason) => {
      mockFresh.mockResolvedValue({ ok: false, reason });
      const res = await cleanCopyOfferFor({
        shop,
        scan,
        loadFindings: async () => [finding({})],
        ignores: NO_IGNORES,
        admin,
      });
      expect(res).toEqual({ state: "none", count: 0, findingIds: [] });
    },
  );

  it("is none without reading Admin when the flag is off, the plan isn't Professional or embeds are unknown", async () => {
    mockFlag.mockReturnValue(false);
    expect(
      await cleanCopyOfferFor({
        shop,
        scan,
        loadFindings: async () => [finding({})],
        ignores: NO_IGNORES,
        admin,
      }),
    ).toEqual({ state: "none", count: 0, findingIds: [] });
    mockFlag.mockReturnValue(true);
    expect(
      await cleanCopyOfferFor({
        shop: { ...shop, plan: "Standard" },
        scan,
        loadFindings: async () => [finding({})],
        ignores: NO_IGNORES,
        admin,
      }),
    ).toEqual({ state: "none", count: 0, findingIds: [] });
    expect(
      await cleanCopyOfferFor({
        shop,
        scan: { ...scan, liveAppHooks: null },
        loadFindings: async () => [finding({})],
        ignores: NO_IGNORES,
        admin,
      }),
    ).toEqual({ state: "none", count: 0, findingIds: [] });
    expect(mockFresh).not.toHaveBeenCalled();
  });

  it("never throws: a failed read is none", async () => {
    mockFresh.mockRejectedValue(new Error("boom"));
    const res = await cleanCopyOfferFor({
      shop,
      scan,
      loadFindings: async () => [finding({})],
      ignores: NO_IGNORES,
      admin,
    });
    expect(res).toEqual({ state: "none", count: 0, findingIds: [] });
  });
});

describe("cleanCopyTrialFor", () => {
  beforeEach(() => vi.resetAllMocks());

  it("is null on a paid subscription", async () => {
    mockTrial.mockResolvedValue({ ok: true, trial: null });
    expect(await cleanCopyTrialFor(admin, "s1")).toBeNull();
  });

  it("gives what is left and the unlock day during the trial", async () => {
    mockTrial.mockResolvedValue({ ok: true, trial: { endsAt: new Date("2026-11-21T00:00:00Z") } });
    mockCount.mockResolvedValue(2);
    expect(await cleanCopyTrialFor(admin, "s1")).toEqual({
      remaining: 3,
      unlocksOn: "November 21",
    });
  });

  it("never goes below zero", async () => {
    mockTrial.mockResolvedValue({ ok: true, trial: { endsAt: new Date("2026-11-21T00:00:00Z") } });
    mockCount.mockResolvedValue(9);
    expect((await cleanCopyTrialFor(admin, "s1"))?.remaining).toBe(0);
  });

  it("is null when the subscription can't be read (the select page still enforces the limit)", async () => {
    mockTrial.mockResolvedValue({ ok: false, reason: "ADMIN_UNAVAILABLE" });
    expect(await cleanCopyTrialFor(admin, "s1")).toBeNull();
    mockTrial.mockRejectedValue(new Error("boom"));
    expect(await cleanCopyTrialFor(admin, "s1")).toBeNull();
  });
});

describe("leftoversByAppForScan", () => {
  it("sums the groupBy rows, unknown app in the total only", async () => {
    vi.mocked(countFindingsByApp).mockResolvedValue([
      { appName: "Privy", count: 3 },
      { appName: null, count: 2 },
      { appName: "Loox", count: 4 },
    ]);
    expect(await leftoversByAppForScan("scan1")).toEqual({
      total: 9,
      apps: [
        { name: "Loox", count: 4 },
        { name: "Privy", count: 3 },
      ],
    });
  });

  it("never throws: a failed read counts nothing", async () => {
    vi.mocked(countFindingsByApp).mockRejectedValue(new Error("db down"));
    expect(await leftoversByAppForScan("scan1")).toEqual({ total: 0, apps: [] });
  });
});

describe("cleanCopyOfferFor read order", () => {
  it("reads no findings when the scan is stale or Admin fails", async () => {
    vi.resetAllMocks();
    mockFlag.mockReturnValue(true);
    const loadFindings = vi.fn(async () => [finding({})]);
    mockFresh.mockResolvedValue({ ok: false, reason: "SCAN_STALE" });
    await cleanCopyOfferFor({ shop, scan, loadFindings, ignores: NO_IGNORES, admin });
    mockFresh.mockResolvedValue({ ok: false, reason: "ADMIN_UNAVAILABLE" });
    await cleanCopyOfferFor({ shop, scan, loadFindings, ignores: NO_IGNORES, admin });
    expect(loadFindings).not.toHaveBeenCalled();
  });

  it("a failed findings read offers nothing", async () => {
    vi.resetAllMocks();
    mockFlag.mockReturnValue(true);
    mockFresh.mockResolvedValue({ ok: true, main: { id: "t1" } });
    mockManifest.mockResolvedValue({ entries: [] });
    const res = await cleanCopyOfferFor({
      shop,
      scan,
      loadFindings: async () => {
        throw new Error("db down");
      },
      ignores: NO_IGNORES,
      admin,
    });
    expect(res).toEqual({ state: "none", count: 0, findingIds: [] });
  });
});

// gc-np1d.5: the card's `shown` stamps (telemetry only; outcomes list item 1).
describe("loadValueAction shown stamps", () => {
  const SESSION_SHOP = "a.myshopify.com";
  const mockStage = recordNudgeStageOnce as ReturnType<typeof vi.fn>;
  const load = (plan: string, kept: ReturnType<typeof finding>[]) =>
    loadValueAction({
      shop: { ...shop, plan },
      scan: { ...scan, themeName: "Dawn", createdAt: new Date() },
      keptFindings: kept as never,
      ignores: NO_IGNORES,
      admin,
      shopDomain: SESSION_SHOP,
    });

  beforeEach(() => {
    vi.resetAllMocks();
    mockFlag.mockReturnValue(false);
    mockStage.mockResolvedValue(true);
  });

  it("Standard with leftovers: do-it-yourself and the upsell are each stamped shown, for the session shop", async () => {
    mockFlag.mockReturnValue(true);
    const { card } = await load("Standard", [finding({})]);
    expect(card?.kind).toBe("diy");
    expect(mockStage.mock.calls).toEqual([
      ["clean_copy_diy", "shown", SESSION_SHOP],
      ["clean_copy_upsell", "shown", SESSION_SHOP],
    ]);
  });

  it("Standard with Clean copy off: only do-it-yourself (no upsell for a feature that's off)", async () => {
    await load("Standard", [finding({})]);
    expect(mockStage.mock.calls).toEqual([["clean_copy_diy", "shown", SESSION_SHOP]]);
  });

  it("Free with leftovers: only the upsell is stamped", async () => {
    mockFlag.mockReturnValue(true);
    const { card } = await load("Free", [finding({})]);
    expect(card?.telemetryKey).toBe("clean_copy_upsell");
    expect(mockStage.mock.calls).toEqual([["clean_copy_upsell", "shown", SESSION_SHOP]]);
  });

  it("nothing to remove: no stamp", async () => {
    await load("Standard", []);
    expect(mockStage).not.toHaveBeenCalled();
  });

  it("a stamp that finds nothing to claim still returns the card", async () => {
    mockStage.mockResolvedValue(false);
    const { card } = await load("Standard", [finding({})]);
    expect(card?.kind).toBe("diy");
  });
});

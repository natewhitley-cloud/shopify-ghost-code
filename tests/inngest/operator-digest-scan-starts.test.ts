/**
 * Operator digest: SCAN STARTS & RESULT VIEWS (24h / 7d).
 *
 * Pure first-scan classification, aggregation + rendering over
 * Scan.requestedFrom / shopScanNumber /
 * viewedOnHomeAt / viewedOnScanPageAt. The handler wiring (active-install
 * scoping through the real step) lives in operator-digest.handler.test.ts.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../inngest/client", () => ({
  inngest: { createFunction: vi.fn(() => ({})) },
}));

import {
  aggregateScanStartsViews,
  batchFirstSuccessQueries,
  buildDigestBody,
  classifyFirstScans,
  DAY_MS,
  formatScanStartsViewsLines,
  installPeriodStart,
} from "../../inngest/functions/operator-digest";
import type {
  FirstSuccessQuery,
  OperatorDigestData,
  ScanStartsViewsDigest,
  ShopInstallHistory,
} from "../../inngest/functions/operator-digest";

const NOW = new Date("2026-10-09T13:00:00Z");
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const IN_24H = ago(2 * HOUR);
const IN_7D = ago(3 * DAY_MS);
const OLDER = ago(8 * DAY_MS);
const ACTIVE = ["shop-a", "shop-b"];

type Started = Parameters<typeof aggregateScanStartsViews>[0]["started"][number];
type Viewed = Parameters<typeof aggregateScanStartsViews>[0]["viewed"][number];
type Completed = Parameters<typeof aggregateScanStartsViews>[0]["completed"][number];

const started = (o: Partial<Started> = {}): Started => ({
  shopId: "shop-a",
  origin: "MANUAL",
  requestedFrom: "home",
  shopScanNumber: 1,
  createdAt: IN_24H,
  firstScan: (o.shopScanNumber ?? 1) === 1,
  ...o,
});
const viewed = (o: Partial<Viewed> = {}): Viewed => ({
  id: "scan-1",
  shopId: "shop-a",
  firstScan: true,
  viewedOnHomeAt: null,
  viewedOnScanPageAt: null,
  ...o,
});
const completed = (o: Partial<Completed> = {}): Completed => ({
  shopId: "shop-a",
  shopScanNumber: 2,
  completedAt: IN_24H,
  viewedOnHomeAt: null,
  viewedOnScanPageAt: null,
  ...o,
});

function agg(rows: Partial<Parameters<typeof aggregateScanStartsViews>[0]>, allowed = ACTIVE) {
  return aggregateScanStartsViews(
    { started: [], viewed: [], completed: [], ...rows },
    allowed,
    NOW,
  );
}

// ---------------------------------------------------------------------------
// First scan vs rescan: no earlier SUCCESSFUL scan (any origin) in the
// shop's current install.
// ---------------------------------------------------------------------------

describe("installPeriodStart", () => {
  const history: ShopInstallHistory = {
    installedAt: ago(30 * DAY_MS),
    uninstallTimes: [ago(10 * DAY_MS), ago(2 * DAY_MS)],
  };

  it("is installedAt for a scan before any uninstall", () => {
    expect(installPeriodStart(ago(20 * DAY_MS), history)).toEqual(history.installedAt);
  });

  it("is the latest uninstall strictly before the scan", () => {
    expect(installPeriodStart(ago(5 * DAY_MS), history)).toEqual(ago(10 * DAY_MS));
    expect(installPeriodStart(ago(HOUR), history)).toEqual(ago(2 * DAY_MS));
  });

  it("ignores uninstall events older than installedAt (defensive)", () => {
    expect(
      installPeriodStart(ago(HOUR), {
        installedAt: ago(DAY_MS),
        uninstallTimes: [ago(9 * DAY_MS)],
      }),
    ).toEqual(ago(DAY_MS));
  });
});

describe("batchFirstSuccessQueries", () => {
  it("dedupes and puts one lookup per shop in each batch", () => {
    const a1 = { shopId: "a", start: ago(10 * DAY_MS) };
    const a2 = { shopId: "a", start: ago(2 * DAY_MS) };
    const b1 = { shopId: "b", start: ago(30 * DAY_MS) };

    const batches = batchFirstSuccessQueries([a1, b1, { ...a1 }, a2, { ...b1 }]);

    expect(batches).toEqual([[a1, b1], [a2]]);
  });

  it("is one batch when no shop reinstalled", () => {
    expect(
      batchFirstSuccessQueries([
        { shopId: "a", start: ago(DAY_MS) },
        { shopId: "b", start: ago(DAY_MS) },
      ]),
    ).toHaveLength(1);
  });

  it("is empty for no lookups", () => {
    expect(batchFirstSuccessQueries([])).toEqual([]);
  });
});

describe("classifyFirstScans", () => {
  type ScanFixture = { shopId: string; createdAt: Date; status: string; origin: string };
  /** In-memory stand-in for the grouped `_min(createdAt)` query, with a call log. */
  function lookupOver(scans: ScanFixture[]) {
    const calls: FirstSuccessQuery[][] = [];
    const fn = async (batch: FirstSuccessQuery[]) => {
      calls.push(batch);
      const out = new Map<string, Date>();
      for (const q of batch) {
        const times = scans
          .filter(
            (s) =>
              s.shopId === q.shopId &&
              (s.status === "COMPLETED" || s.status === "PARTIAL") &&
              s.createdAt >= q.start,
          )
          .map((s) => s.createdAt.getTime());
        if (times.length > 0) out.set(q.shopId, new Date(Math.min(...times)));
      }
      return out;
    };
    return { fn, calls };
  }
  const installs = (h: Record<string, ShopInstallHistory>) => new Map(Object.entries(h));
  const scan = (createdAt: Date, status = "COMPLETED", origin = "MANUAL", shopId = "a") => ({
    shopId,
    createdAt,
    status,
    origin,
  });
  const LONG_AGO: ShopInstallHistory = { installedAt: ago(60 * DAY_MS), uninstallTimes: [] };

  it("a normal first scan (nothing earlier) is first, even once it succeeded itself", async () => {
    const first = scan(ago(HOUR));
    const { fn } = lookupOver([first]);

    expect(await classifyFirstScans([first], installs({ a: LONG_AGO }), fn)).toEqual([true]);
  });

  it("scans after a successful one are rescans", async () => {
    const s1 = scan(ago(3 * DAY_MS));
    const s2 = scan(ago(2 * DAY_MS), "FAILED");
    const s3 = scan(ago(HOUR), "PARTIAL");
    const { fn } = lookupOver([s1, s2, s3]);

    expect(await classifyFirstScans([s1, s2, s3], installs({ a: LONG_AGO }), fn)).toEqual([
      true,
      false,
      false,
    ]);
  });

  it("failed first attempt then retry: both are first scans", async () => {
    const failed = scan(ago(2 * HOUR), "FAILED");
    const retry = scan(ago(HOUR), "COMPLETED");
    const { fn } = lookupOver([failed, retry]);

    expect(await classifyFirstScans([failed, retry], installs({ a: LONG_AGO }), fn)).toEqual([
      true,
      true,
    ]);
  });

  it("a retry still running after a failed attempt is a first scan", async () => {
    const failed = scan(ago(2 * HOUR), "FAILED");
    const retry = scan(ago(HOUR), "IN_PROGRESS");
    const { fn } = lookupOver([failed, retry]);

    expect(await classifyFirstScans([retry], installs({ a: LONG_AGO }), fn)).toEqual([true]);
  });

  it("reinstall within 48h: the new install's first scan is first, the old install's rescan stays a rescan", async () => {
    const oldFirst = scan(ago(5 * DAY_MS));
    const oldRescan = scan(ago(3 * DAY_MS));
    const uninstalledAt = ago(2 * DAY_MS);
    const newFirst = scan(ago(HOUR));
    const newRescan = scan(ago(HOUR / 2));
    const { fn, calls } = lookupOver([oldFirst, oldRescan, newFirst, newRescan]);
    const history = installs({
      a: { installedAt: ago(30 * DAY_MS), uninstallTimes: [uninstalledAt] },
    });

    expect(await classifyFirstScans([oldRescan, newFirst, newRescan], history, fn)).toEqual([
      false,
      true,
      false,
    ]);
    // Two installs in the window: two grouped lookups, one per install start.
    expect(calls).toHaveLength(2);
  });

  it("an earlier successful AUTOMATIC scan makes the first manual scan a rescan", async () => {
    const scheduled = scan(ago(DAY_MS), "COMPLETED", "SCHEDULED");
    const manual = scan(ago(HOUR));
    const { fn } = lookupOver([scheduled, manual]);

    expect(await classifyFirstScans([manual], installs({ a: LONG_AGO }), fn)).toEqual([false]);
  });

  it("an earlier FAILED automatic scan does not", async () => {
    const scheduled = scan(ago(DAY_MS), "FAILED", "AUTO_PUBLISH");
    const manual = scan(ago(HOUR));
    const { fn } = lookupOver([scheduled, manual]);

    expect(await classifyFirstScans([manual], installs({ a: LONG_AGO }), fn)).toEqual([true]);
  });

  it("classifies shops independently, in ONE grouped lookup when nobody reinstalled", async () => {
    const aOld = scan(ago(3 * DAY_MS));
    const aNew = scan(ago(HOUR));
    const bFirst = scan(ago(HOUR), "COMPLETED", "MANUAL", "b");
    const { fn, calls } = lookupOver([aOld, aNew, bFirst]);

    expect(
      await classifyFirstScans([aNew, bFirst], installs({ a: LONG_AGO, b: LONG_AGO }), fn),
    ).toEqual([false, true]);
    expect(calls).toHaveLength(1);
    expect(calls[0].map((q) => q.shopId).sort()).toEqual(["a", "b"]);
  });

  it("issues no lookup for no rows", async () => {
    const { fn, calls } = lookupOver([]);

    expect(await classifyFirstScans([], installs({}), fn)).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("aggregateScanStartsViews: scan starts", () => {
  it("returns all zeros for no rows", () => {
    const d = agg({});
    for (const w of [d.last24h, d.last7d]) {
      expect(w.firstScans).toEqual({ home: 0, scanPage: 0, unknown: 0 });
      expect(w.rescans).toEqual({ home: 0, scanPage: 0, unknown: 0 });
      expect(w.manualUntracked).toBe(0);
      expect(w.automatic).toBe(0);
    }
  });

  it("splits manual starts into first scan (number 1) vs rescans, by page", () => {
    const d = agg({
      started: [
        started({ shopScanNumber: 1, requestedFrom: "home" }),
        started({ shopScanNumber: 2, requestedFrom: "home", createdAt: IN_7D }),
        started({ shopScanNumber: 3, requestedFrom: "scan_page" }),
        started({ shopScanNumber: 4, requestedFrom: "unknown", createdAt: IN_7D }),
      ],
    });

    expect(d.last24h.firstScans).toEqual({ home: 1, scanPage: 0, unknown: 0 });
    expect(d.last24h.rescans).toEqual({ home: 0, scanPage: 1, unknown: 0 });
    expect(d.last7d.firstScans).toEqual({ home: 1, scanPage: 0, unknown: 0 });
    expect(d.last7d.rescans).toEqual({ home: 1, scanPage: 1, unknown: 1 });
  });

  it("splits by the first-scan classification, never by the stored ordinal", () => {
    const d = agg({
      started: [
        // A retry after a failed first attempt: ordinal 2, still a first scan.
        started({ shopScanNumber: 2, firstScan: true }),
        // An earlier successful automatic scan: a rescan whatever the ordinal.
        started({ shopScanNumber: 1, firstScan: false }),
      ],
    });

    expect(d.last24h.firstScans.home).toBe(1);
    expect(d.last24h.rescans.home).toBe(1);
  });

  it("counts SCHEDULED and AUTO_PUBLISH scans as automatic, whatever their other fields", () => {
    const d = agg({
      started: [
        started({ origin: "SCHEDULED", requestedFrom: null, shopScanNumber: 5 }),
        started({ origin: "AUTO_PUBLISH", requestedFrom: null, shopScanNumber: null }),
        started({ origin: "SCHEDULED", requestedFrom: null, createdAt: IN_7D }),
      ],
    });

    expect(d.last24h.automatic).toBe(2);
    expect(d.last7d.automatic).toBe(3);
    expect(d.last7d.firstScans).toEqual({ home: 0, scanPage: 0, unknown: 0 });
    expect(d.last7d.rescans).toEqual({ home: 0, scanPage: 0, unknown: 0 });
  });

  it("labels pre-deploy manual rows (no shopScanNumber) as untracked, never as unknown", () => {
    const d = agg({
      started: [
        started({ shopScanNumber: null, requestedFrom: null }),
        started({ shopScanNumber: null, requestedFrom: null, createdAt: IN_7D }),
      ],
    });

    expect(d.last24h.manualUntracked).toBe(1);
    expect(d.last7d.manualUntracked).toBe(2);
    expect(d.last7d.firstScans.unknown).toBe(0);
    expect(d.last7d.rescans.unknown).toBe(0);
  });

  it("counts a tracked manual row with a missing or unexpected page as unknown", () => {
    const d = agg({
      started: [
        started({ shopScanNumber: 2, requestedFrom: null }),
        started({ shopScanNumber: 3, requestedFrom: "settings" }),
      ],
    });

    expect(d.last24h.rescans).toEqual({ home: 0, scanPage: 0, unknown: 2 });
  });

  it("windows: 24h boundary inclusive, older than 7d ignored", () => {
    const d = agg({
      started: [
        started({ createdAt: ago(DAY_MS) }), // exactly 24h ago: in both
        started({ createdAt: ago(DAY_MS + 1) }), // just outside 24h
        started({ createdAt: ago(7 * DAY_MS) }), // exactly 7d ago: in 7d
        started({ createdAt: OLDER }),
      ],
    });

    expect(d.last24h.firstScans.home).toBe(1);
    expect(d.last7d.firstScans.home).toBe(3);
  });

  it("excludes rows of shops outside the active set (dev store, internal, uninstalled)", () => {
    const d = agg({
      started: [
        started({ shopId: "shop-internal" }),
        started({ shopId: "shop-uninstalled", origin: "SCHEDULED", requestedFrom: null }),
        started({ shopId: "shop-b" }),
      ],
    });

    expect(d.last7d.firstScans.home).toBe(1);
    expect(d.last7d.automatic).toBe(0);
  });
});

describe("aggregateScanStartsViews: result views", () => {
  it("counts each page's first view in the window, split first scan vs rescan", () => {
    const d = agg({
      viewed: [
        viewed({ id: "s1", firstScan: true, viewedOnHomeAt: IN_24H, viewedOnScanPageAt: IN_7D }),
        viewed({ id: "s2", firstScan: false, viewedOnScanPageAt: IN_24H }),
        viewed({ id: "s3", firstScan: false, viewedOnHomeAt: IN_7D }),
      ],
    });

    expect(d.last24h.viewsFirst).toEqual({ home: 1, scanPage: 0 });
    expect(d.last24h.viewsRescan).toEqual({ home: 0, scanPage: 1 });
    expect(d.last7d.viewsFirst).toEqual({ home: 1, scanPage: 1 });
    expect(d.last7d.viewsRescan).toEqual({ home: 1, scanPage: 1 });
  });

  it("ignores a stamp outside the window even when the other page's is inside", () => {
    const d = agg({
      viewed: [viewed({ viewedOnHomeAt: OLDER, viewedOnScanPageAt: IN_24H })],
    });

    expect(d.last7d.viewsFirst).toEqual({ home: 0, scanPage: 1 });
  });

  it("viewed on both pages: counted in the window where the SECOND page's view happened", () => {
    const d = agg({
      viewed: [
        // Second view in 24h.
        viewed({ id: "a", viewedOnHomeAt: IN_7D, viewedOnScanPageAt: IN_24H }),
        // Second view in 7d only.
        viewed({ id: "b", viewedOnHomeAt: OLDER, viewedOnScanPageAt: IN_7D }),
        // Second view before the window: not counted.
        viewed({ id: "c", viewedOnHomeAt: OLDER, viewedOnScanPageAt: OLDER }),
        // Only one page.
        viewed({ id: "d", viewedOnHomeAt: IN_24H }),
      ],
    });

    expect(d.last24h.viewedBoth).toBe(1);
    expect(d.last7d.viewedBoth).toBe(2);
  });

  it("counts a scan once even if it arrives twice (home + scan page query overlap)", () => {
    const row = viewed({ viewedOnHomeAt: IN_24H, viewedOnScanPageAt: IN_24H });
    const d = agg({ viewed: [row, { ...row }] });

    expect(d.last24h.viewsFirst).toEqual({ home: 1, scanPage: 1 });
    expect(d.last24h.viewedBoth).toBe(1);
  });

  it("excludes views of shops outside the active set", () => {
    const d = agg({ viewed: [viewed({ shopId: "shop-internal", viewedOnHomeAt: IN_24H })] });

    expect(d.last24h.viewsFirst).toEqual({ home: 0, scanPage: 0 });
  });
});

describe("aggregateScanStartsViews: completed, not viewed yet", () => {
  it("counts successful scans completed in the window with no view on either page", () => {
    const d = agg({
      completed: [
        completed(), // 24h, not viewed
        completed({ completedAt: IN_7D }), // 7d, not viewed
        completed({ viewedOnHomeAt: IN_24H }), // viewed on Home
        completed({ viewedOnScanPageAt: IN_24H }), // viewed on the scan page
        completed({ completedAt: OLDER }), // outside 7d
      ],
    });

    expect(d.last24h.completedNotViewed).toBe(1);
    expect(d.last7d.completedNotViewed).toBe(2);
  });

  it("counts pre-deploy scans with no recorded view as untracked, not 'not viewed'", () => {
    const d = agg({
      completed: [
        completed({ shopScanNumber: null }),
        completed({ shopScanNumber: null, viewedOnHomeAt: IN_24H }), // viewed after deploy
      ],
    });

    expect(d.last24h.completedNotViewed).toBe(0);
    expect(d.last24h.completedUntracked).toBe(1);
  });

  it("excludes completed scans of shops outside the active set", () => {
    const d = agg({ completed: [completed({ shopId: "shop-uninstalled" })] });

    expect(d.last7d.completedNotViewed).toBe(0);
  });
});

describe("formatScanStartsViewsLines", () => {
  const REALISTIC = agg({
    started: [
      started({ shopScanNumber: 1, requestedFrom: "home" }),
      started({ shopScanNumber: 1, requestedFrom: "home", shopId: "shop-b", createdAt: IN_7D }),
      started({ shopScanNumber: 2, requestedFrom: "scan_page" }),
      started({ shopScanNumber: 3, requestedFrom: "home", createdAt: IN_7D }),
      started({ origin: "SCHEDULED", requestedFrom: null, shopScanNumber: 4, createdAt: IN_7D }),
    ],
    viewed: [
      viewed({ id: "s1", firstScan: true, viewedOnHomeAt: IN_24H, viewedOnScanPageAt: IN_24H }),
      viewed({ id: "s2", firstScan: false, viewedOnScanPageAt: IN_24H }),
      viewed({ id: "s3", firstScan: false, viewedOnHomeAt: IN_7D }),
    ],
    completed: [completed({ shopScanNumber: 4, completedAt: IN_7D })],
  });

  it("renders the realistic fixture", () => {
    expect(formatScanStartsViewsLines(REALISTIC)).toEqual([
      "SCAN STARTS & RESULT VIEWS (24h / 7d)",
      "  (first = no earlier successful scan, any origin, in the current install; a failed attempt and its retry both count as first)",
      "  Manual scans started: first 1 / 2 (home 1 / 2, scan page 0 / 0, unknown 0 / 0) | rescans 1 / 2 (home 0 / 1, scan page 1 / 1, unknown 0 / 0)",
      "  Automatic scans (scheduled / theme publish): 0 / 1",
      "  Results viewed (first view per page): first scans home 1 / 1, scan page 1 / 1 | rescans home 0 / 1, scan page 1 / 1",
      "  Viewed on both pages: 1 / 1",
      "  Completed, not viewed yet: 0 / 1",
    ]);
  });

  it("adds labelled pre-tracking lines only when such rows exist", () => {
    const lines = formatScanStartsViewsLines(
      agg({
        started: [started({ shopScanNumber: null, requestedFrom: null })],
        completed: [completed({ shopScanNumber: null })],
      }),
    );

    expect(lines).toContain(
      "  Manual scans created before tracking began (page not recorded): 1 / 1",
    );
    expect(lines).toContain(
      "  Completed scans created before tracking began, no view recorded: 1 / 1",
    );
    expect(lines.join("\n")).toContain("unknown 0 / 0");
  });

  it("omits the pre-tracking lines when there are none", () => {
    expect(formatScanStartsViewsLines(REALISTIC).join("\n")).not.toMatch(/before tracking/);
  });

  it("says so when the data is absent (older caller)", () => {
    expect(formatScanStartsViewsLines(undefined)).toEqual([
      "SCAN STARTS & RESULT VIEWS (24h / 7d)",
      "  No scan start data",
    ]);
  });

  it("renders inside the digest body", () => {
    const data = {
      dateLabel: "2026-10-09",
      alerting: { configured: true, reason: "ok" },
      installs: { totalActive: 2, newIn24h: 0, uninstallsIn24h: 0 },
      planMix: { perPlan: [], mrr: { total: 0, delta: null } },
      billingEvents: { upgrade: 0, downgrade: 0, cancellation: 0, reactivation: 0 },
      mrr: { total: 0, delta: null },
      scans: {
        total: 0,
        statusCounts: { COMPLETED: 0, PARTIAL: 0, FAILED: 0, IN_PROGRESS: 0, PENDING: 0 },
        perStore: [],
      },
      findings: { total: 0, topTypes: [] },
      flywheel: {
        unknownScripts: { distinct: 0, firstSeen: 0, sightings: 0 },
        newSubmissions: 0,
        submissionsByStatus: { PENDING: 0, ACCEPTED: 0, REJECTED: 0 },
      },
      activation: { activated: 0, dormant: 0, totalActive: 0 },
      scanStartsViews: REALISTIC,
      ops: {
        functionFailures: 0,
        workerFallbacks: 0,
        webhookFailures: { failed: 0, degraded: 0 },
        apiErrors: { error: 0, warn: 0 },
        staleCrons: [],
      },
    } as unknown as OperatorDigestData;

    const body = buildDigestBody(data);

    expect(body).toContain(formatScanStartsViewsLines(REALISTIC).join("\n"));
  });

  it("the digest is plain JSON (step results are serialized)", () => {
    const d: ScanStartsViewsDigest = REALISTIC;
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
  });
});

/**
 * Operator digest: SCAN STARTS & RESULT VIEWS (24h / 7d).
 *
 * Pure aggregation + rendering over Scan.requestedFrom / shopScanNumber /
 * viewedOnHomeAt / viewedOnScanPageAt. The handler wiring (active-install
 * scoping through the real step) lives in operator-digest.handler.test.ts.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../inngest/client", () => ({
  inngest: { createFunction: vi.fn(() => ({})) },
}));

import {
  aggregateScanStartsViews,
  buildDigestBody,
  DAY_MS,
  formatScanStartsViewsLines,
} from "../../inngest/functions/operator-digest";
import type {
  OperatorDigestData,
  ScanStartsViewsDigest,
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
  ...o,
});
const viewed = (o: Partial<Viewed> = {}): Viewed => ({
  id: "scan-1",
  shopId: "shop-a",
  shopScanNumber: 1,
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
        viewed({ id: "s1", shopScanNumber: 1, viewedOnHomeAt: IN_24H, viewedOnScanPageAt: IN_7D }),
        viewed({ id: "s2", shopScanNumber: 2, viewedOnScanPageAt: IN_24H }),
        viewed({ id: "s3", shopScanNumber: 7, viewedOnHomeAt: IN_7D }),
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

  it("labels views of pre-deploy scans (no shopScanNumber) separately", () => {
    const d = agg({
      viewed: [viewed({ shopScanNumber: null, viewedOnHomeAt: IN_24H, viewedOnScanPageAt: IN_7D })],
    });

    expect(d.last24h.viewsUntracked).toEqual({ home: 1, scanPage: 0 });
    expect(d.last7d.viewsUntracked).toEqual({ home: 1, scanPage: 1 });
    expect(d.last7d.viewsFirst).toEqual({ home: 0, scanPage: 0 });
    expect(d.last7d.viewsRescan).toEqual({ home: 0, scanPage: 0 });
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
      viewed({ id: "s1", shopScanNumber: 1, viewedOnHomeAt: IN_24H, viewedOnScanPageAt: IN_24H }),
      viewed({ id: "s2", shopScanNumber: 2, viewedOnScanPageAt: IN_24H }),
      viewed({ id: "s3", shopScanNumber: 3, viewedOnHomeAt: IN_7D }),
    ],
    completed: [completed({ shopScanNumber: 4, completedAt: IN_7D })],
  });

  it("renders the realistic fixture", () => {
    expect(formatScanStartsViewsLines(REALISTIC)).toEqual([
      "SCAN STARTS & RESULT VIEWS (24h / 7d)",
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
        viewed: [viewed({ shopScanNumber: null, viewedOnScanPageAt: IN_7D })],
        completed: [completed({ shopScanNumber: null })],
      }),
    );

    expect(lines).toContain(
      "  Manual scans created before tracking began (page not recorded): 1 / 1",
    );
    expect(lines).toContain(
      "  Results viewed on scans created before tracking began: home 0 / 0, scan page 0 / 1",
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

/**
 * Tests for inngest/functions/operator-digest.ts
 *
 * Strategy:
 *   - Mock the Inngest client (3-arg createFunction) and ops-event.server so the
 *     module loads cleanly without a DB — the real withCronHeartbeat wrapper
 *     only references recordCronHeartbeat at load time.
 *   - Unit-test every pure helper (parseExcludeShops, computePlanMix/Mrr, the
 *     snapshot parse/diff, the scan/finding aggregators) and buildDigestBody
 *     (section headers, alerting banner, empty states, delta formatting).
 *   - No handler invocation: the pure aggregation + body logic is the value,
 *     and it needs no live DB.
 */

import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (hoisted) — keep module load DB-free.
// ---------------------------------------------------------------------------

vi.mock("../../inngest/client", () => ({
  inngest: {
    createFunction: vi.fn(
      (_config: unknown, _trigger: unknown, handler: (...args: unknown[]) => unknown) => ({
        fn: handler,
      }),
    ),
  },
}));

vi.mock("../../app/models/ops-event.server", () => ({
  recordCronHeartbeat: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { parseExcludeShops } from "../../app/lib/store-exclusion";
import {
  aggregateActivity,
  buildDigestBody,
  computeMrr,
  computePlanMix,
  computeResolutionRollup,
  computeScanStatusCounts,
  computeScansPerStore,
  countUninstallEventsExcluding,
  diffSnapshot,
  evaluateSnapshotMetrics,
  METRIC_THRESHOLDS,
  normalizeActivityPath,
  operatorDigest,
  parseSnapshotMetadata,
  partitionShops,
  sortFindingTypeCounts,
  type DigestSnapshot,
  type OperatorDigestData,
} from "../../inngest/functions/operator-digest";

// NOTE: the parseExcludeShops / parseExcludePrefixes / isExcluded / defaults unit
// tests moved to tests/lib/store-exclusion.test.ts (gc-4cv) alongside the module
// they now live in. parseExcludeShops is still imported above for the
// partitionShops default-exclude integration case below.

// ---------------------------------------------------------------------------
// partitionShops
// ---------------------------------------------------------------------------

describe("partitionShops", () => {
  const windowStart = new Date("2026-08-28T00:00:00Z");
  const excludeSet = new Set(["dev-store.myshopify.com"]);
  const excludePrefixes = new Set(["app-review-"]);

  it("excludes the dev store from every bucket", () => {
    const result = partitionShops(
      [
        {
          id: "dev",
          domain: "DEV-STORE.myshopify.com", // case-insensitive match
          plan: "Professional",
          installedAt: new Date("2026-08-29T00:00:00Z"),
          uninstalledAt: null,
        },
        {
          id: "s1",
          domain: "a.myshopify.com",
          plan: "Standard",
          installedAt: new Date("2026-01-01T00:00:00Z"),
          uninstalledAt: null,
        },
      ],
      excludeSet,
      excludePrefixes,
      windowStart,
    );

    expect(result.totalActive).toBe(1);
    expect(result.activeShops).toEqual([{ id: "s1", domain: "a.myshopify.com", plan: "Standard" }]);
    expect(result.activeShopIds).toEqual(["s1"]);
    expect(result.newIn24h).toBe(0);
    expect(result.domainById).toEqual({ s1: "a.myshopify.com" });
  });

  it("excludes an uninstalled-pending-redact shop from active buckets but still counts a same-window install as gross newIn24h", () => {
    const result = partitionShops(
      [
        {
          id: "churned",
          domain: "churned.myshopify.com",
          plan: "Standard",
          installedAt: new Date("2026-08-28T06:00:00Z"), // in-window install
          uninstalledAt: new Date("2026-08-28T12:00:00Z"), // uninstalled same window
        },
        {
          id: "active",
          domain: "active.myshopify.com",
          plan: "free",
          installedAt: new Date("2026-01-01T00:00:00Z"),
          uninstalledAt: null,
        },
      ],
      excludeSet,
      excludePrefixes,
      windowStart,
    );

    // NET active excludes the churned shop.
    expect(result.totalActive).toBe(1);
    expect(result.activeShopIds).toEqual(["active"]);
    expect(result.activeShops).toEqual([
      { id: "active", domain: "active.myshopify.com", plan: "free" },
    ]);
    // GROSS installs still counts the same-window install.
    expect(result.newIn24h).toBe(1);
    // domainById is the non-excluded superset (includes the churned shop) so
    // per-store scan lookups still resolve.
    expect(result.domainById).toEqual({
      churned: "churned.myshopify.com",
      active: "active.myshopify.com",
    });
  });

  it("returns empty buckets for no shops", () => {
    const result = partitionShops([], excludeSet, excludePrefixes, windowStart);
    expect(result).toEqual({
      totalActive: 0,
      newIn24h: 0,
      activeShops: [],
      activeShopIds: [],
      domainById: {},
    });
  });

  it("excludes a shop matching an exclude PREFIX from active, plan mix, and MRR", () => {
    const result = partitionShops(
      [
        {
          id: "review",
          // Shopify's ephemeral App Review store — new domain each cycle.
          domain: "app-review-fe7f0c8b-r102735-a1-primary.myshopify.com",
          plan: "Professional",
          installedAt: new Date("2026-08-29T00:00:00Z"),
          uninstalledAt: null,
        },
        {
          id: "real",
          domain: "real.myshopify.com",
          plan: "Standard",
          installedAt: new Date("2026-01-01T00:00:00Z"),
          uninstalledAt: null,
        },
      ],
      excludeSet,
      excludePrefixes,
      windowStart,
    );

    expect(result.totalActive).toBe(1);
    expect(result.activeShops).toEqual([
      { id: "real", domain: "real.myshopify.com", plan: "Standard" },
    ]);
    // Plan mix and MRR derive from activeShops, so the excluded review store
    // contributes to neither.
    expect(computePlanMix(result.activeShops)).toEqual({ free: 0, Standard: 1, Professional: 0 });
    expect(computeMrr(computePlanMix(result.activeShops))).toBe(1 * 9);
  });

  it("excludes an exact-list domain (teststore22022) while keeping a real store", () => {
    const result = partitionShops(
      [
        {
          id: "test",
          domain: "teststore22022.myshopify.com",
          plan: "free",
          installedAt: new Date("2026-01-01T00:00:00Z"),
          uninstalledAt: null,
        },
        {
          id: "real",
          domain: "real.myshopify.com",
          plan: "Standard",
          installedAt: new Date("2026-01-01T00:00:00Z"),
          uninstalledAt: null,
        },
      ],
      new Set(["teststore22022.myshopify.com"]),
      excludePrefixes,
      windowStart,
    );

    expect(result.totalActive).toBe(1);
    expect(result.activeShopIds).toEqual(["real"]);
  });

  it("excludes the internal dahi5e-1d store when using the DEFAULT exclude set", () => {
    // Operator confirmed 2026-09-22: dahi5e-1d is an internal Professional-test
    // store with 0 real Professional subscribers, so it must drop out of every
    // business metric under the default exclude set (no env override).
    const result = partitionShops(
      [
        {
          id: "internal",
          domain: "dahi5e-1d.myshopify.com",
          plan: "Professional",
          installedAt: new Date("2026-01-01T00:00:00Z"),
          uninstalledAt: null,
        },
        {
          id: "real",
          domain: "real.myshopify.com",
          plan: "Standard",
          installedAt: new Date("2026-01-01T00:00:00Z"),
          uninstalledAt: null,
        },
      ],
      parseExcludeShops(undefined),
      excludePrefixes,
      windowStart,
    );

    expect(result.totalActive).toBe(1);
    expect(result.activeShopIds).toEqual(["real"]);
    // The internal Professional store contributes $0 MRR (it is gone entirely).
    expect(computePlanMix(result.activeShops)).toEqual({ free: 0, Standard: 1, Professional: 0 });
  });

  it("does NOT over-match: a domain that CONTAINS but does not START WITH the prefix is kept", () => {
    const result = partitionShops(
      [
        {
          id: "midmatch",
          // Contains "app-review-" but does not start with it — must be kept.
          domain: "my-app-review-tool.myshopify.com",
          plan: "Professional",
          installedAt: new Date("2026-01-01T00:00:00Z"),
          uninstalledAt: null,
        },
      ],
      excludeSet,
      excludePrefixes,
      windowStart,
    );

    expect(result.totalActive).toBe(1);
    expect(result.activeShopIds).toEqual(["midmatch"]);
  });
});

// ---------------------------------------------------------------------------
// countUninstallEventsExcluding
// ---------------------------------------------------------------------------

describe("countUninstallEventsExcluding", () => {
  const excludeSet = new Set(["dev-store.myshopify.com"]);
  const excludePrefixes = new Set(["app-review-"]);

  it("excludes dev-store keys case-insensitively and counts the rest", () => {
    const count = countUninstallEventsExcluding(
      [{ key: "a.myshopify.com" }, { key: "DEV-STORE.myshopify.com" }, { key: "b.myshopify.com" }],
      excludeSet,
      excludePrefixes,
    );
    expect(count).toBe(2);
  });

  it("ignores null keys", () => {
    const count = countUninstallEventsExcluding(
      [{ key: null }, { key: "a.myshopify.com" }, { key: null }],
      excludeSet,
      excludePrefixes,
    );
    expect(count).toBe(1);
  });

  it("honors PREFIX exclusion: an app-review-* uninstall is NOT counted, a normal key IS", () => {
    // Mirrors the partitionShops prefix tests: an ephemeral app-review store
    // excluded everywhere else must not sneak back into the uninstalls line.
    const count = countUninstallEventsExcluding(
      [
        { key: "app-review-xyz.myshopify.com" }, // prefix-excluded
        { key: "DEV-STORE.myshopify.com" }, // exact-excluded (case-insensitive)
        { key: "real.myshopify.com" }, // normal — counted
      ],
      excludeSet,
      excludePrefixes,
    );
    expect(count).toBe(1);
  });

  it("returns 0 for no events", () => {
    expect(countUninstallEventsExcluding([], excludeSet, excludePrefixes)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computePlanMix / computeMrr
// ---------------------------------------------------------------------------

describe("computePlanMix", () => {
  it("counts each plan tier", () => {
    const mix = computePlanMix([
      { plan: "free" },
      { plan: "Standard" },
      { plan: "Standard" },
      { plan: "Professional" },
    ]);
    expect(mix).toEqual({ free: 1, Standard: 2, Professional: 1 });
  });

  it("buckets unknown/legacy plan values into free", () => {
    const mix = computePlanMix([{ plan: "legacy-tier" }, { plan: "" }]);
    expect(mix).toEqual({ free: 2, Standard: 0, Professional: 0 });
  });

  it("handles an empty shop list", () => {
    expect(computePlanMix([])).toEqual({
      free: 0,
      Standard: 0,
      Professional: 0,
    });
  });
});

describe("computeMrr", () => {
  it("sums Standard at 9 and Professional at 29; free contributes nothing", () => {
    expect(computeMrr({ free: 5, Standard: 2, Professional: 3 })).toBe(2 * 9 + 3 * 29);
  });

  it("is zero for an all-free mix", () => {
    expect(computeMrr({ free: 10, Standard: 0, Professional: 0 })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// parseSnapshotMetadata
// ---------------------------------------------------------------------------

describe("parseSnapshotMetadata", () => {
  const valid = {
    planMix: { free: 3, Standard: 2, Professional: 1 },
    mrr: 107,
  };

  it("parses a valid snapshot", () => {
    expect(parseSnapshotMetadata(valid)).toEqual(valid);
  });

  it("returns null for null/undefined/non-object", () => {
    expect(parseSnapshotMetadata(null)).toBeNull();
    expect(parseSnapshotMetadata(undefined)).toBeNull();
    expect(parseSnapshotMetadata("nope")).toBeNull();
    expect(parseSnapshotMetadata(42)).toBeNull();
  });

  it("returns null when planMix is missing or not an object", () => {
    expect(parseSnapshotMetadata({ mrr: 10 })).toBeNull();
    expect(parseSnapshotMetadata({ planMix: null, mrr: 10 })).toBeNull();
    expect(parseSnapshotMetadata({ planMix: "x", mrr: 10 })).toBeNull();
  });

  it("returns null when a planMix key is missing or non-numeric", () => {
    expect(parseSnapshotMetadata({ planMix: { free: 1, Standard: 2 }, mrr: 10 })).toBeNull();
    expect(
      parseSnapshotMetadata({
        planMix: { free: 1, Standard: 2, Professional: "3" },
        mrr: 10,
      }),
    ).toBeNull();
  });

  it("returns null when a planMix value is non-finite", () => {
    expect(
      parseSnapshotMetadata({
        planMix: { free: NaN, Standard: 2, Professional: 3 },
        mrr: 10,
      }),
    ).toBeNull();
  });

  it("returns null when mrr is missing or non-numeric", () => {
    expect(parseSnapshotMetadata({ planMix: valid.planMix })).toBeNull();
    expect(parseSnapshotMetadata({ planMix: valid.planMix, mrr: "107" })).toBeNull();
    expect(parseSnapshotMetadata({ planMix: valid.planMix, mrr: Infinity })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// diffSnapshot
// ---------------------------------------------------------------------------

describe("diffSnapshot", () => {
  const current: DigestSnapshot = {
    planMix: { free: 5, Standard: 3, Professional: 2 },
    mrr: 3 * 29 + 2 * 49,
  };

  it("returns null deltas on day 1 (no prior snapshot)", () => {
    const diff = diffSnapshot(current, null);
    expect(diff.mrrDelta).toBeNull();
    for (const p of diff.perPlan) expect(p.delta).toBeNull();
    expect(diff.perPlan.map((p) => p.plan)).toEqual(["free", "Standard", "Professional"]);
  });

  it("computes upward deltas vs a prior snapshot", () => {
    const prior: DigestSnapshot = {
      planMix: { free: 4, Standard: 2, Professional: 1 },
      mrr: 2 * 29 + 1 * 49,
    };
    const diff = diffSnapshot(current, prior);
    expect(diff.perPlan).toEqual([
      { plan: "free", count: 5, delta: 1 },
      { plan: "Standard", count: 3, delta: 1 },
      { plan: "Professional", count: 2, delta: 1 },
    ]);
    expect(diff.mrrDelta).toBe(current.mrr - prior.mrr);
    expect(diff.mrrDelta).toBeGreaterThan(0);
  });

  it("computes downward (negative) deltas", () => {
    const prior: DigestSnapshot = {
      planMix: { free: 8, Standard: 5, Professional: 4 },
      mrr: 5 * 29 + 4 * 49,
    };
    const diff = diffSnapshot(current, prior);
    expect(diff.perPlan[1]).toEqual({ plan: "Standard", count: 3, delta: -2 });
    expect(diff.mrrDelta).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// computeScanStatusCounts
// ---------------------------------------------------------------------------

describe("computeScanStatusCounts", () => {
  it("tallies each known status", () => {
    const counts = computeScanStatusCounts([
      { status: "COMPLETED" },
      { status: "COMPLETED" },
      { status: "PARTIAL" },
      { status: "FAILED" },
      { status: "IN_PROGRESS" },
      { status: "PENDING" },
    ]);
    expect(counts).toEqual({
      COMPLETED: 2,
      PARTIAL: 1,
      FAILED: 1,
      IN_PROGRESS: 1,
      PENDING: 1,
    });
  });

  it("ignores unknown status values", () => {
    const counts = computeScanStatusCounts([{ status: "WEIRD" }]);
    expect(counts).toEqual({
      COMPLETED: 0,
      PARTIAL: 0,
      FAILED: 0,
      IN_PROGRESS: 0,
      PENDING: 0,
    });
  });

  it("returns an all-zero map for no scans", () => {
    expect(computeScanStatusCounts([])).toEqual({
      COMPLETED: 0,
      PARTIAL: 0,
      FAILED: 0,
      IN_PROGRESS: 0,
      PENDING: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// computeScansPerStore
// ---------------------------------------------------------------------------

describe("computeScansPerStore", () => {
  const domainById = { s1: "a.myshopify.com", s2: "b.myshopify.com" };

  it("groups by shop and sorts most-active first", () => {
    const rows = computeScansPerStore(
      [{ shopId: "s1" }, { shopId: "s2" }, { shopId: "s2" }],
      domainById,
    );
    expect(rows).toEqual([
      { domain: "b.myshopify.com", count: 2 },
      { domain: "a.myshopify.com", count: 1 },
    ]);
  });

  it("falls back to the shopId when the domain is unknown", () => {
    const rows = computeScansPerStore([{ shopId: "ghost" }], domainById);
    expect(rows).toEqual([{ domain: "ghost", count: 1 }]);
  });

  it("returns an empty list for no scans", () => {
    expect(computeScansPerStore([], domainById)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// sortFindingTypeCounts
// ---------------------------------------------------------------------------

describe("sortFindingTypeCounts", () => {
  it("sorts most-frequent first without mutating the input", () => {
    const input = [
      { type: "GHOST_SCRIPT", count: 2 },
      { type: "GHOST_STYLE", count: 9 },
    ];
    const sorted = sortFindingTypeCounts(input);
    expect(sorted).toEqual([
      { type: "GHOST_STYLE", count: 9 },
      { type: "GHOST_SCRIPT", count: 2 },
    ]);
    // original order preserved
    expect(input[0].type).toBe("GHOST_SCRIPT");
  });

  it("handles an empty list", () => {
    expect(sortFindingTypeCounts([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// computeResolutionRollup (Feature 3)
// ---------------------------------------------------------------------------

describe("computeResolutionRollup", () => {
  it("sums resolved and new across successful scans and computes net", () => {
    const rollup = computeResolutionRollup([
      { status: "COMPLETED", newFindingCount: 2, resolvedFindingCount: 5 },
      { status: "PARTIAL", newFindingCount: 1, resolvedFindingCount: 3 },
    ]);
    expect(rollup).toEqual({ resolved: 8, new: 3, net: 5 });
  });

  it("ignores FAILED and in-flight scans (their counts are default-0 anyway)", () => {
    const rollup = computeResolutionRollup([
      { status: "COMPLETED", newFindingCount: 4, resolvedFindingCount: 1 },
      { status: "FAILED", newFindingCount: 9, resolvedFindingCount: 9 },
      { status: "IN_PROGRESS", newFindingCount: 9, resolvedFindingCount: 9 },
    ]);
    expect(rollup).toEqual({ resolved: 1, new: 4, net: -3 });
  });

  it("returns all zeros for an empty window", () => {
    expect(computeResolutionRollup([])).toEqual({ resolved: 0, new: 0, net: 0 });
  });
});

// ---------------------------------------------------------------------------
// normalizeActivityPath
// ---------------------------------------------------------------------------

describe("normalizeActivityPath", () => {
  it("collapses a scan-detail id to :id", () => {
    expect(normalizeActivityPath("/app/scans/clx9abc123")).toBe("/app/scans/:id");
  });

  it("collapses a scan-diff id, preserving the /diff suffix", () => {
    expect(normalizeActivityPath("/app/scans/clx9abc123/diff")).toBe("/app/scans/:id/diff");
  });

  it("collapses a scan-export id, preserving the /export suffix", () => {
    expect(normalizeActivityPath("/app/scans/clx9abc123/export")).toBe("/app/scans/:id/export");
  });

  it("leaves the /app/scans index (no id segment) untouched", () => {
    expect(normalizeActivityPath("/app/scans")).toBe("/app/scans");
  });

  it("leaves an unrelated static path untouched", () => {
    expect(normalizeActivityPath("/app/settings")).toBe("/app/settings");
  });
});

// ---------------------------------------------------------------------------
// aggregateActivity
// ---------------------------------------------------------------------------

describe("aggregateActivity", () => {
  const now = new Date("2026-09-22T12:00:00Z");
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
  const excludeSet = new Set(["dev-store.myshopify.com"]);
  const excludePrefixes = new Set(["app-review-"]);

  const visit = (key: string, path: string, h: number) => ({
    key,
    metadata: { path },
    createdAt: hoursAgo(h),
  });

  it("computes per-shop 24h/7d visit counts and durable seen-counts", () => {
    const shops = [
      { domain: "a.myshopify.com", lastSeenAt: hoursAgo(2) }, // seen 24h & 7d
      { domain: "b.myshopify.com", lastSeenAt: hoursAgo(72) }, // seen 7d only
      { domain: "c.myshopify.com", lastSeenAt: null }, // never seen
    ];
    const events = [
      visit("a.myshopify.com", "/app", 1), // a: 24h
      visit("a.myshopify.com", "/app/scans", 3), // a: 24h
      visit("a.myshopify.com", "/app/scans", 100), // a: 7d only (>24h)
      visit("b.myshopify.com", "/app", 48), // b: 7d only
    ];
    const result = aggregateActivity(events, shops, now, excludeSet, excludePrefixes);

    expect(result.totalActive).toBe(3);
    expect(result.seen24h).toBe(1); // only a
    expect(result.seen7d).toBe(2); // a + b

    const byDomain = Object.fromEntries(result.perShop.map((s) => [s.domain, s]));
    expect(byDomain["a.myshopify.com"]).toMatchObject({ visits24h: 2, visits7d: 3 });
    expect(byDomain["b.myshopify.com"]).toMatchObject({ visits24h: 0, visits7d: 1 });
    expect(byDomain["c.myshopify.com"]).toMatchObject({
      visits24h: 0,
      visits7d: 0,
      lastSeenAt: null,
    });
  });

  it("sorts most-recently-seen first with never-seen shops last", () => {
    const shops = [
      { domain: "never.myshopify.com", lastSeenAt: null },
      { domain: "old.myshopify.com", lastSeenAt: hoursAgo(100) },
      { domain: "recent.myshopify.com", lastSeenAt: hoursAgo(1) },
    ];
    const result = aggregateActivity([], shops, now, excludeSet, excludePrefixes);
    expect(result.perShop.map((s) => s.domain)).toEqual([
      "recent.myshopify.com",
      "old.myshopify.com",
      "never.myshopify.com",
    ]);
  });

  it("normalizes and ranks top pages, collapsing scan ids", () => {
    const shops = [{ domain: "a.myshopify.com", lastSeenAt: hoursAgo(1) }];
    const events = [
      visit("a.myshopify.com", "/app/scans/id-1", 1),
      visit("a.myshopify.com", "/app/scans/id-2", 2),
      visit("a.myshopify.com", "/app/scans/id-3/diff", 3),
      visit("a.myshopify.com", "/app", 4),
    ];
    const result = aggregateActivity(events, shops, now, excludeSet, excludePrefixes);
    expect(result.topPages).toEqual([
      { path: "/app/scans/:id", count: 2 },
      { path: "/app", count: 1 },
      { path: "/app/scans/:id/diff", count: 1 },
    ]);
  });

  it("omits excluded shops from BOTH per-shop rows AND top-pages (exact + prefix)", () => {
    const shops = [
      { domain: "real.myshopify.com", lastSeenAt: hoursAgo(1) },
      { domain: "dev-store.myshopify.com", lastSeenAt: hoursAgo(1) }, // exact-excluded
      { domain: "app-review-xyz.myshopify.com", lastSeenAt: hoursAgo(1) }, // prefix-excluded
    ];
    const events = [
      visit("real.myshopify.com", "/app", 1),
      visit("dev-store.myshopify.com", "/app/secret", 1), // must not appear in top-pages
      visit("app-review-xyz.myshopify.com", "/app/review-only", 1), // must not appear
    ];
    const result = aggregateActivity(events, shops, now, excludeSet, excludePrefixes);

    expect(result.totalActive).toBe(1);
    expect(result.perShop.map((s) => s.domain)).toEqual(["real.myshopify.com"]);
    expect(result.seen24h).toBe(1);
    expect(result.topPages).toEqual([{ path: "/app", count: 1 }]);
  });

  it("ignores events with a null key or malformed metadata", () => {
    const shops = [{ domain: "a.myshopify.com", lastSeenAt: hoursAgo(1) }];
    const events = [
      { key: null, metadata: { path: "/app" }, createdAt: hoursAgo(1) },
      { key: "a.myshopify.com", metadata: null, createdAt: hoursAgo(1) }, // counts a visit, no path
      { key: "a.myshopify.com", metadata: { path: "/app" }, createdAt: hoursAgo(1) },
    ];
    const result = aggregateActivity(events, shops, now, excludeSet, excludePrefixes);
    expect(result.perShop[0]).toMatchObject({ visits24h: 2, visits7d: 2 });
    // Only the well-formed metadata contributes a top-pages row.
    expect(result.topPages).toEqual([{ path: "/app", count: 1 }]);
  });

  it("returns an empty summary for no shops and no events", () => {
    const result = aggregateActivity([], [], now, excludeSet, excludePrefixes);
    expect(result).toEqual({
      totalActive: 0,
      seen24h: 0,
      seen7d: 0,
      perShop: [],
      topPages: [],
    });
  });
});

// ---------------------------------------------------------------------------
// buildDigestBody
// ---------------------------------------------------------------------------

function makeData(overrides: Partial<OperatorDigestData> = {}): OperatorDigestData {
  const base: OperatorDigestData = {
    dateLabel: "2026-08-29",
    alerting: { configured: true, reason: "ok" },
    installs: { totalActive: 12, newIn24h: 2, uninstallsIn24h: 1 },
    planMix: {
      perPlan: [
        { plan: "free", count: 7, delta: 1 },
        { plan: "Standard", count: 3, delta: 2 },
        { plan: "Professional", count: 2, delta: -1 },
      ],
      mrrDelta: 9,
    },
    billingEvents: {
      upgrade: 3,
      downgrade: 1,
      cancellation: 0,
      reactivation: 1,
    },
    mrr: { total: 3 * 29 + 2 * 49, delta: 9 },
    scans: {
      total: 5,
      statusCounts: {
        COMPLETED: 3,
        PARTIAL: 1,
        FAILED: 1,
        IN_PROGRESS: 0,
        PENDING: 0,
      },
      perStore: [
        { domain: "a.myshopify.com", count: 3 },
        { domain: "b.myshopify.com", count: 2 },
      ],
    },
    findings: {
      total: 14,
      topTypes: [
        { type: "GHOST_SCRIPT", count: 8 },
        { type: "GHOST_STYLE", count: 6 },
      ],
    },
    flywheel: {
      newUnknownScripts: 4,
      newSubmissions: 2,
      submissionsByStatus: { PENDING: 1, ACCEPTED: 1, REJECTED: 0 },
    },
    activation: { activated: 8, dormant: 4, totalActive: 12 },
    activity: {
      totalActive: 12,
      seen24h: 3,
      seen7d: 7,
      perShop: [
        {
          domain: "a.myshopify.com",
          lastSeenAt: "2026-08-29T09:00:00.000Z",
          visits24h: 4,
          visits7d: 11,
        },
        { domain: "c.myshopify.com", lastSeenAt: null, visits24h: 0, visits7d: 0 },
      ],
      topPages: [
        { path: "/app/scans", count: 12 },
        { path: "/app/scans/:id", count: 5 },
      ],
    },
    ops: {
      functionFailures: 0,
      workerFallbacks: 0,
      webhookFailures: 0,
      apiErrors: { error: 0, warn: 2 },
      staleCrons: [],
    },
  };
  return { ...base, ...overrides };
}

describe("buildDigestBody — section structure (populated)", () => {
  const body = buildDigestBody(makeData());

  it("renders the header and trailing-24h note", () => {
    expect(body).toContain("GhostCode Operator Digest -- 2026-08-29");
    expect(body).toContain("(all figures are trailing 24h unless noted)");
  });

  it("includes every section header", () => {
    for (const header of [
      "=== BUSINESS ===",
      "INSTALLS",
      "PLAN MIX (active installs)",
      "MRR (from reconciled plan; excludes free)",
      "SCANS (last 24h)",
      "FINDINGS (last 24h)",
      "RESOLUTION (last 24h)",
      "SIGNATURE FLYWHEEL (last 24h)",
      "ACTIVATION",
      "ACTIVITY (last-seen & page visits)",
      "=== OPERATIONAL HEALTH (last 24h) ===",
      "SCAN RUNS",
      "FUNCTIONS & WORKERS",
      "API",
      "CRON HEALTH (dead-man's-switch)",
      "ALERTING (paging self-check)",
    ]) {
      expect(body).toContain(header);
    }
  });

  it("renders install, billing-event, flywheel and activation figures", () => {
    expect(body).toContain("Total active: 12");
    expect(body).toContain("New in 24h: 2");
    expect(body).toContain("Uninstalls in 24h: 1");
    expect(body).toContain(
      "Billing events (24h): 3 upgrade, 1 downgrade, 0 cancellation, 1 reactivation",
    );
    expect(body).toContain("New signature submissions: 2 (1 pending, 1 accepted, 0 rejected)");
    expect(body).toContain("Activated (>= 1 scan ever): 8 of 12 active installs");
    expect(body).toContain("Dormant (0 scans ever): 4");
  });

  it("derives SCAN RUNS in section B from the same status map", () => {
    expect(body).toContain("By status: 3 completed, 1 partial, 1 failed, 0 in-progress, 0 pending");
    expect(body).toContain("Completed: 3, Failed: 1, Partial: 1");
  });

  it("renders per-store scans and top finding types", () => {
    expect(body).toContain("a.myshopify.com -- 3");
    expect(body).toContain("b.myshopify.com -- 2");
    expect(body).toContain("GHOST_SCRIPT -- 8");
    expect(body).toContain("GHOST_STYLE -- 6");
  });

  it("renders the RESOLUTION rollup with a signed positive net", () => {
    const withResolution = buildDigestBody(
      makeData({ resolution: { resolved: 12, new: 4, net: 8 } }),
    );
    expect(withResolution).toContain("Resolved: 12");
    expect(withResolution).toContain("New: 4");
    expect(withResolution).toContain("Net (resolved - new): +8");
  });

  it("renders a negative net without a plus sign and zeros when resolution is absent", () => {
    const negative = buildDigestBody(makeData({ resolution: { resolved: 1, new: 5, net: -4 } }));
    expect(negative).toContain("Net (resolved - new): -4");
    // makeData omits `resolution` → the section falls back to zeros.
    expect(body).toContain("Resolved: 0");
    expect(body).toContain("Net (resolved - new): 0");
  });
});

describe("buildDigestBody — ACTIVITY section", () => {
  it("renders seen-counts, per-shop rows (never for null lastSeenAt), and top pages", () => {
    const body = buildDigestBody(makeData());
    expect(body).toContain("Seen in last 24h: 3 of 12 active | last 7d: 7 of 12");
    expect(body).toContain(
      "a.myshopify.com -- last seen 2026-08-29T09:00:00.000Z -- visits 24h/7d: 4 / 11",
    );
    expect(body).toContain("c.myshopify.com -- last seen never -- visits 24h/7d: 0 / 0");
    expect(body).toContain("/app/scans -- 12");
    expect(body).toContain("/app/scans/:id -- 5");
  });

  it("notes truncation when more than the top-pages cap are present", () => {
    const topPages = Array.from({ length: 10 }, (_, i) => ({ path: `/p${i}`, count: 10 - i }));
    const body = buildDigestBody(
      makeData({
        activity: { totalActive: 1, seen24h: 1, seen7d: 1, perShop: [], topPages },
      }),
    );
    expect(body).toContain("...and 2 more page(s)");
  });

  it("renders graceful empty states for zero activity", () => {
    const body = buildDigestBody(
      makeData({
        activity: { totalActive: 0, seen24h: 0, seen7d: 0, perShop: [], topPages: [] },
      }),
    );
    expect(body).toContain("Seen in last 24h: 0 of 0 active | last 7d: 0 of 0");
    expect(body).toContain("No active shops");
    expect(body).toContain("No page visits in the last 7 days");
  });

  it("falls back to 'No activity data' when the activity field is absent", () => {
    const data = makeData();
    delete data.activity;
    const body = buildDigestBody(data);
    expect(body).toContain("ACTIVITY (last-seen & page visits)");
    expect(body).toContain("No activity data");
  });
});

describe("buildDigestBody — delta formatting", () => {
  it("renders per-plan count deltas and a money MRR delta when a prior exists", () => {
    const body = buildDigestBody(makeData());
    expect(body).toContain("free: 7 (+1)");
    expect(body).toContain("Standard: 3 (+2)");
    expect(body).toContain("Professional: 2 (-1)");
    expect(body).toContain(`${"$" + (3 * 29 + 2 * 49).toFixed(2)}/mo (+$9.00)`);
  });

  it("renders a negative money delta with a minus sign", () => {
    const body = buildDigestBody(makeData({ mrr: { total: 58, delta: -49 } }));
    expect(body).toContain("$58.00/mo (-$49.00)");
  });

  it("shows the day-1 no-prior-snapshot note for plan mix and MRR", () => {
    const body = buildDigestBody(
      makeData({
        planMix: {
          perPlan: [
            { plan: "free", count: 7, delta: null },
            { plan: "Standard", count: 3, delta: null },
            { plan: "Professional", count: 2, delta: null },
          ],
          mrrDelta: null,
        },
        mrr: { total: 185, delta: null },
      }),
    );
    expect(body).toContain("Net change: no prior snapshot (deltas begin tomorrow)");
    expect(body).toContain("$185.00/mo (no prior snapshot -- deltas begin tomorrow)");
    // no per-plan delta parens on day 1
    expect(body).toContain("free: 7\n");
  });
});

describe("buildDigestBody — empty states", () => {
  const body = buildDigestBody(
    makeData({
      scans: {
        total: 0,
        statusCounts: {
          COMPLETED: 0,
          PARTIAL: 0,
          FAILED: 0,
          IN_PROGRESS: 0,
          PENDING: 0,
        },
        perStore: [],
      },
      findings: { total: 0, topTypes: [] },
    }),
  );

  it("renders 'None in the window' for empty scans-by-store", () => {
    expect(body).toContain("SCANS (last 24h)");
    expect(body).toMatch(/By store:\n\s+None in the window/);
  });

  it("renders 'None in the window' for empty finding types", () => {
    expect(body).toMatch(/Top types:\n\s+None in the window/);
  });

  it("does not crash and still renders every section", () => {
    expect(body).toContain("=== BUSINESS ===");
    expect(body).toContain("=== OPERATIONAL HEALTH (last 24h) ===");
  });
});

describe("buildDigestBody — alerting self-check", () => {
  it("prints the loud disabled banner at the TOP when no recipient", () => {
    const body = buildDigestBody(
      makeData({ alerting: { configured: false, reason: "no_recipient" } }),
    );
    const bannerLine = body
      .split("\n")
      .findIndex((l) => l.includes("*** ALERTING DISABLED (OPS_ALERT_EMAIL unset)"));
    const businessLine = body.split("\n").indexOf("=== BUSINESS ===");
    expect(bannerLine).toBeGreaterThanOrEqual(0);
    // banner appears before the first content section
    expect(bannerLine).toBeLessThan(businessLine);
    expect(body).toContain("DISABLED -- OPS_ALERT_EMAIL unset");
  });

  it("names the missing transport key when RESEND_API_KEY is unset", () => {
    const body = buildDigestBody(
      makeData({ alerting: { configured: false, reason: "no_transport" } }),
    );
    expect(body).toContain(
      "*** ALERTING DISABLED (RESEND_API_KEY unset) -- operator pages will not send ***",
    );
  });

  it("shows 'Configured and live' and no banner when configured", () => {
    const body = buildDigestBody(makeData());
    expect(body).not.toContain("*** ALERTING DISABLED");
    expect(body).toContain("Configured and live");
  });
});

describe("buildDigestBody — cron health", () => {
  it("reports all crons healthy when none are stale", () => {
    expect(buildDigestBody(makeData())).toContain("All crons healthy");
  });

  it("lists overdue crons with their last heartbeat", () => {
    const body = buildDigestBody(
      makeData({
        ops: {
          functionFailures: 1,
          workerFallbacks: 2,
          webhookFailures: 0,
          apiErrors: { error: 3, warn: 4 },
          staleCrons: [
            {
              key: "weekly-scan",
              ageMs: 999999,
              lastHeartbeatAt: "2026-08-20T00:00:00.000Z",
            },
          ],
        },
      }),
    );
    expect(body).toContain(
      "OVERDUE: weekly-scan (last heartbeat 2026-08-20T00:00:00.000Z, 999999 ms ago)",
    );
    expect(body).toContain("Function failures: 1");
    expect(body).toContain("Worker-pool fallbacks: 2");
    expect(body).toContain("Errors: 3, Warnings: 4");
  });
});

describe("buildDigestBody — metric anomalies", () => {
  it("reports none when no anomalies are present (default)", () => {
    const body = buildDigestBody(makeData());
    expect(body).toContain("METRIC ANOMALIES (30d snapshot vs thresholds)");
    expect(body).toContain("None -- all monitored metrics within thresholds");
  });

  it("lists each anomaly line when present", () => {
    const body = buildDigestBody(
      makeData({ anomalies: ["Scan completion rate 60.0% (30d) below 75.0% -- CRITICAL"] }),
    );
    expect(body).toContain("Scan completion rate 60.0% (30d) below 75.0% -- CRITICAL");
    expect(body).not.toContain("None -- all monitored metrics within thresholds");
  });
});

// ---------------------------------------------------------------------------
// evaluateSnapshotMetrics (gc-06e.13, sub-item 3)
// ---------------------------------------------------------------------------

describe("evaluateSnapshotMetrics", () => {
  const healthy = { completionRate: 0.99, scansLast7d: 20, avgFindingsPerScan: 5 };

  it("returns no anomalies when there is no snapshot yet", () => {
    expect(evaluateSnapshotMetrics(null, null)).toEqual({ anomalies: [], critical: [] });
  });

  it("stays quiet when all metrics are within thresholds", () => {
    const result = evaluateSnapshotMetrics(healthy, healthy);
    expect(result.anomalies).toEqual([]);
    expect(result.critical).toEqual([]);
  });

  it("flags a hard breach (critical) when completion rate is below the critical floor", () => {
    const result = evaluateSnapshotMetrics({ ...healthy, completionRate: 0.6 }, healthy);
    expect(result.critical).toHaveLength(1);
    expect(result.critical[0]).toContain("CRITICAL");
    // The critical line is also surfaced in the digest anomaly list.
    expect(result.anomalies).toContain(result.critical[0]);
  });

  it("flags an elevated (warn-only) completion rate without paging", () => {
    // Below the warn floor (0.9) but above the critical floor (0.75).
    const result = evaluateSnapshotMetrics({ ...healthy, completionRate: 0.85 }, healthy);
    expect(result.critical).toEqual([]);
    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]).not.toContain("CRITICAL");
  });

  it("flags a 7d scan-volume drop vs the prior snapshot (warn only)", () => {
    const prior = { ...healthy, scansLast7d: 100 };
    const current = { ...healthy, scansLast7d: 40 }; // < 50% of prior
    const result = evaluateSnapshotMetrics(current, prior);
    expect(result.critical).toEqual([]);
    expect(result.anomalies.some((a) => a.includes("7d scan volume dropped"))).toBe(true);
  });

  it("flags a findings spike vs the prior snapshot (warn only)", () => {
    const prior = { ...healthy, avgFindingsPerScan: 2 };
    const current = { ...healthy, avgFindingsPerScan: 10 }; // > 3x prior
    const result = evaluateSnapshotMetrics(current, prior);
    expect(result.anomalies.some((a) => a.includes("Avg findings/scan spiked"))).toBe(true);
  });

  it("skips trend checks when there is no prior snapshot", () => {
    const current = { completionRate: 0.99, scansLast7d: 1, avgFindingsPerScan: 100 };
    const result = evaluateSnapshotMetrics(current, null);
    expect(result.anomalies).toEqual([]);
  });

  it("exposes conservative default thresholds", () => {
    expect(METRIC_THRESHOLDS.completionRateCriticalFloor).toBe(0.75);
    expect(METRIC_THRESHOLDS.completionRateWarnFloor).toBe(0.9);
  });
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("operatorDigest registration", () => {
  it("exports a defined Inngest function", () => {
    expect(operatorDigest).toBeDefined();
  });
});

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

import {
  buildDigestBody,
  computeMrr,
  computePlanMix,
  computeScanStatusCounts,
  computeScansPerStore,
  countUninstallEventsExcluding,
  DEFAULT_EXCLUDE_SHOPS,
  diffSnapshot,
  operatorDigest,
  parseExcludeShops,
  parseSnapshotMetadata,
  partitionShops,
  sortFindingTypeCounts,
  type DigestSnapshot,
  type OperatorDigestData,
} from "../../inngest/functions/operator-digest";

// ---------------------------------------------------------------------------
// parseExcludeShops
// ---------------------------------------------------------------------------

describe("parseExcludeShops", () => {
  it("falls back to the default when unset", () => {
    expect(parseExcludeShops(undefined)).toEqual(new Set([DEFAULT_EXCLUDE_SHOPS]));
  });

  it("falls back to the default when blank/whitespace-only", () => {
    expect(parseExcludeShops("   ")).toEqual(new Set([DEFAULT_EXCLUDE_SHOPS]));
    expect(parseExcludeShops("")).toEqual(new Set([DEFAULT_EXCLUDE_SHOPS]));
  });

  it("splits a comma-separated list", () => {
    expect(parseExcludeShops("a.myshopify.com,b.myshopify.com")).toEqual(
      new Set(["a.myshopify.com", "b.myshopify.com"]),
    );
  });

  it("trims whitespace and drops empty segments", () => {
    expect(parseExcludeShops(" a.myshopify.com , , b.myshopify.com ")).toEqual(
      new Set(["a.myshopify.com", "b.myshopify.com"]),
    );
  });

  it("lowercases every domain", () => {
    expect(parseExcludeShops("A.MyShopify.com")).toEqual(new Set(["a.myshopify.com"]));
  });
});

// ---------------------------------------------------------------------------
// partitionShops
// ---------------------------------------------------------------------------

describe("partitionShops", () => {
  const windowStart = new Date("2026-08-28T00:00:00Z");
  const excludeSet = new Set(["dev-store.myshopify.com"]);

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
    const result = partitionShops([], excludeSet, windowStart);
    expect(result).toEqual({
      totalActive: 0,
      newIn24h: 0,
      activeShops: [],
      activeShopIds: [],
      domainById: {},
    });
  });
});

// ---------------------------------------------------------------------------
// countUninstallEventsExcluding
// ---------------------------------------------------------------------------

describe("countUninstallEventsExcluding", () => {
  const excludeSet = new Set(["dev-store.myshopify.com"]);

  it("excludes dev-store keys case-insensitively and counts the rest", () => {
    const count = countUninstallEventsExcluding(
      [{ key: "a.myshopify.com" }, { key: "DEV-STORE.myshopify.com" }, { key: "b.myshopify.com" }],
      excludeSet,
    );
    expect(count).toBe(2);
  });

  it("ignores null keys", () => {
    const count = countUninstallEventsExcluding(
      [{ key: null }, { key: "a.myshopify.com" }, { key: null }],
      excludeSet,
    );
    expect(count).toBe(1);
  });

  it("returns 0 for no events", () => {
    expect(countUninstallEventsExcluding([], excludeSet)).toBe(0);
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
  it("sums Standard at 29 and Professional at 49; free contributes nothing", () => {
    expect(computeMrr({ free: 5, Standard: 2, Professional: 3 })).toBe(2 * 29 + 3 * 49);
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
      "SIGNATURE FLYWHEEL (last 24h)",
      "ACTIVATION",
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

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("operatorDigest registration", () => {
  it("exports a defined Inngest function", () => {
    expect(operatorDigest).toBeDefined();
  });
});

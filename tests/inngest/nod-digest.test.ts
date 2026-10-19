/**
 * Tests for inngest/lib/nod-digest.ts (NOD contract v1 loader).
 *
 * The DB is an in-memory fake (tests/fixtures/nod-digest-fixture.ts) whose only
 * methods are findMany and groupBy; any other access is recorded and must stay
 * empty, which proves the loader is read-only.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let fake: FakeDb;

vi.mock("../../app/db.server", () => ({
  default: new Proxy(
    {},
    {
      get: (_t, prop) => (fake.db as Record<string | symbol, unknown>)[prop],
    },
  ),
}));

vi.mock("../../inngest/client", () => ({
  inngest: {
    createFunction: vi.fn(
      (_config: unknown, _trigger: unknown, handler: (...args: unknown[]) => unknown) => ({
        fn: handler,
      }),
    ),
  },
}));

import { buildNodDigest } from "../../inngest/lib/nod-digest";
import { validateDigest } from "../fixtures/nod-contract.js";
import {
  D,
  H,
  NOW,
  SECRET_FILENAME,
  SECRET_PATH,
  SECRET_SNIPPET,
  SECRET_SUGGESTION,
  SHOP_DOMAINS,
  ago,
  makeFakeDb,
  scanDomains,
  shops,
  signatureSubmissions,
  unknownScripts,
  type FakeDb,
  type Row,
} from "../fixtures/nod-digest-fixture";

const iso = (d: Date) => d.toISOString();
const VALUE_KEYS = [
  "apps_cleaned",
  "leftovers_removed",
  "malicious_shops",
  "findings_resolved",
  "scans",
] as const;
const zeroActions = Object.fromEntries(VALUE_KEYS.map((k) => [k, 0]));

// The malicious_shops numbers as the previous query computed them: findings
// filtered THROUGH the scan relation. The loader now looks findings up by
// scanId; this reference proves the result did not change.
async function maliciousViaScanRelation(nonExcludedIds: string[]) {
  const finding = fake.db.finding as {
    findMany: (a: unknown) => Promise<Array<{ scan: { shopId: string; completedAt: Date } }>>;
  };
  const rows = await finding.findMany({
    where: {
      findingType: "MALICIOUS_SCRIPT",
      scan: {
        status: { in: ["COMPLETED", "PARTIAL"] },
        completedAt: { gte: ago(30 * D) },
        shopId: { in: nonExcludedIds },
      },
    },
    select: { scan: { select: { shopId: true, completedAt: true } } },
  });
  const since = (from: Date) =>
    new Set(rows.filter((f) => f.scan.completedAt >= from).map((f) => f.scan.shopId)).size;
  return { d1: since(ago(1 * D)), d7: since(ago(7 * D)), d30: since(ago(30 * D)) };
}
const valueRow = (d: Awaited<ReturnType<typeof buildNodDigest>>, key: string) =>
  d.value.find((v) => v.key === key)!;

// One active, non-excluded shop for window-edge worlds.
const EDGE_SHOP: Row = {
  id: "shop_edge",
  domain: "edge-merchant.myshopify.com",
  plan: "free",
  installedAt: ago(90 * D),
  uninstalledAt: null,
  isInternal: false,
  lastSeenAt: null,
  firstResultsViewedAt: null,
};

beforeEach(() => {
  delete process.env.OPERATOR_EXCLUDE_SHOPS;
  delete process.env.OPERATOR_EXCLUDE_PREFIXES;
  fake = makeFakeDb();
});

describe("buildNodDigest", () => {
  it("emits exactly the contract top-level fields", async () => {
    const d = await buildNodDigest(NOW);
    expect(Object.keys(d).sort()).toEqual(
      [
        "contractVersion",
        "app",
        "generatedAt",
        "lifecycle",
        "installs",
        "revenue",
        "value",
        "engagement",
        "nudges",
        "errors",
        "series",
        "journey",
        "research",
        "merchants",
      ].sort(),
    );
    expect(d.contractVersion).toBe(1);
    expect(d.app).toEqual({ key: "ghostcode", name: "GhostCode", platform: "shopify" });
    expect(d.generatedAt).toBe(NOW.toISOString());
    expect(d.lifecycle).toEqual({ stage: "live" });
  });

  it("counts installs excluding isInternal, app-review- and env-listed stores", async () => {
    const { installs } = await buildNodDigest(NOW);
    expect(installs).toEqual({
      active: 3, // free, Standard, Professional
      installed7d: 1, // shop_free only (internal/review/env stores dropped)
      installed30d: 3, // free, std, gone (gross, like the digest)
      uninstalled7d: 1, // gone; internal + app-review uninstalls dropped
      uninstalled30d: 2, // gone + a long-redacted shop (event only)
      excludedInternal: 3, // internal + app-review + env-listed, still installed
    });
    expect(installs.installed7d).toBeLessThanOrEqual(installs.installed30d);
    expect(installs.uninstalled7d).toBeLessThanOrEqual(installs.uninstalled30d);
  });

  it("honours OPERATOR_EXCLUDE_SHOPS and OPERATOR_EXCLUDE_PREFIXES overrides", async () => {
    process.env.OPERATOR_EXCLUDE_SHOPS = "std-merchant.myshopify.com";
    process.env.OPERATOR_EXCLUDE_PREFIXES = "zzz-";
    const { installs, merchants } = await buildNodDigest(NOW);
    // std excluded by env; env-dev store and app-review- no longer excluded by list/prefix.
    expect(merchants.map((m) => m.id).sort()).toEqual(
      ["shop_envdev", "shop_free", "shop_pro", "shop_review"].sort(),
    );
    expect(installs.active).toBe(4);
  });

  it("computes list-price MRR whose total equals the sum of plans", async () => {
    const { revenue } = await buildNodDigest(NOW);
    expect(revenue.currency).toBe("USD");
    expect(revenue.plans).toEqual([
      { plan: "Free", installs: 1, mrrCents: 0 },
      { plan: "Standard", installs: 1, mrrCents: 900 },
      { plan: "Professional", installs: 1, mrrCents: 2900 },
    ]);
    expect(revenue.mrrCents).toBe(3800);
    expect(revenue.mrrCents).toBe(revenue.plans.reduce((s, p) => s + p.mrrCents, 0));
  });

  it("omits plans with no active installs", async () => {
    fake = makeFakeDb({ shop: [] });
    const { revenue, installs, merchants, value, journey } = await buildNodDigest(NOW);
    expect(installs.active).toBe(0);
    expect(revenue).toEqual({ currency: "USD", mrrCents: 0, plans: [] });
    expect(merchants).toEqual([]);
    for (const v of value) expect(v).toMatchObject({ d1: 0, d7: 0, d30: 0 });
    expect(journey.merchants).toEqual([]);
  });

  it("leads value[] with outcome rows, then scans run", async () => {
    const { value } = await buildNodDigest(NOW);
    expect(value.map((v) => v.key)).toEqual([
      "apps_cleaned",
      "leftovers_removed",
      "malicious_shops",
      "findings_resolved",
      "scans",
    ]);
    for (const v of value) {
      expect(v.d1).toBeLessThanOrEqual(v.d7);
      expect(v.d7).toBeLessThanOrEqual(v.d30);
    }
  });

  it("counts scans for active installs only, over trailing 24h/7d/30d", async () => {
    const d = await buildNodDigest(NOW);
    // free: 2h + 3d ago, std: 15d ago. internal + uninstalled shops' scans dropped;
    // shop_pro's scans are older than 30 days.
    expect(valueRow(d, "scans")).toEqual({
      key: "scans",
      label: "Scans run",
      d1: 1,
      d7: 2,
      d30: 3,
      caveat: "Includes scheduled and theme-publish automatic scans, and failed scans",
    });
  });

  it("counts CLEANED app removals of non-excluded shops, uninstalled ones included", async () => {
    const d = await buildNodDigest(NOW);
    // free 2h (3 items), gone 3d (2, uninstalled not deleted), std 10d (5).
    // Dropped: internal + env-listed shops, REMOVED / REINSTALLED rows, pro's 40d cleanup.
    expect(valueRow(d, "apps_cleaned")).toMatchObject({
      label: "Apps cleaned up",
      d1: 1,
      d7: 2,
      d30: 3,
    });
    expect(valueRow(d, "leftovers_removed")).toMatchObject({
      label: "Leftover items removed",
      d1: 3,
      d7: 5,
      d30: 10,
    });
    // series.value follows value[0]: apps cleaned per UTC day.
    expect(d.series.value.reduce((a, b) => a + b, 0)).toBe(3);
    expect(d.series.value[29]).toBe(1); // ar_free, today
    expect(d.series.value[d.series.days.indexOf(iso(ago(3 * D)).slice(0, 10))]).toBe(1);
  });

  it("counts distinct shops warned about a malicious script on successful scans", async () => {
    const d = await buildNodDigest(NOW);
    // free (two findings, 1h) + gone (5d, uninstalled). Dropped: internal shop,
    // gone's FAILED scan 12h ago, pro's scan 50d ago, non-malicious findings.
    expect(valueRow(d, "malicious_shops")).toMatchObject({
      label: "Shops warned about a malicious script",
      d1: 1,
      d7: 2,
      d30: 2,
    });
  });

  it("sums resolved findings over successful scans completed in the window", async () => {
    const d = await buildNodDigest(NOW);
    // free 1h (2) + 3d (0), gone 5d (1), std 15d (4). Dropped: internal (9),
    // gone's FAILED scan 12h ago (5), pro's 50d scan.
    expect(valueRow(d, "findings_resolved")).toMatchObject({
      label: "Findings resolved",
      d1: 2,
      d7: 3,
      d30: 7,
    });
  });

  it("attaches a one-line caveat of at most 200 characters to every value row", async () => {
    const { value } = await buildNodDigest(NOW);
    const caveats = Object.fromEntries(value.map((v) => [v.key, v.caveat]));
    expect(caveats).toEqual({
      apps_cleaned:
        "Also counts apps whose leftovers a scanner update stopped flagging or the merchant partly ignored; an app cleaned from two themes counts twice",
      leftovers_removed:
        "May include items the merchant ignored rather than removed, or a scanner update stopped flagging; counted once per theme scanned",
      malicious_shops:
        "Detection only: does not confirm the merchant saw it. Includes shops warned again about the same script on a later scan",
      findings_resolved:
        "Also counts findings a scanner update stopped flagging, and a finding that disappears and comes back counts each time it disappears",
      scans: "Includes scheduled and theme-publish automatic scans, and failed scans",
    });
    for (const v of value) {
      expect(v.caveat!.length).toBeGreaterThan(0);
      expect(v.caveat!.length).toBeLessThanOrEqual(200);
      expect(v.caveat).not.toMatch(/[\r\n\u2014]/);
    }
  });

  it("applies inclusive window edges to every outcome row", async () => {
    const edges = [
      ago(1 * D), // in d1
      ago(1 * D + 1), // d7 only
      ago(7 * D), // in d7
      ago(7 * D + 1), // d30 only
      ago(30 * D), // in d30
      ago(30 * D + 1), // outside
    ];
    fake = makeFakeDb({
      shop: [EDGE_SHOP],
      appRemoval: edges.map((at, i) => ({
        id: `ar${i}`,
        shopId: "shop_edge",
        state: "CLEANED",
        stateChangedAt: at,
        leftoverCount: 10,
      })),
      scan: edges.map((at, i) => ({
        id: `sc${i}`,
        shopId: "shop_edge",
        createdAt: ago(60 * D), // windows key on completedAt, not createdAt
        status: "COMPLETED",
        completedAt: at,
        resolvedFindingCount: 1,
      })),
      finding: [
        { id: "f1", scanId: "sc1", findingType: "MALICIOUS_SCRIPT" },
        { id: "f2", scanId: "sc4", findingType: "MALICIOUS_SCRIPT" },
      ],
    });
    const d = await buildNodDigest(NOW);
    expect(valueRow(d, "apps_cleaned")).toMatchObject({ d1: 1, d7: 3, d30: 5 });
    expect(valueRow(d, "leftovers_removed")).toMatchObject({ d1: 10, d7: 30, d30: 50 });
    expect(valueRow(d, "findings_resolved")).toMatchObject({ d1: 1, d7: 3, d30: 5 });
    // sc1 (1d + 1ms) is in d7 not d1; sc4 (30d) is in d30.
    expect(valueRow(d, "malicious_shops")).toMatchObject({ d1: 0, d7: 1, d30: 1 });
    expect(valueRow(d, "scans")).toMatchObject({ d1: 0, d7: 0, d30: 0 });
    expect(d.merchants[0].actions7d).toEqual({
      scans: 0,
      apps_cleaned: 3,
      leftovers_removed: 30,
      malicious_shops: 1,
      findings_resolved: 3,
    });
    expect(d.merchants[0].actions30d).toEqual({
      scans: 0,
      apps_cleaned: 5,
      leftovers_removed: 50,
      malicious_shops: 1,
      findings_resolved: 5,
    });
    expect(valueRow(d, "malicious_shops")).toMatchObject(
      await maliciousViaScanRelation(["shop_edge"]),
    );
    expect(validateDigest(d)).toEqual([]);
  });

  it("derives engagement from page visits + scans of active installs", async () => {
    const { engagement } = await buildNodDigest(NOW);
    // This week: shop_free (visit, scan, lastSeen). Prior week: shop_free, shop_std.
    expect(engagement).toEqual({
      activeMerchants7d: 1,
      returningMerchants7d: 1,
      visits7d: 1, // the internal store's visit is dropped
    });
  });

  it("builds nudge funnels over 30d, excluding internal domains and nudge_not_shown", async () => {
    const { nudges } = await buildNodDigest(NOW);
    expect(nudges).toEqual([
      {
        key: "upgrade_preview",
        label: "Upgrade preview",
        shown: 2,
        clicked: 1,
        dismissed: 0,
        converted: 0,
      },
      { key: "feedback", label: "Feedback ask", shown: 0, clicked: 0, dismissed: 1, converted: 0 },
      { key: "other", label: "Other", shown: 1, clicked: 0, dismissed: 0, converted: 0 },
    ]);
  });

  it("aggregates errors by code with categories, skipping degraded, warn and excluded shops", async () => {
    const { errors } = await buildNodDigest(NOW);
    expect(errors.count7d).toBe(5);
    expect(errors.count24h).toBe(2);
    expect(errors.byCode).toEqual([
      {
        code: "api_graphql_throttled",
        category: "api",
        count24h: 0,
        count7d: 1,
        lastAt: new Date(NOW.getTime() - 2 * 86_400_000).toISOString(),
      },
      {
        // key contained a myshopify domain: replaced, never echoed
        code: "api_unknown",
        category: "api",
        count24h: 0,
        count7d: 1,
        lastAt: new Date(NOW.getTime() - 2 * 86_400_000).toISOString(),
      },
      {
        code: "client_boundary",
        category: "other",
        count24h: 1,
        count7d: 1,
        lastAt: new Date(NOW.getTime() - 5 * 3_600_000).toISOString(),
      },
      {
        code: "job_operator-digest",
        category: "job",
        count24h: 0,
        count7d: 1,
        lastAt: new Date(NOW.getTime() - 3 * 86_400_000).toISOString(),
      },
      {
        code: "webhook_app_uninstalled",
        category: "webhook",
        count24h: 1,
        count7d: 1,
        lastAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
      },
    ]);
  });

  it("returns 30 aligned UTC days, oldest first, ending today", async () => {
    const { series } = await buildNodDigest(NOW);
    expect(series.days).toHaveLength(30);
    expect(series.days[29]).toBe("2026-10-17");
    expect(series.days[0]).toBe("2026-09-18");
    expect([...series.days].sort()).toEqual(series.days);
    for (const k of ["installed", "uninstalled", "value"] as const) {
      expect(series[k]).toHaveLength(30);
    }
    expect(series.installed.reduce((a, b) => a + b, 0)).toBe(3);
    expect(series.uninstalled.reduce((a, b) => a + b, 0)).toBe(2);
  });

  it("emits merchant rows for active installs with Shop.id only", async () => {
    const { merchants } = await buildNodDigest(NOW);
    expect(merchants.map((m) => m.id).sort()).toEqual(["shop_free", "shop_pro", "shop_std"]);
    for (const m of merchants) {
      expect(
        Object.keys(m).every((k) =>
          ["id", "plan", "installedAt", "lastActiveAt", "actions7d", "actions30d"].includes(k),
        ),
      ).toBe(true);
    }
    const free = merchants.find((m) => m.id === "shop_free")!;
    expect(free.plan).toBe("Free");
    // free: sc_free1 (2 resolved, two malicious findings = 1 shop) + sc_free2, ar_free (3).
    const freeActions = {
      scans: 2,
      apps_cleaned: 1,
      leftovers_removed: 3,
      malicious_shops: 1,
      findings_resolved: 2,
    };
    expect(free.actions7d).toEqual(freeActions);
    expect(free.actions30d).toEqual(freeActions);
    const std = merchants.find((m) => m.id === "shop_std")!;
    expect(std.actions7d).toEqual(zeroActions);
    expect(std.actions30d).toEqual({
      scans: 1,
      apps_cleaned: 1,
      leftovers_removed: 5,
      malicious_shops: 0, // f7 is not malicious
      findings_resolved: 4,
    });
    expect(free.lastActiveAt).toBe(new Date(NOW.getTime() - 2 * 3_600_000).toISOString());
    const pro = merchants.find((m) => m.id === "shop_pro")!;
    expect(pro.lastActiveAt).toBeUndefined();
    // pro's cleanup was 40d ago; REMOVED / REINSTALLED rows never count.
    expect(pro.actions30d).toEqual(zeroActions);
  });

  it("gives every merchant exactly the value[] keys, summing to value[] when all shops are active", async () => {
    // Drop the uninstalled shop so the outcome rows and merchants[] cover the same shops.
    fake = makeFakeDb({ shop: shops.filter((s) => s.id !== "shop_gone") });
    const d = await buildNodDigest(NOW);
    const keys = d.value.map((v) => v.key).sort();
    expect(keys).toEqual([...VALUE_KEYS].sort());
    for (const m of d.merchants) {
      expect(Object.keys(m.actions7d).sort()).toEqual(keys);
      expect(Object.keys(m.actions30d).sort()).toEqual(keys);
    }
    for (const v of d.value) {
      const sum = (w: "actions7d" | "actions30d") =>
        d.merchants.reduce((n, m) => n + m[w][v.key], 0);
      expect({ key: v.key, d7: sum("actions7d"), d30: sum("actions30d") }).toEqual({
        key: v.key,
        d7: v.d7,
        d30: v.d30,
      });
    }
    expect(valueRow(d, "malicious_shops").d30).toBe(1); // non-vacuous: shop_free
    expect(validateDigest(d)).toEqual([]);
  });

  it("looks malicious findings up by scanId on the window's successful scans", async () => {
    const d = await buildNodDigest(NOW);
    const findingQueries = fake.findManyArgs.filter((c) => c.model === "finding");
    expect(findingQueries).toHaveLength(1);
    const where = findingQueries[0].args!.where!;
    expect(Object.keys(where).sort()).toEqual(["findingType", "scanId"]);
    expect(where.findingType).toBe("MALICIOUS_SCRIPT");
    // sc_free1, sc_free2, sc_std, sc_gone: successful, in the window, non-excluded.
    expect(((where.scanId as { in: string[] }).in ?? []).sort()).toEqual(
      ["sc_free1", "sc_free2", "sc_gone", "sc_std"].sort(),
    );
    expect(valueRow(d, "malicious_shops")).toMatchObject(
      await maliciousViaScanRelation(["shop_free", "shop_std", "shop_pro", "shop_gone"]),
    );
  });

  it("skips the finding query when the window has no successful scans", async () => {
    fake = makeFakeDb({ shop: [EDGE_SHOP], scan: [] });
    const d = await buildNodDigest(NOW);
    expect(fake.findManyArgs.some((c) => c.model === "finding")).toBe(false);
    expect(valueRow(d, "malicious_shops")).toMatchObject({ d1: 0, d7: 0, d30: 0 });
  });

  it("never leaks a domain, store name or error message anywhere in the payload", async () => {
    const json = JSON.stringify(await buildNodDigest(NOW));
    for (const domain of SHOP_DOMAINS) expect(json).not.toContain(domain);
    expect(json).not.toMatch(/myshopify/i);
    expect(json).not.toMatch(/-merchant|renamed-dev|app-review|nw-dev/i);
    expect(json).not.toContain("boom");
    expect(json).not.toContain("TypeError");
  });

  it("drops function_failure rows attributed to internal or app-review shops", async () => {
    const { errors } = await buildNodDigest(NOW);
    expect(errors.byCode.map((c) => c.code)).not.toContain("job_scan-theme");
  });

  it("produces a payload that passes the NOD contract validator", async () => {
    expect(validateDigest(await buildNodDigest(NOW))).toEqual([]);
  });

  it("is read-only: only findMany and groupBy are ever called on the DB", async () => {
    await buildNodDigest(NOW);
    expect(fake.touched).toEqual([]);
    expect(new Set(fake.findManyCalls)).toEqual(
      new Set([
        "shop",
        "scan",
        "finding",
        "appRemoval",
        "opsEvent",
        "unknownScript",
        "scanDomain",
        "signatureSubmission",
      ]),
    );
    expect(new Set(fake.groupByCalls)).toEqual(
      new Set(["scan", "appRemoval", "unknownScript", "scanDomain"]),
    );
  });
});

describe("buildNodDigest journey", () => {
  it("declares the three stages with first_cleanup as the value stage", async () => {
    const { journey } = await buildNodDigest(NOW);
    expect(journey.stages).toEqual([
      { key: "first_scan", label: "First scan done" },
      { key: "first_results", label: "Saw first results" },
      { key: "first_cleanup", label: "Cleanup confirmed" },
    ]);
    expect(journey.valueStage).toBe("first_cleanup");
  });

  it("emits one row per non-excluded shop with all-time first times", async () => {
    const { journey, merchants } = await buildNodDigest(NOW);
    expect(journey.merchants).toEqual([
      {
        id: "shop_free",
        installedAt: iso(ago(3 * D)),
        plan: "Free",
        reached: {
          first_scan: iso(ago(3 * D - 5 * 60_000)), // earlier of two successful scans
          first_results: iso(ago(2 * D)),
          first_cleanup: iso(ago(2 * H)),
        },
      },
      {
        id: "shop_std",
        installedAt: iso(ago(20 * D)),
        plan: "Standard",
        reached: { first_scan: iso(ago(15 * D)), first_cleanup: iso(ago(10 * D)) },
      },
      {
        // Older than the 30-day window, FAILED scan at 55d ignored.
        id: "shop_pro",
        installedAt: iso(ago(60 * D)),
        plan: "Professional",
        reached: { first_scan: iso(ago(50 * D)), first_cleanup: iso(ago(40 * D)) },
      },
      {
        // Uninstalled but not yet deleted: kept, with uninstalledAt.
        id: "shop_gone",
        installedAt: iso(ago(10 * D)),
        uninstalledAt: iso(ago(2 * D)),
        plan: "Free",
        reached: {
          first_scan: iso(ago(5 * D)),
          first_results: iso(ago(4 * D)),
          first_cleanup: iso(ago(3 * D)),
        },
      },
    ]);
    // Same ids as merchants[] for the active shops.
    for (const m of merchants) expect(journey.merchants.map((j) => j.id)).toContain(m.id);
  });

  it("excludes internal, app-review and env-listed shops", async () => {
    const { journey } = await buildNodDigest(NOW);
    const ids = journey.merchants.map((m) => m.id);
    for (const id of ["shop_internal", "shop_review", "shop_envdev"]) {
      expect(ids).not.toContain(id);
    }
  });

  it("emits an empty reached object for a shop with no milestones", async () => {
    fake = makeFakeDb({ shop: [EDGE_SHOP], scan: [], appRemoval: [], finding: [] });
    const { journey } = await buildNodDigest(NOW);
    expect(journey.merchants).toEqual([
      { id: "shop_edge", installedAt: iso(ago(90 * D)), plan: "Free", reached: {} },
    ]);
  });

  it("never puts a shop domain in journey rows", async () => {
    const json = JSON.stringify((await buildNodDigest(NOW)).journey);
    for (const domain of SHOP_DOMAINS) expect(json).not.toContain(domain);
    expect(json).not.toMatch(/myshopify/i);
  });
});

describe("buildNodDigest research (NOD ADR-011)", () => {
  const research = async () => (await buildNodDigest(NOW)).research!;
  const item = (r: Awaited<ReturnType<typeof research>>, host: string) =>
    r.queue.find((q) => q.host === host);

  it("titles the section and lists the three counts in order", async () => {
    const r = await research();
    expect(r.title).toBe("Signature research");
    expect(r.counts.map((c) => [c.key, c.label])).toEqual([
      ["unknown_script_hosts", "Unknown script hosts"],
      ["unmatched_hosts", "Unmatched hosts"],
      ["pending_suggestions", "Merchant suggestions to review"],
    ]);
  });

  it("counts unknown script hosts: benign filtered, legacy null domain parsed, excluded shops ignored", async () => {
    const r = await research();
    // alpha, beta (legacy), gamma (one store), other-store.myshopify, IP, jota.
    // Not fonts.googleapis.com (benign), not internal-only.delta.dev (internal shop only).
    expect(r.counts[0]).toMatchObject({ open: 6, new7d: 2 }); // new: beta, myshopify host
  });

  it("counts unmatched hosts excluding unknown-script hosts, matched and benign rows", async () => {
    const r = await research();
    // kappa, solo-host.lambda.net, fresh.mu-cdn.com; not cdn.alpha-app.com.
    expect(r.counts[1]).toMatchObject({ open: 3, new7d: 1 }); // new: fresh.mu-cdn.com
  });

  it("counts pending suggestions as an all-time backlog of non-excluded shops", async () => {
    const r = await research();
    // sub1 (1d) + sub3 (20d, outside 7d); sub4 is the internal shop's.
    expect(r.counts[2]).toEqual({
      key: "pending_suggestions",
      label: "Merchant suggestions to review",
      open: 2,
      new7d: 1,
    });
    fake = makeFakeDb({
      signatureSubmission: [
        ...signatureSubmissions,
        { ...signatureSubmissions[0], id: "sub_old", createdAt: ago(200 * D) },
      ],
    });
    expect((await research()).counts[2]).toMatchObject({ open: 3, new7d: 1 });
  });

  it("uses the first sighting ever (any shop, legacy rows included) for new7d and firstSeenAt", async () => {
    const r = await research();
    // jota: window rows are all within 7d, but the internal shop saw it 20d ago.
    expect(item(r, "cdn.jota-app.com")?.firstSeenAt).toBe(iso(ago(20 * D)));
    // alpha: first seen 50d ago, before the window.
    expect(item(r, "cdn.alpha-app.com")?.firstSeenAt).toBe(iso(ago(50 * D)));
    // beta: legacy null-domain rows only, first seen 5d ago.
    expect(item(r, "legacy.beta-tools.io")?.firstSeenAt).toBe(iso(ago(5 * D)));
    // Removing jota's internal sighting makes it new: unknown script new7d goes 2 -> 3.
    fake = makeFakeDb({
      unknownScript: unknownScripts.filter(
        (u) => !(u.scanId === "sc_int_old" && u.domain === "cdn.jota-app.com"),
      ),
    });
    const r2 = await research();
    expect(r2.counts[0]).toMatchObject({ open: 6, new7d: 3 });
    // Removing gamma's 50d-old legacy row makes gamma new too (legacy lookup is used).
    fake = makeFakeDb({
      unknownScript: unknownScripts.filter(
        (u) => !(u.scanId === "sc_pro_old" && String(u.url).includes("solo.gamma-shop.com")),
      ),
    });
    expect((await research()).counts[0]).toMatchObject({ open: 6, new7d: 3 });
  });

  it("queues only hosts at 2+ stores, never myshopify or IP hosts, sorted by shops then sightings then host", async () => {
    const r = await research();
    expect(r.queue).toEqual([
      {
        host: "api.kappa-svc.com",
        kind: "unmatched_host",
        label: "Unmatched host",
        shops: 3,
        sightings: 3,
        firstSeenAt: iso(ago(15 * D)),
        lastSeenAt: iso(ago(2 * H)),
      },
      {
        host: "cdn.alpha-app.com",
        kind: "unknown_script",
        label: "Unknown script",
        shops: 2, // the internal shop's sighting is not counted
        sightings: 3,
        firstSeenAt: iso(ago(50 * D)),
        lastSeenAt: iso(ago(2 * H)),
        suggestions: 2, // sub1 + sub2; internal sub4 ignored
      },
      {
        host: "cdn.jota-app.com",
        kind: "unknown_script",
        label: "Unknown script",
        shops: 2,
        sightings: 2,
        firstSeenAt: iso(ago(20 * D)),
        lastSeenAt: iso(ago(2 * H)),
        suggestions: 0,
      },
      {
        host: "fresh.mu-cdn.com",
        kind: "unmatched_host",
        label: "Unmatched host",
        shops: 2,
        sightings: 2,
        firstSeenAt: iso(ago(5 * D)),
        lastSeenAt: iso(ago(2 * H)),
      },
      {
        host: "legacy.beta-tools.io",
        kind: "unknown_script",
        label: "Unknown script",
        shops: 2,
        sightings: 2,
        firstSeenAt: iso(ago(5 * D)),
        lastSeenAt: iso(ago(2 * H)),
        suggestions: 1, // via a legacy null-domain script row
      },
    ]);
    const hosts = r.queue.map((q) => q.host);
    // One-store hosts are counted but never named.
    expect(hosts).not.toContain("solo.gamma-shop.com");
    expect(hosts).not.toContain("solo-host.lambda.net");
    expect(hosts.some((h) => h.includes("myshopify"))).toBe(false);
    expect(hosts).not.toContain("203.0.113.5");
  });

  it("drops a host below 2 stores when a shop is excluded", async () => {
    process.env.OPERATOR_EXCLUDE_SHOPS = "std-merchant.myshopify.com";
    const r = await research();
    expect(item(r, "cdn.alpha-app.com")).toBeUndefined(); // now free only
    expect(item(r, "api.kappa-svc.com")).toMatchObject({ shops: 2, sightings: 2 });
    // The 203.0.113.5 host is now one store; counts still include alpha.
    expect(r.counts[0].open).toBe(6);
  });

  it("lowercases hosts and merges case variants", async () => {
    fake = makeFakeDb({
      scanDomain: [{ ...scanDomains[0], domain: "API.Kappa-Svc.com" }, ...scanDomains.slice(1)],
    });
    const r = await research();
    expect(item(r, "api.kappa-svc.com")).toMatchObject({ shops: 3, sightings: 3 });
    expect(r.queue.every((q) => q.host === q.host.toLowerCase())).toBe(true);
  });

  it("caps the queue at 25", async () => {
    const many: Row[] = [];
    for (let i = 0; i < 30; i += 1) {
      const host = `cdn.vendor${String(i).padStart(2, "0")}.com`;
      many.push(
        { ...unknownScripts[0], id: `m${i}a`, url: `https://${host}/a.js`, domain: host },
        {
          ...unknownScripts[0],
          id: `m${i}b`,
          scanId: "sc_std",
          url: `https://${host}/a.js`,
          domain: host,
        },
      );
      // Extra sightings so sort order is by sightings for the first few.
      if (i < 3)
        many.push({
          ...unknownScripts[0],
          id: `m${i}c`,
          url: `https://${host}/b.js`,
          domain: host,
        });
    }
    fake = makeFakeDb({ unknownScript: many, scanDomain: [], signatureSubmission: [] });
    const r = await research();
    expect(r.queue).toHaveLength(25);
    expect(r.counts[0].open).toBe(30);
    expect(r.queue.slice(0, 3).map((q) => [q.host, q.sightings])).toEqual([
      ["cdn.vendor00.com", 3],
      ["cdn.vendor01.com", 3],
      ["cdn.vendor02.com", 3],
    ]);
    expect(r.queue[3].host).toBe("cdn.vendor03.com");
    expect(r.queue[24].host).toBe("cdn.vendor24.com");
    expect(validateDigest(await buildNodDigest(NOW))).toEqual([]);
  });

  it("never outputs suggestion text, urls, filenames, snippets or shop identifiers", async () => {
    const d = await buildNodDigest(NOW);
    const json = JSON.stringify(d.research);
    for (const forbidden of [SECRET_SUGGESTION, SECRET_PATH, SECRET_FILENAME, SECRET_SNIPPET]) {
      expect(JSON.stringify(d)).not.toContain(forbidden);
    }
    for (const domain of SHOP_DOMAINS) expect(json).not.toContain(domain);
    for (const s of shops) expect(json).not.toContain(s.id as string);
    expect(json).not.toMatch(/myshopify|https?:|\/\//i);
    for (const q of d.research!.queue) {
      expect(Object.keys(q).sort()).toEqual(
        [
          "host",
          "kind",
          "label",
          "shops",
          "sightings",
          "firstSeenAt",
          "lastSeenAt",
          ...(q.kind === "unknown_script" ? ["suggestions"] : []),
        ].sort(),
      );
    }
    // suggestedAppName is never even selected.
    const subQueries = fake.findManyArgs.filter((c) => c.model === "signatureSubmission");
    expect(subQueries.length).toBeGreaterThan(0);
    for (const c of subQueries)
      expect(JSON.stringify(c.args?.select)).not.toContain("suggestedAppName");
  });

  it("sends zeros and an empty queue when there is nothing to research", async () => {
    fake = makeFakeDb({ unknownScript: [], scanDomain: [], signatureSubmission: [] });
    const d = await buildNodDigest(NOW);
    expect(d.research).toEqual({
      title: "Signature research",
      counts: [
        { key: "unknown_script_hosts", label: "Unknown script hosts", open: 0, new7d: 0 },
        { key: "unmatched_hosts", label: "Unmatched hosts", open: 0, new7d: 0 },
        { key: "pending_suggestions", label: "Merchant suggestions to review", open: 0, new7d: 0 },
      ],
      queue: [],
    });
    expect(validateDigest(d)).toEqual([]);
  });

  it("omits the section, not the digest, when it cannot be computed", async () => {
    const base = makeFakeDb();
    fake = {
      ...base,
      db: new Proxy(base.db, {
        get: (t, prop: string) => {
          if (prop === "unknownScript") throw new Error("db down");
          return (t as Record<string, unknown>)[prop];
        },
      }),
    };
    const d = await buildNodDigest(NOW);
    expect(d.research).toBeUndefined();
    expect(d.value.length).toBe(5);
    expect(validateDigest(d)).toEqual([]);
  });

  it("passes the NOD contract validator with the research section", async () => {
    const d = await buildNodDigest(NOW);
    expect(d.research!.queue.length).toBeGreaterThan(0);
    expect(validateDigest(d)).toEqual([]);
  });
});

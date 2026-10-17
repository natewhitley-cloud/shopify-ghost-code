/**
 * Tests for inngest/lib/nod-digest.ts (NOD contract v1 loader).
 *
 * The DB is an in-memory fake (tests/fixtures/nod-digest-fixture.ts) whose only
 * method is findMany; any other access is recorded and must stay empty, which
 * proves the loader is read-only.
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
import { NOW, makeFakeDb, type FakeDb } from "../fixtures/nod-digest-fixture";

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
    fake = makeFakeDb({ shops: [] });
    const { revenue, installs, merchants, value } = await buildNodDigest(NOW);
    expect(installs.active).toBe(0);
    expect(revenue).toEqual({ currency: "USD", mrrCents: 0, plans: [] });
    expect(merchants).toEqual([]);
    expect(value[0]).toMatchObject({ d1: 0, d7: 0, d30: 0 });
  });

  it("counts scans for active installs only, over trailing 24h/7d/30d", async () => {
    const { value, series } = await buildNodDigest(NOW);
    // free: 2h + 3d ago, std: 15d ago. internal + uninstalled shops' scans dropped.
    expect(value).toEqual([{ key: "scans", label: "Scans run", d1: 1, d7: 2, d30: 3 }]);
    expect(series.value.reduce((a, b) => a + b, 0)).toBe(3);
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
    expect(free.actions7d).toEqual({ scans: 2 });
    expect(free.actions30d).toEqual({ scans: 2 });
    expect(free.lastActiveAt).toBe(new Date(NOW.getTime() - 2 * 3_600_000).toISOString());
    const pro = merchants.find((m) => m.id === "shop_pro")!;
    expect(pro.lastActiveAt).toBeUndefined();
    expect(pro.actions30d).toEqual({ scans: 0 });
  });

  it("never leaks a domain, store name or error message anywhere in the payload", async () => {
    const json = JSON.stringify(await buildNodDigest(NOW));
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

  it("is read-only: only findMany is ever called on the DB", async () => {
    await buildNodDigest(NOW);
    expect(fake.touched).toEqual([]);
    expect(new Set(fake.findManyCalls)).toEqual(new Set(["shop", "scan", "opsEvent"]));
  });
});

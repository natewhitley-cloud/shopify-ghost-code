/**
 * End-to-end orchestration test for the operator-digest HANDLER (gc-zeh).
 *
 * The pure aggregators are unit-tested in operator-digest.test.ts. This file
 * guards the WIRING: the handler must thread the same store exclusion
 * (durable isInternal flag + OPERATOR_EXCLUDE_SHOPS + app-review- prefix, plus
 * active-only scoping) into every step. A step that forgets its filter, or
 * swaps the two type-compatible Set<string> args, silently leaks an internal or
 * dev store back into the digest (the gc-qkd / gc-4cv / gc-9ms bug class).
 *
 * Strategy: the REAL ops-event / billing-event / metric-snapshot models run
 * against an in-memory fake Prisma that APPLIES the `where` clauses the code
 * passes (so a missing filter returns the excluded rows, exactly like the real
 * DB). Excluded shops are seeded with loud, unique markers in every data
 * source; the final email body must contain none of them.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// In-memory fake Prisma
// ---------------------------------------------------------------------------

const tables = vi.hoisted(() => ({
  shop: [] as Record<string, unknown>[],
  scan: [] as Record<string, unknown>[],
  finding: [] as Record<string, unknown>[],
  opsEvent: [] as Record<string, unknown>[],
  unknownScript: [] as Record<string, unknown>[],
  signatureSubmission: [] as Record<string, unknown>[],
  billingEvent: [] as Record<string, unknown>[],
  metricSnapshot: [] as Record<string, unknown>[],
  merchantFeedback: [] as Record<string, unknown>[],
}));

const fakeDb = vi.hoisted(() => {
  type R = Record<string, unknown>;
  // Relation resolvers for the relation filters/selects the digest uses.
  const relations: Record<string, Record<string, (row: R) => R | undefined>> = {
    finding: { scan: (row) => tables.scan.find((s) => s.id === row.scanId) },
    billingEvent: { shop: (row) => tables.shop.find((s) => s.id === row.shopId) },
  };

  function matches(model: string, row: R, where: R | undefined): boolean {
    if (!where) return true;
    return Object.entries(where).every(([field, cond]) => {
      const rel = relations[model]?.[field];
      if (rel) {
        const target = rel(row);
        return target !== undefined && matches(field, target, cond as R);
      }
      const value = row[field];
      if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
        const c = cond as R;
        if ("in" in c && !(c.in as unknown[]).includes(value)) return false;
        if ("notIn" in c && (c.notIn as unknown[]).includes(value)) return false;
        if ("gte" in c && !(value instanceof Date && value >= (c.gte as Date))) return false;
        if ("lt" in c && !(value instanceof Date && value < (c.lt as Date))) return false;
        return true;
      }
      return value === cond;
    });
  }

  function withSelectedRelations(model: string, row: R, select: R | undefined): R {
    if (!select) return row;
    const out: R = { ...row };
    for (const [field, spec] of Object.entries(select)) {
      const rel = relations[model]?.[field];
      if (rel && typeof spec === "object") out[field] = rel(row) ?? null;
    }
    return out;
  }

  function delegate(model: keyof typeof tables) {
    const rows = () => tables[model] as R[];
    return {
      findMany: vi.fn(async (args: R = {}) => {
        let out = rows().filter((r) => matches(model, r, args.where as R));
        if (Array.isArray(args.distinct)) {
          const seen = new Set<string>();
          out = out.filter((r) => {
            const k = (args.distinct as string[]).map((f) => String(r[f])).join("|");
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
        }
        return out.map((r) => withSelectedRelations(model, r, args.select as R));
      }),
      findFirst: vi.fn(async (args: R = {}) => {
        const out = rows()
          .filter((r) => matches(model, r, args.where as R))
          .sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime());
        return out[0] ?? null;
      }),
      count: vi.fn(
        async (args: R = {}) => rows().filter((r) => matches(model, r, args.where as R)).length,
      ),
      groupBy: vi.fn(async (args: R) => {
        const by = (args.by as string[])[0];
        const groups = new Map<unknown, R[]>();
        for (const r of rows().filter((row) => matches(model, row, args.where as R))) {
          groups.set(r[by], [...(groups.get(r[by]) ?? []), r]);
        }
        return [...groups.entries()].map(([key, members]) => ({
          [by]: key,
          _count: { _all: members.length },
          _max: {
            createdAt: members.map((m) => m.createdAt as Date).reduce((a, b) => (a > b ? a : b)),
          },
        }));
      }),
      create: vi.fn(async (args: R) => {
        const row = { id: `new-${rows().length}`, createdAt: new Date(), ...(args.data as R) };
        rows().push(row);
        return row;
      }),
    };
  }

  return {
    shop: delegate("shop"),
    scan: delegate("scan"),
    finding: delegate("finding"),
    opsEvent: delegate("opsEvent"),
    unknownScript: delegate("unknownScript"),
    signatureSubmission: delegate("signatureSubmission"),
    billingEvent: delegate("billingEvent"),
    metricSnapshot: delegate("metricSnapshot"),
    merchantFeedback: delegate("merchantFeedback"),
  };
});

vi.mock("../../app/db.server", () => ({ default: fakeDb }));

const mockSendOpsAlert = vi.hoisted(() => vi.fn());
vi.mock("../../app/services/ops-alert.server", () => ({
  sendOpsAlert: mockSendOpsAlert,
  getOpsAlertConfigStatus: () => ({ configured: true, reason: "ok" }),
}));

vi.mock("../../app/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { operatorDigest } from "../../inngest/functions/operator-digest";
import { createMockInngestStep, getInngestHandler } from "../mocks/inngest";

// ---------------------------------------------------------------------------
// Seed: 2 real active installs, 1 churned real shop, and 3 excluded stores
// (one per exclusion mechanism) seeded into EVERY data source.
// ---------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000;

/** Excluded stores and the unique marker each carries in every data source. */
const EXCLUDED = [
  { id: "shop-internal", domain: "renamed-internal.myshopify.com", isInternal: true }, // durable flag
  { id: "shop-envdev", domain: "leaky-dev.myshopify.com", isInternal: false }, // OPERATOR_EXCLUDE_SHOPS
  { id: "shop-review", domain: "app-review-zz9.myshopify.com", isInternal: false }, // prefix
];

/** Nullable Shop stamp columns, null as the real DB returns them (gc-dpm.3). */
const NULL_STAMPS = {
  firstOpenedAt: null,
  firstResultsViewedAt: null,
  upgradePreviewShownAt: null,
  upgradePreviewClickedAt: null,
  upgradePreviewConvertedAt: null,
  feedbackNudgeShownAt: null,
  feedbackNudgeClickedAt: null,
  feedbackNudgeDismissedAt: null,
  feedbackSubmittedAt: null,
};

function seed() {
  const now = Date.now();
  const ago = (ms: number) => new Date(now - ms);
  for (const t of Object.values(tables)) t.length = 0;

  tables.shop.push(
    {
      ...NULL_STAMPS,
      id: "shop-a",
      domain: "real-a.myshopify.com",
      plan: "free",
      installedAt: ago(2 * HOUR),
      uninstalledAt: null,
      isInternal: false,
      lastSeenAt: ago(1 * HOUR),
    },
    {
      ...NULL_STAMPS,
      id: "shop-b",
      domain: "real-b.myshopify.com",
      plan: "Professional",
      installedAt: ago(240 * HOUR),
      uninstalledAt: null,
      isInternal: false,
      lastSeenAt: null,
    },
    {
      ...NULL_STAMPS,
      id: "shop-internal-2",
      domain: "renamed-internal-2.myshopify.com",
      plan: "free",
      installedAt: ago(500 * HOUR),
      uninstalledAt: ago(3 * HOUR),
      isInternal: true,
      lastSeenAt: null,
    },
    {
      ...NULL_STAMPS,
      id: "shop-churned",
      domain: "churned-real.myshopify.com",
      plan: "free",
      installedAt: ago(500 * HOUR),
      uninstalledAt: ago(5 * HOUR),
      isInternal: false,
      lastSeenAt: null,
    },
    ...EXCLUDED.map((s) => ({
      ...NULL_STAMPS,
      ...s,
      plan: "Professional", // would inflate MRR if leaked
      installedAt: ago(2 * HOUR), // would inflate "New in 24h" if leaked
      uninstalledAt: null,
      lastSeenAt: ago(1 * HOUR), // would inflate "Seen in last 24h" if leaked
    })),
  );

  // Scans in-window: one real (7 findings), one churned-real, and one per excluded
  // store (999 findings each, of a type ONLY excluded stores have).
  tables.scan.push(
    {
      id: "scan-a",
      shopId: "shop-a",
      status: "COMPLETED",
      findingCount: 7,
      newFindingCount: 7,
      resolvedFindingCount: 0,
      createdAt: ago(HOUR),
    },
    {
      id: "scan-churned",
      shopId: "shop-churned",
      status: "FAILED",
      findingCount: 999,
      newFindingCount: 0,
      resolvedFindingCount: 0,
      createdAt: ago(HOUR),
    },
    ...EXCLUDED.map((s) => ({
      id: `scan-${s.id}`,
      shopId: s.id,
      status: "FAILED",
      findingCount: 999,
      newFindingCount: 999,
      resolvedFindingCount: 999,
      createdAt: ago(HOUR),
    })),
  );
  tables.finding.push(
    { id: "f-a", scanId: "scan-a", findingType: "GHOST_OG" },
    { id: "f-churned", scanId: "scan-churned", findingType: "GHOST_PIXEL" },
    ...EXCLUDED.map((s) => ({
      id: `f-${s.id}`,
      scanId: `scan-${s.id}`,
      findingType: "GHOST_PIXEL",
    })),
  );

  tables.opsEvent.push(
    // Uninstalls: 1 real, 2 excluded.
    {
      id: "u1",
      eventType: "shop_uninstalled",
      key: "churned-real.myshopify.com",
      createdAt: ago(5 * HOUR),
    },
    {
      id: "u2",
      eventType: "shop_uninstalled",
      key: "leaky-dev.myshopify.com",
      createdAt: ago(3 * HOUR),
    },
    {
      id: "u3",
      eventType: "shop_uninstalled",
      key: "app-review-old1.myshopify.com",
      createdAt: ago(3 * HOUR),
    },
    // A store excluded ONLY by its durable isInternal flag (row still present,
    // pending the 48h shop/redact) must not count as a real uninstall either.
    {
      id: "u4",
      eventType: "shop_uninstalled",
      key: "renamed-internal-2.myshopify.com",
      createdAt: ago(3 * HOUR),
    },
    // Page visits: real /app x2, excluded stores on a unique leak path.
    {
      id: "v1",
      eventType: "page_visit",
      key: "real-a.myshopify.com",
      metadata: { path: "/app" },
      createdAt: ago(HOUR),
    },
    {
      id: "v2",
      eventType: "page_visit",
      key: "real-a.myshopify.com",
      metadata: { path: "/app" },
      createdAt: ago(HOUR),
    },
    ...EXCLUDED.map((s, i) => ({
      id: `vx${i}`,
      eventType: "page_visit",
      key: s.domain,
      metadata: { path: "/app/excluded-leak-path" },
      createdAt: ago(HOUR),
    })),
    // Nudge funnel (gc-97k.1): real shops' events, plus a shown + converted
    // for EVERY excluded store (incl. the isInternal-only uninstalled one) that
    // would visibly inflate the counts if the domain pinning leaked.
    {
      id: "n1",
      eventType: "nudge_shown",
      key: "real-a.myshopify.com",
      metadata: { nudgeKey: "upgrade_preview" },
      createdAt: ago(HOUR),
    },
    {
      id: "n2",
      eventType: "nudge_clicked",
      key: "real-a.myshopify.com",
      metadata: { nudgeKey: "upgrade_preview" },
      createdAt: ago(HOUR),
    },
    {
      id: "n3",
      eventType: "nudge_shown",
      key: "real-b.myshopify.com",
      metadata: { nudgeKey: "upgrade_preview" },
      createdAt: ago(30 * HOUR), // 7d only
    },
    {
      // A churned-but-real shop still counts in its nudge funnel.
      id: "n4",
      eventType: "nudge_shown",
      key: "churned-real.myshopify.com",
      metadata: { nudgeKey: "feedback" },
      createdAt: ago(5 * HOUR),
    },
    {
      // Older than the 7d window: never counted.
      id: "n5",
      eventType: "nudge_converted",
      key: "real-a.myshopify.com",
      metadata: { nudgeKey: "upgrade_preview" },
      createdAt: ago(8 * 24 * HOUR),
    },
    ...[...EXCLUDED.map((s) => s.domain), "renamed-internal-2.myshopify.com"].flatMap(
      (domain, i) => [
        {
          id: `nx-shown-${i}`,
          eventType: "nudge_shown",
          key: domain,
          metadata: { nudgeKey: "upgrade_preview" },
          createdAt: ago(HOUR),
        },
        {
          id: `nx-conv-${i}`,
          eventType: "nudge_converted",
          key: domain,
          metadata: { nudgeKey: "excluded-only-nudge" },
          createdAt: ago(HOUR),
        },
      ],
    ),
    {
      id: "r1",
      eventType: "reconcile_summary",
      key: "reconcile-installs",
      metadata: { checked: 2, marked: 0, skipped: 0 },
      createdAt: ago(2 * HOUR),
    },
  );

  // Merchant feedback (gc-97k.3): real + churned-real rows, one too old, and a
  // CSAT-1 row with an email and WTP answer for EVERY excluded store (incl. the
  // isInternal-only uninstalled one) that would skew every line if it leaked.
  tables.merchantFeedback.push(
    {
      id: "f1",
      shopId: "shop-a",
      csat: 5,
      contactEmail: "owner@real-a.test",
      wtp: null,
      createdAt: ago(HOUR),
    },
    {
      id: "f2",
      shopId: "shop-b",
      csat: 2,
      contactEmail: null,
      wtp: "Reports",
      createdAt: ago(30 * HOUR),
    },
    {
      id: "f3",
      shopId: "shop-churned",
      csat: 4,
      contactEmail: null,
      wtp: null,
      createdAt: ago(5 * HOUR),
    },
    {
      id: "f4",
      shopId: "shop-a",
      csat: 1,
      contactEmail: null,
      wtp: null,
      createdAt: ago(8 * 24 * HOUR),
    },
    ...[...EXCLUDED.map((s) => s.id), "shop-internal-2"].map((shopId, i) => ({
      id: `fx${i}`,
      shopId,
      csat: 1,
      contactEmail: "leak@excluded.test",
      wtp: "excluded-wtp",
      createdAt: ago(HOUR),
    })),
  );

  // Billing: 1 real downgrade; each excluded store has a reactivation.
  tables.billingEvent.push(
    { id: "b1", shopId: "shop-b", eventType: "downgrade", createdAt: ago(HOUR) },
    ...EXCLUDED.map((s, i) => ({
      id: `bx${i}`,
      shopId: s.id,
      eventType: "reactivation",
      createdAt: ago(HOUR),
    })),
  );
}

async function runDigest(): Promise<string> {
  const step = createMockInngestStep();
  await getInngestHandler(operatorDigest)({ step });
  expect(mockSendOpsAlert).toHaveBeenCalled();
  return mockSendOpsAlert.mock.calls[0][1] as string;
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  mockSendOpsAlert.mockResolvedValue({ sent: true });
  process.env.OPERATOR_EXCLUDE_SHOPS = "leaky-dev.myshopify.com";
  delete process.env.OPERATOR_EXCLUDE_PREFIXES; // default: app-review-
  seed();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("operator-digest handler: exclusion wiring end-to-end (gc-zeh)", () => {
  it("never mentions an excluded store, or any excluded-only marker, anywhere in the body", async () => {
    const body = await runDigest();

    for (const s of EXCLUDED) expect(body).not.toContain(s.domain);
    expect(body).not.toContain("app-review-old1");
    expect(body).not.toContain("renamed-internal-2");
    expect(body).not.toContain("excluded-leak-path");
    expect(body).not.toContain("GHOST_PIXEL"); // only excluded/churned findings
    expect(body).not.toContain("999");
  });

  it("counts only real active installs in BUSINESS, PLAN MIX and MRR", async () => {
    const body = await runDigest();

    expect(body).toContain("Total active: 2");
    expect(body).toContain("New in 24h: 1");
    expect(body).toContain("Uninstalls in 24h: 1");
    expect(body).toMatch(/Professional: 1\b/);
    expect(body).toMatch(/free: 1\b/);
  });

  it("scopes scans, findings, billing, activation and activity to real active installs", async () => {
    const body = await runDigest();

    expect(body).toContain("1 completed, 0 partial, 0 failed");
    expect(body).toContain("real-a.myshopify.com -- 1");
    expect(body).toContain("GHOST_OG -- 1");
    expect(body).toContain("0 upgrade, 1 downgrade, 0 cancellation, 0 reactivation");
    expect(body).toContain("Activated (>= 1 scan ever): 1 of 2");
    expect(body).toContain("Seen in last 24h: 1 of 2");
  });

  it("counts nudge funnel events from real (incl. churned) shops only, never excluded stores (gc-97k.1)", async () => {
    const body = await runDigest();

    const start = body.indexOf("NUDGES (funnel per nudge, 24h / 7d)");
    const section = body.slice(start, body.indexOf("\n\n", start));
    expect(section).toBe(
      [
        "NUDGES (funnel per nudge, 24h / 7d)",
        "  counts per stage; each merchant counted once per stage, on the day it happened",
        "  upgrade_preview",
        "    shown 1 / 2 | clicked 1 / 1 | dismissed 0 / 0 | converted 0 / 0",
        "  feedback",
        "    shown 1 / 1 | clicked 0 / 0 | dismissed 0 / 0 | converted 0 / 0",
      ].join("\n"),
    );
    // The excluded stores' converted events used an unknown key; had they leaked
    // they would surface as an "other" row.
    expect(section).not.toContain("other");
  });

  it("renders the nudge empty state when there are no nudge events", async () => {
    tables.opsEvent = tables.opsEvent.filter((e) => !String(e.eventType).startsWith("nudge_"));

    const body = await runDigest();

    expect(body).toContain("NUDGES (funnel per nudge, 24h / 7d)\n  No nudge events in the last 7d");
  });

  it("counts feedback from real (incl. churned) shops only, never excluded stores (gc-97k.3)", async () => {
    const body = await runDigest();

    const header = "FEEDBACK (merchant survey submissions, 24h / 7d)";
    const start = body.indexOf(header);
    expect(body.slice(start, body.indexOf("\n\n", start))).toBe(
      [
        header,
        "  Submissions: 2 / 3",
        "  CSAT (7d): 1:0  2:1  3:0  4:1  5:1 | avg 3.7/5",
        "  With follow-up email (7d): 1 | With WTP answer (7d): 1",
      ].join("\n"),
    );
  });

  it("renders the feedback empty state when there are no submissions", async () => {
    tables.merchantFeedback.length = 0;

    const body = await runDigest();

    expect(body).toContain(
      "FEEDBACK (merchant survey submissions, 24h / 7d)\n  No feedback submissions in the last 7d",
    );
  });

  it("writes today's plan-mix snapshot from real installs only", async () => {
    await runDigest();

    const snapshot = tables.opsEvent.find((e) => e.eventType === "digest_snapshot");
    expect(snapshot?.metadata).toMatchObject({
      planMix: { free: 1, Standard: 0, Professional: 1 },
    });
  });

  it("renders the reconciler last-run section from the real summary row", async () => {
    const body = await runDigest();

    expect(body).toContain("checked 2, marked uninstalled 0, skipped-transient 0");
  });
});

describe("operator-digest handler: JOURNEY section wiring (gc-dpm.3)", () => {
  const section = (body: string) => {
    const start = body.indexOf("JOURNEY (active installs, counted ever)");
    return body.slice(start, body.indexOf("\n\n", start));
  };

  it("counts the funnel over the same real active installs as BUSINESS, never excluded stores", async () => {
    const body = await runDigest();

    // real-a: opened (lastSeenAt) + a COMPLETED scan; real-b: Professional,
    // never seen and no scans. The 3 excluded active stores (all Professional,
    // seen 1h ago) would inflate every stage if they leaked.
    expect(section(body)).toContain(
      "  Funnel: Installed 2 > Opened 1 > Scanned 1 > Viewed results 0 > Saw upgrade 0 > Clicked 0 > Paid 1",
    );
    expect(body).toContain("Total active: 2");
  });

  it("lists only real shops seen or installed in the last 7d in the timeline", async () => {
    const body = await runDigest();
    const lines = section(body).split("\n");

    const i = lines.findIndex((l) => l.startsWith("    real-a.myshopify.com ["));
    expect(lines[i]).toBe("    real-a.myshopify.com [opened, scanned -> stage: scanned]");
    expect(lines[i + 1]).toMatch(
      /^ {6}\d\d-\d\d \d\d:\d\d installed > (\d\d-\d\d )?\d\d:\d\d scan COMPLETED \(7\) > last seen (\d\d-\d\d )?\d\d:\d\d$/,
    );
    // real-b (installed 10d ago, never seen) and churned-real (installed 21d
    // ago) are outside the 7d window; excluded stores never appear at all.
    expect(section(body)).not.toContain("real-b.myshopify.com");
    expect(section(body)).not.toContain("churned-real.myshopify.com");
    for (const s of EXCLUDED) expect(section(body)).not.toContain(s.domain);
  });

  it("renders the uninstall and inferred reinstall for a real shop that came back", async () => {
    const now = Date.now();
    tables.shop.push({
      ...NULL_STAMPS,
      id: "shop-back",
      domain: "came-back.myshopify.com",
      plan: "free",
      installedAt: new Date(now - 6 * HOUR),
      uninstalledAt: null,
      isInternal: false,
      lastSeenAt: new Date(now - 2 * HOUR),
      firstOpenedAt: new Date(now - 6 * HOUR),
    });
    tables.opsEvent.push(
      {
        id: "u-back",
        eventType: "shop_uninstalled",
        key: "came-back.myshopify.com",
        createdAt: new Date(now - 5 * HOUR),
      },
      {
        id: "v-back",
        eventType: "page_visit",
        key: "came-back.myshopify.com",
        metadata: { path: "/app" },
        createdAt: new Date(now - 4 * HOUR),
      },
    );

    const body = await runDigest();
    const lines = section(body).split("\n");
    const i = lines.findIndex((l) => l.startsWith("    came-back.myshopify.com ["));

    expect(lines[i]).toBe("    came-back.myshopify.com [opened -> stage: opened, no scan]");
    expect(lines[i + 1]).toMatch(/installed > .*uninstalled > .*reinstalled > last seen/);
    expect(section(body)).toContain("  Funnel: Installed 3 > Opened 2 >");
  });
});

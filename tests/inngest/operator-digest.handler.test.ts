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
      if (field === "OR") return (cond as R[]).some((c) => matches(model, row, c));
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
        if (args.orderBy !== undefined) {
          const [[field, dir]] = Object.entries(args.orderBy as R);
          const sign = dir === "desc" ? -1 : 1;
          out = [...out].sort(
            (a, b) => sign * ((a[field] as Date).getTime() - (b[field] as Date).getTime()),
          );
        }
        if (typeof args.take === "number") out = out.slice(0, args.take);
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
          // Earliest non-null value per requested field, like SQL MIN (nulls ignored).
          _min: Object.fromEntries(
            Object.keys((args._min as R | undefined) ?? {}).map((field) => [
              field,
              members
                .map((m) => m[field])
                .filter((v): v is Date => v instanceof Date)
                .reduce<Date | null>((a, b) => (a === null || b < a ? b : a), null),
            ]),
          ),
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
  upgradeReturnShownAt: null,
  upgradeReturnClickedAt: null,
  upgradeReturnDismissedAt: null,
  upgradeReturnConvertedAt: null,
  staleResultsShownAt: null,
  staleResultsClickedAt: null,
  staleResultsConvertedAt: null,
  reviewPopupRequestedAt: null,
  reviewPopupLastResult: null,
  reviewPopupLastAttemptAt: null,
  reviewPopupAttemptCount: 0,
  feedbackNudgeShownAt: null,
  feedbackNudgeClickedAt: null,
  feedbackNudgeDismissedAt: null,
  feedbackSubmittedAt: null,
};

function finding(id: string, scanId: string, findingType: string, codeSnippet = `<x id="${id}">`) {
  return { id, scanId, findingType, filename: "snippets/x.liquid", codeSnippet, lineNumber: 1 };
}

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
      themeId: "theme-a",
      skippedCategories: [],
      cappedCategories: [],
      unreachableCategories: [],
      status: "COMPLETED",
      findingCount: 7,
      newFindingCount: 7,
      resolvedFindingCount: 0,
      createdAt: ago(HOUR),
      completedAt: ago(HOUR),
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
    finding("f-a", "scan-a", "GHOST_OG"),
    finding("f-churned", "scan-churned", "GHOST_PIXEL"),
    ...EXCLUDED.map((s) => finding(`f-${s.id}`, `scan-${s.id}`, "GHOST_PIXEL")),
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
        "  one upgrade counts as converted under EACH ask the merchant was shown (upgrade_preview, upgrade_return, stale_results); do not add them together",
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

  it("counts client_error rows from real (incl. churned) shops only, never excluded stores (gc-nn6)", async () => {
    const ago = (ms: number) => new Date(Date.now() - ms);
    tables.opsEvent.push(
      {
        id: "ce1",
        eventType: "client_error",
        key: "real-a.myshopify.com",
        message: "GET /app.data -> 502",
        createdAt: ago(HOUR),
      },
      {
        id: "ce2",
        eventType: "client_error",
        key: "real-a.myshopify.com",
        message: "GET /app.data -> 502",
        createdAt: ago(2 * HOUR),
      },
      {
        // The churned-but-real shop is exactly who this signal is for.
        id: "ce3",
        eventType: "client_error",
        key: "churned-real.myshopify.com",
        message: "x is undefined",
        createdAt: ago(5 * HOUR),
      },
      {
        // Outside the 24h window.
        id: "ce4",
        eventType: "client_error",
        key: "real-a.myshopify.com",
        message: "too old",
        createdAt: ago(30 * HOUR),
      },
      // Three rows per excluded store (incl. the isInternal-only uninstalled
      // one): enough to take the "top" slot and inflate both counts if leaked.
      ...[...EXCLUDED.map((s) => s.domain), "renamed-internal-2.myshopify.com"].flatMap(
        (domain, i) =>
          [0, 1, 2].map((j) => ({
            id: `cex-${i}-${j}`,
            eventType: "client_error",
            key: domain,
            message: "excluded-client-leak",
            createdAt: ago(HOUR),
          })),
      ),
    );

    const body = await runDigest();

    expect(body).toContain('  Client errors: 3 (shops: 2; top: "GET /app.data -> 502" x2)');
    expect(body).not.toContain("excluded-client-leak");
    expect(body).not.toContain("too old");
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
      "  Funnel: Installed 2 > Opened 1 > Scanned 1 > Viewed results 0 of 1 measurable > Saw upgrade 0 > Clicked 0 > Paid 1",
    );
    expect(body).toContain("Total active: 2");
  });

  it("measures Viewed results from each shop's FIRST SUCCESSFUL scan, in one bounded query", async () => {
    const now = Date.now();
    const realShop = (id: string, viewedAt: Date | null) => ({
      ...NULL_STAMPS,
      id,
      domain: `${id}.myshopify.com`,
      plan: "free",
      installedAt: new Date("2026-09-01T00:00:00Z"),
      uninstalledAt: null,
      isInternal: false,
      lastSeenAt: null,
      firstResultsViewedAt: viewedAt,
    });
    const scanRow = (id: string, shopId: string, status: string, at: Date) => ({
      id,
      shopId,
      status,
      findingCount: 1,
      newFindingCount: 1,
      resolvedFindingCount: 0,
      createdAt: at,
      // FAILED is terminal too, so it carries completedAt like the real model.
      completedAt: at,
    });
    // fail-then-ok: its FIRST scan failed before tracking began, its first
    // SUCCESS came after, so it IS measurable (and viewed). pre-tracking: its
    // first success predates tracking, so its view stamp is left out.
    tables.shop.push(
      realShop("fail-then-ok", new Date(now - HOUR)),
      realShop("pre-tracking", new Date(now - HOUR)),
    );
    tables.scan.push(
      scanRow("s1", "fail-then-ok", "FAILED", new Date("2026-09-10T00:00:00Z")),
      scanRow("s2", "fail-then-ok", "COMPLETED", new Date("2026-09-25T00:00:00Z")),
      scanRow("s3", "pre-tracking", "COMPLETED", new Date("2026-09-15T00:00:00Z")),
      scanRow("s4", "pre-tracking", "COMPLETED", new Date("2026-09-30T00:00:00Z")),
    );

    const body = await runDigest();

    // real-a (first success 1h ago, not viewed) + fail-then-ok are measurable.
    expect(section(body)).toContain(
      "Scanned 3 > Viewed results 1 of 2 measurable (1 first scanned before tracking began) >",
    );
    const firstSuccessReads = (
      fakeDb.scan.groupBy.mock.calls as Array<[Record<string, unknown>]>
    ).filter(([args]) => (args._min as Record<string, unknown> | undefined)?.completedAt);
    expect(firstSuccessReads).toHaveLength(1);
    expect(firstSuccessReads[0][0]).toMatchObject({
      by: ["shopId"],
      where: { status: { in: ["COMPLETED", "PARTIAL"] } },
    });
  });

  it("lists only real shops seen, installed or uninstalled in the last 7d in the timeline", async () => {
    const body = await runDigest();
    const lines = section(body).split("\n");

    const i = lines.findIndex((l) => l.startsWith("    real-a.myshopify.com ["));
    expect(lines[i]).toBe("    real-a.myshopify.com [opened, scanned -> stage: scanned]");
    expect(lines[i + 1]).toMatch(
      /^ {6}\d\d-\d\d \d\d:\d\d installed > (\d\d-\d\d )?\d\d:\d\d scan COMPLETED \(7\) > last seen (\d\d-\d\d )?\d\d:\d\d$/,
    );
    // real-b (installed 10d ago, never seen) is outside the 7d window.
    // Changed on purpose (audit 2 #6): churned-real (installed 21d ago, never
    // seen) uninstalled 5h ago, so it now IS in the timeline. Excluded stores
    // never appear at all.
    expect(section(body)).not.toContain("real-b.myshopify.com");
    expect(section(body)).toContain(
      "    churned-real.myshopify.com [opened -> stage: opened, no scan; currently uninstalled]",
    );
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

  it("reads each timeline shop's scans BOUNDED (latest TIMELINE_EVENTS_LIMIT, newest first) with an exact earlier count", async () => {
    const now = Date.now();
    tables.shop.push({
      ...NULL_STAMPS,
      id: "shop-busy",
      domain: "busy.myshopify.com",
      plan: "free",
      installedAt: new Date(now - 3 * HOUR),
      uninstalledAt: null,
      isInternal: false,
      lastSeenAt: new Date(now - 1 * HOUR),
    });
    for (let i = 0; i < 25; i++) {
      tables.scan.push({
        id: `busy-scan-${i}`,
        shopId: "shop-busy",
        status: "FAILED",
        findingCount: 0,
        createdAt: new Date(now - 2 * HOUR + i * 60_000),
      });
    }

    const body = await runDigest();

    const scanReads = (fakeDb.scan.findMany.mock.calls as Array<[Record<string, unknown>]>).filter(
      ([args]) => (args.where as Record<string, unknown>)?.shopId === "shop-busy",
    );
    expect(scanReads).toHaveLength(1);
    expect(scanReads[0][0]).toMatchObject({ orderBy: { createdAt: "desc" }, take: 8 });
    const lines = section(body).split("\n");
    const i = lines.findIndex((l) => l.startsWith("    busy.myshopify.com ["));
    // 25 scans + installed + last seen = 27 events; 8 shown, 19 earlier.
    expect(lines[i + 1]).toMatch(/^ {6}\(19 earlier\) > /);
  });

  it("includes a real shop that uninstalled in the last 7 days though it was not seen this week", async () => {
    const now = Date.now();
    tables.shop.push({
      ...NULL_STAMPS,
      id: "shop-left",
      domain: "left-recently.myshopify.com",
      plan: "free",
      installedAt: new Date(now - 60 * 24 * HOUR),
      uninstalledAt: new Date(now - 2 * 24 * HOUR),
      isInternal: false,
      lastSeenAt: new Date(now - 30 * 24 * HOUR),
    });
    tables.opsEvent.push({
      id: "u-left",
      eventType: "shop_uninstalled",
      key: "left-recently.myshopify.com",
      createdAt: new Date(now - 2 * 24 * HOUR),
    });

    const body = await runDigest();

    expect(section(body)).toContain(
      "    left-recently.myshopify.com [opened -> stage: opened, no scan; currently uninstalled]",
    );
  });
});

describe("operator-digest handler: webhook failures split (gc-4hk follow-up)", () => {
  it("counts only real webhook failures, reporting degraded-but-handled rows separately", async () => {
    const now = Date.now();
    tables.opsEvent.push(
      {
        id: "wf-real-1",
        eventType: "webhook_failure",
        key: "orders/create",
        metadata: { shop: "a.myshopify.com" },
        createdAt: new Date(now - 2 * HOUR),
      },
      {
        id: "wf-real-2",
        eventType: "webhook_failure",
        key: "app/uninstalled",
        metadata: { shop: "b.myshopify.com" },
        createdAt: new Date(now - 3 * HOUR),
      },
      {
        id: "wf-degraded",
        eventType: "webhook_failure",
        key: "themes/publish",
        metadata: { shop: "a.myshopify.com", degraded: true, reason: "offline_session" },
        createdAt: new Date(now - 1 * HOUR),
      },
      // Outside the 24h window: must not be counted either way.
      {
        id: "wf-old",
        eventType: "webhook_failure",
        key: "themes/publish",
        metadata: { shop: "a.myshopify.com", degraded: true, reason: "offline_session" },
        createdAt: new Date(now - 30 * HOUR),
      },
    );

    const body = await runDigest();

    expect(body).toContain("  Webhook failures: 2 (degraded but handled: 1)");
  });
});

describe("operator-digest handler: unique findings, resolution breakdown, distinct unknown scripts", () => {
  const ago = (ms: number) => new Date(Date.now() - ms);
  const scan = (over: Record<string, unknown>) => ({
    shopId: "shop-a",
    themeId: "theme-a",
    status: "COMPLETED",
    findingCount: 0,
    newFindingCount: 0,
    resolvedFindingCount: 0,
    skippedCategories: [],
    cappedCategories: [],
    unreachableCategories: [],
    ...over,
  });
  const section = (body: string, header: string) => {
    const start = body.indexOf(header);
    return body.slice(start, body.indexOf("\n\n", start));
  };

  beforeEach(() => {
    // Replace the seed's single real scan with a paw-naturals-shaped history.
    tables.scan = tables.scan.filter((s) => s.shopId !== "shop-a");
    tables.finding = tables.finding.filter((f) => f.scanId !== "scan-a");
    tables.scan.push(
      // Before the window: metafields not yet checked (scope missing).
      scan({
        id: "s-old",
        createdAt: ago(30 * HOUR),
        skippedCategories: ["GHOST_METAFIELD", "GHOST_TRANSLATION"],
      }),
      // Metafields checked for the first time: 2 of its 3 new findings are metafields.
      scan({
        id: "s1",
        createdAt: ago(10 * HOUR),
        skippedCategories: ["GHOST_TRANSLATION"],
        newFindingCount: 3,
        resolvedFindingCount: 1,
      }),
      // First scan of a duplicated theme: its 1 finding is the same as theme-a's.
      scan({ id: "s2", themeId: "theme-copy", createdAt: ago(5 * HOUR), newFindingCount: 1 }),
      // Latest theme-a scan: the merchant fixed 2.
      scan({
        id: "s3",
        createdAt: ago(2 * HOUR),
        skippedCategories: ["GHOST_TRANSLATION"],
        resolvedFindingCount: 2,
      }),
      // A failed scan never counts.
      scan({ id: "s-failed", status: "FAILED", createdAt: ago(1 * HOUR), newFindingCount: 50 }),
    );
    tables.finding.push(
      finding("s1-m1", "s1", "GHOST_METAFIELD", "m1"),
      finding("s1-m2", "s1", "GHOST_METAFIELD", "m2"),
      finding("s1-dup", "s1", "GHOST_SCRIPT", "dup"),
      finding("s2-dup", "s2", "GHOST_SCRIPT", "dup"),
      finding("s3-dup", "s3", "GHOST_SCRIPT", "dup"),
      finding("s3-m1", "s3", "GHOST_METAFIELD", "m1"),
      finding("sf-x", "s-failed", "GHOST_STYLE", "failed-only"),
    );
    tables.unknownScript.push(
      ...[1, 2, 3].map((i) => ({
        id: `u1-${i}`,
        url: "https://cdn.widgetco.com/a.js",
        createdAt: ago(i * HOUR),
      })),
      { id: "u2-old", url: "https://cdn.otherco.com/b.js", createdAt: ago(40 * HOUR) },
      { id: "u2-new", url: "https://cdn.otherco.com/b.js", createdAt: ago(2 * HOUR) },
      { id: "u-elf", url: "https://elfsightcdn.com/platform.js", createdAt: ago(2 * HOUR) },
    );
  });

  it("counts each finding once across the latest scan of each store + theme", async () => {
    const findings = section(await runDigest(), "FINDINGS (last 24h)");
    expect(findings).toContain("Unique (latest scan per store and theme): 2");
    expect(findings).toContain("GHOST_SCRIPT -- 1");
    expect(findings).toContain("GHOST_METAFIELD -- 1");
    expect(findings).not.toContain("GHOST_STYLE");
  });

  it("separates first-scan and newly-checked findings from new", async () => {
    const resolution = section(await runDigest(), "RESOLUTION (last 24h)");
    expect(resolution).toBe(
      [
        "RESOLUTION (last 24h)",
        "  Resolved: 3",
        "  New: 1",
        "  Not counted as new: 1 on a store's or theme's first scan, 2 in newly checked categories",
        "  Net (resolved - new): +2",
        "  Note: resolved also counts findings a scanner update stopped flagging",
      ].join("\n"),
    );
  });

  it("counts only findings a capped prior scan missed as newly checked", async () => {
    // A second store: its prior scan capped GHOST_METAFIELD after reaching m1;
    // the window scan checked it fully and found m1 (already known) + m2 (new).
    tables.scan.push(
      scan({
        id: "b-old",
        shopId: "shop-b",
        themeId: "theme-b",
        createdAt: ago(30 * HOUR),
        cappedCategories: ["GHOST_METAFIELD"],
      }),
      scan({
        id: "b1",
        shopId: "shop-b",
        themeId: "theme-b",
        createdAt: ago(3 * HOUR),
        newFindingCount: 2,
      }),
    );
    tables.finding.push(
      finding("bo-m1", "b-old", "GHOST_METAFIELD", "m1"),
      finding("b1-m1", "b1", "GHOST_METAFIELD", "m1"),
      finding("b1-m2", "b1", "GHOST_METAFIELD", "m2"),
      finding("b1-s", "b1", "GHOST_SCRIPT", "b-script"),
    );
    const resolution = section(await runDigest(), "RESOLUTION (last 24h)");
    // shop-a: new 1, first 1, checked 2. shop-b: m2 newly checked; m1 + b-script stay new.
    expect(resolution).toContain("  New: 2");
    expect(resolution).toContain(
      "Not counted as new: 1 on a store's or theme's first scan, 3 in newly checked categories",
    );
  });

  it("counts findings an unreachable-storefront prior scan missed as newly checked", async () => {
    // A second store: its prior scan could not read the storefront, so
    // SCRIPT_TAG_SUNSET was un-audited; the window scan read it and found one.
    tables.scan.push(
      scan({
        id: "c-old",
        shopId: "shop-b",
        themeId: "theme-b",
        createdAt: ago(30 * HOUR),
        unreachableCategories: ["SCRIPT_TAG_SUNSET"],
      }),
      scan({
        id: "c1",
        shopId: "shop-b",
        themeId: "theme-b",
        createdAt: ago(3 * HOUR),
        newFindingCount: 1,
      }),
    );
    tables.finding.push(finding("c1-st", "c1", "SCRIPT_TAG_SUNSET", "https://x.example/a.js"));
    const resolution = section(await runDigest(), "RESOLUTION (last 24h)");
    // shop-a unchanged (new 1, first 1, checked 2); shop-b's finding is newly checked.
    expect(resolution).toContain("  New: 1");
    expect(resolution).toContain(
      "Not counted as new: 1 on a store's or theme's first scan, 3 in newly checked categories",
    );
  });

  it("counts distinct unknown script URLs, skipping benign loaders", async () => {
    const body = await runDigest();
    expect(body).toContain(
      "  Unknown scripts: 2 distinct (1 first seen; 4 sightings across scans)",
    );
  });
});

describe("operator-digest handler: SCAN STARTS & RESULT VIEWS wiring", () => {
  const section = (body: string) => {
    const start = body.indexOf("SCAN STARTS & RESULT VIEWS (24h / 7d)");
    expect(start).toBeGreaterThan(-1);
    return body.slice(start, body.indexOf("\n\n", start));
  };

  beforeEach(() => {
    const now = Date.now();
    const ago = (ms: number) => new Date(now - ms);
    // Base-seed scans predate tracking (as every row did at deploy): manual,
    // no source, no shop scan number, never stamped.
    for (const s of tables.scan) {
      Object.assign(s, {
        origin: "MANUAL",
        requestedFrom: null,
        shopScanNumber: null,
        viewedOnHomeAt: null,
        viewedOnScanPageAt: null,
      });
    }
    const tracked = (o: Record<string, unknown>) => ({
      origin: "MANUAL",
      requestedFrom: null,
      shopScanNumber: null,
      viewedOnHomeAt: null,
      viewedOnScanPageAt: null,
      status: "COMPLETED",
      findingCount: 0,
      newFindingCount: 0,
      resolvedFindingCount: 0,
      skippedCategories: [],
      cappedCategories: [],
      unreachableCategories: [],
      themeId: "theme-t",
      ...o,
    });
    tables.scan.push(
      // real-a's first scan, from Home, viewed on both pages.
      tracked({
        id: "t1",
        shopId: "shop-a",
        requestedFrom: "home",
        shopScanNumber: 1,
        createdAt: ago(2 * HOUR),
        completedAt: ago(2 * HOUR),
        viewedOnHomeAt: ago(HOUR),
        viewedOnScanPageAt: ago(HOUR),
      }),
      // real-b's rescan from the scan page, viewed there (7d window only).
      tracked({
        id: "t2",
        shopId: "shop-b",
        requestedFrom: "scan_page",
        shopScanNumber: 3,
        createdAt: ago(30 * HOUR),
        completedAt: ago(30 * HOUR),
        viewedOnScanPageAt: ago(29 * HOUR),
      }),
      // real-b's scheduled scan, completed, never viewed.
      tracked({
        id: "t3",
        shopId: "shop-b",
        origin: "SCHEDULED",
        shopScanNumber: 2,
        createdAt: ago(72 * HOUR),
        completedAt: ago(72 * HOUR),
      }),
      // Older than 7d: never counted.
      tracked({
        id: "t-old",
        shopId: "shop-a",
        requestedFrom: "home",
        shopScanNumber: 1,
        createdAt: ago(9 * 24 * HOUR),
        completedAt: ago(9 * 24 * HOUR),
      }),
      // Every excluded store AND the churned real shop: 9 tracked, viewed and
      // unviewed scans each, which would visibly inflate every line if leaked.
      ...[...EXCLUDED.map((s) => s.id), "shop-churned", "shop-internal-2"].flatMap((shopId) =>
        Array.from({ length: 9 }, (_, i) =>
          tracked({
            id: `tx-${shopId}-${i}`,
            shopId,
            origin: i === 8 ? "SCHEDULED" : "MANUAL",
            requestedFrom: i % 2 === 0 ? "home" : "unknown",
            shopScanNumber: i + 1,
            createdAt: ago(HOUR),
            completedAt: ago(HOUR),
            viewedOnHomeAt: i < 4 ? ago(HOUR) : null,
            viewedOnScanPageAt: i < 2 ? ago(HOUR) : null,
          }),
        ),
      ),
    );
  });

  it("counts real active installs only, labels pre-tracking rows, and renders the section", async () => {
    const body = await runDigest();

    expect(section(body).split("\n")).toEqual([
      "SCAN STARTS & RESULT VIEWS (24h / 7d)",
      "  (first = no earlier successful scan, any origin, in the current install; a failed attempt and its retry both count as first)",
      "  Manual scans started: first 1 / 1 (home 1 / 1, scan page 0 / 0, unknown 0 / 0) | rescans 0 / 1 (home 0 / 0, scan page 0 / 1, unknown 0 / 0)",
      "  Manual scans created before tracking began (page not recorded): 1 / 1",
      "  Automatic scans (scheduled / theme publish): 0 / 1",
      "  Results viewed (first view per page): first scans home 1 / 1, scan page 1 / 1 | rescans home 0 / 0, scan page 0 / 1",
      "  Viewed on both pages: 1 / 1",
      "  Completed, not viewed yet: 0 / 1",
      "  Completed scans created before tracking began, no view recorded: 1 / 1",
    ]);
  });

  it("keeps every telemetry query window-bounded and scoped to active installs", async () => {
    await runDigest();

    const telemetryCalls = fakeDb.scan.findMany.mock.calls
      .map(([args]) => args as Record<string, Record<string, unknown>>)
      .filter(
        (args) =>
          args.select && ("shopScanNumber" in args.select || "viewedOnHomeAt" in args.select),
      );
    // Starts, Home views, scan-page views, completed.
    expect(telemetryCalls).toHaveLength(4);
    for (const args of telemetryCalls) {
      expect((args.where.shopId as { in: string[] }).in.sort()).toEqual(["shop-a", "shop-b"]);
      const bounded = Object.values(args.where).some(
        (c) => typeof c === "object" && c !== null && "gte" in c,
      );
      expect(bounded).toBe(true);
    }
  });

  it("renders an all-zero section (no queries) when there are no active installs", async () => {
    for (const s of tables.shop) s.uninstalledAt = new Date();

    const body = await runDigest();

    expect(section(body)).toContain(
      "  Manual scans started: first 0 / 0 (home 0 / 0, scan page 0 / 0, unknown 0 / 0)",
    );
    const telemetryCalls = fakeDb.scan.findMany.mock.calls.filter(
      ([args]) =>
        (args as { select?: object })?.select &&
        "shopScanNumber" in (args as { select: object }).select,
    );
    expect(telemetryCalls).toHaveLength(0);
    const classification = fakeDb.scan.groupBy.mock.calls.filter(
      ([args]) => "OR" in ((args as { where?: object }).where ?? {}),
    );
    expect(classification).toHaveLength(0);
  });

  /** Just the "Manual scans started" line. */
  const startsLine = (body: string) =>
    section(body)
      .split("\n")
      .find((l) => l.startsWith("  Manual scans started:"));

  it("classifies first vs rescan from scan history in ONE grouped query, only for shops in the window", async () => {
    await runDigest();

    const grouped = fakeDb.scan.groupBy.mock.calls
      .map(([args]) => args as { where: { OR?: Array<{ shopId: string }> } })
      .filter((args) => Array.isArray(args.where.OR));
    expect(grouped).toHaveLength(1);
    expect(grouped[0].where.OR!.map((c) => c.shopId).sort()).toEqual(["shop-a", "shop-b"]);
  });

  it("an earlier successful scan in the same install makes the next manual scan a rescan", async () => {
    // Installed long ago, so only scan history / the uninstall signal decide.
    tables.shop.find((sh) => sh.id === "shop-a")!.installedAt = new Date(
      Date.now() - 20 * 24 * HOUR,
    );
    tables.scan.push({
      id: "t-earlier",
      shopId: "shop-a",
      origin: "MANUAL",
      requestedFrom: null,
      shopScanNumber: null,
      viewedOnHomeAt: null,
      viewedOnScanPageAt: null,
      status: "COMPLETED",
      // Older than the 7d window: only the classification query sees it.
      createdAt: new Date(Date.now() - 10 * 24 * HOUR),
      completedAt: new Date(Date.now() - 10 * 24 * HOUR),
    });

    const body = await runDigest();

    expect(startsLine(body)).toBe(
      "  Manual scans started: first 0 / 0 (home 0 / 0, scan page 0 / 0, unknown 0 / 0) | rescans 1 / 2 (home 1 / 1, scan page 0 / 1, unknown 0 / 0)",
    );
  });

  it("reinstall within 48h: a success from the previous install does not make the new first scan a rescan", async () => {
    // Installed long ago, so only scan history / the uninstall signal decide.
    tables.shop.find((sh) => sh.id === "shop-a")!.installedAt = new Date(
      Date.now() - 20 * 24 * HOUR,
    );
    tables.scan.push({
      id: "t-old-install",
      shopId: "shop-a",
      origin: "MANUAL",
      requestedFrom: null,
      shopScanNumber: null,
      viewedOnHomeAt: null,
      viewedOnScanPageAt: null,
      status: "COMPLETED",
      // Older than the 7d window: only the classification query sees it.
      createdAt: new Date(Date.now() - 10 * 24 * HOUR),
      completedAt: new Date(Date.now() - 10 * 24 * HOUR),
    });
    // Uninstalled 30h ago (row kept until shop/redact), then reinstalled.
    tables.opsEvent.push({
      id: "u-real-a",
      eventType: "shop_uninstalled",
      key: "real-a.myshopify.com",
      createdAt: new Date(Date.now() - 30 * HOUR),
    });

    const body = await runDigest();

    expect(startsLine(body)).toBe(
      "  Manual scans started: first 1 / 1 (home 1 / 1, scan page 0 / 0, unknown 0 / 0) | rescans 0 / 1 (home 0 / 0, scan page 0 / 1, unknown 0 / 0)",
    );
  });

  it("failed first attempt then retry: both count as first-scan starts", async () => {
    // The retry (t1) is the shop's 2nd scan by ordinal: the failed one is 1st.
    tables.scan.find((sc) => sc.id === "t1")!.shopScanNumber = 2;
    tables.scan.push({
      id: "t-failed",
      shopId: "shop-a",
      origin: "MANUAL",
      requestedFrom: "home",
      shopScanNumber: 1,
      status: "FAILED",
      createdAt: new Date(Date.now() - 3 * HOUR),
    });

    const body = await runDigest();

    expect(startsLine(body)).toBe(
      "  Manual scans started: first 2 / 2 (home 2 / 2, scan page 0 / 0, unknown 0 / 0) | rescans 0 / 1 (home 0 / 0, scan page 0 / 1, unknown 0 / 0)",
    );
  });
});

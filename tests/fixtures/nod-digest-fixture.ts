/**
 * In-memory fake of the Prisma delegates the NOD digest loader reads (shop,
 * scan, finding, appRemoval, opsEvent), plus a fixture world. Only findMany and
 * groupBy (with _min) exist; any other access (a write) is recorded in
 * `touched` so tests can assert read-only. `finding.scan` is the one relation:
 * it filters and selects through the scan row with id = finding.scanId.
 */

export const NOW = new Date("2026-10-17T12:00:00.000Z");
export const ago = (ms: number) => new Date(NOW.getTime() - ms);
export const H = 3_600_000;
export const D = 24 * H;

export type Row = Record<string, unknown>;

export const shops: Row[] = [
  {
    id: "shop_free",
    domain: "free-merchant.myshopify.com",
    plan: "free",
    installedAt: ago(3 * D),
    uninstalledAt: null,
    isInternal: false,
    lastSeenAt: ago(1 * D),
    firstResultsViewedAt: ago(2 * D),
  },
  {
    id: "shop_std",
    domain: "std-merchant.myshopify.com",
    plan: "Standard",
    installedAt: ago(20 * D),
    uninstalledAt: null,
    isInternal: false,
    lastSeenAt: null,
  },
  {
    id: "shop_pro",
    domain: "pro-merchant.myshopify.com",
    plan: "Professional",
    installedAt: ago(60 * D),
    uninstalledAt: null,
    isInternal: false,
    lastSeenAt: null,
  },
  {
    // Uninstalled, pending redact: not active, still counted as installed in 30d.
    id: "shop_gone",
    domain: "gone-merchant.myshopify.com",
    plan: "free",
    installedAt: ago(10 * D),
    uninstalledAt: ago(2 * D),
    isInternal: false,
    lastSeenAt: null,
    firstResultsViewedAt: ago(4 * D),
  },
  {
    // Excluded by the durable isInternal flag only.
    id: "shop_internal",
    domain: "renamed-dev.myshopify.com",
    plan: "Professional",
    installedAt: ago(2 * D),
    uninstalledAt: null,
    isInternal: true,
    lastSeenAt: ago(1 * D),
    firstResultsViewedAt: ago(1 * D),
  },
  {
    // Excluded by the app-review- prefix only.
    id: "shop_review",
    domain: "app-review-abc123.myshopify.com",
    plan: "Standard",
    installedAt: ago(1 * D),
    uninstalledAt: null,
    isInternal: false,
    lastSeenAt: null,
  },
  {
    // Excluded by the default OPERATOR_EXCLUDE_SHOPS list only.
    id: "shop_envdev",
    domain: "nw-dev-store-2.myshopify.com",
    plan: "free",
    installedAt: ago(5 * D),
    uninstalledAt: null,
    isInternal: false,
    lastSeenAt: ago(1 * D),
  },
];

/** Every fixture shop domain: none may appear anywhere in the payload. */
export const SHOP_DOMAINS = shops.map((s) => s.domain as string);

const scan = (
  id: string,
  shopId: string,
  createdAt: Date,
  status: string,
  completedAt: Date | null,
  resolvedFindingCount = 0,
): Row => ({ id, shopId, createdAt, status, completedAt, resolvedFindingCount });

const scans: Row[] = [
  scan("sc_free1", "shop_free", ago(2 * H), "COMPLETED", ago(1 * H), 2),
  scan("sc_free2", "shop_free", ago(3 * D), "COMPLETED", ago(3 * D - 5 * 60_000), 0),
  scan("sc_std", "shop_std", ago(15 * D), "PARTIAL", ago(15 * D), 4),
  scan("sc_int", "shop_internal", ago(1 * D), "COMPLETED", ago(1 * D), 9),
  // Uninstalled, not yet deleted: still counts for outcome rows and the journey.
  scan("sc_gone", "shop_gone", ago(5 * D), "COMPLETED", ago(5 * D), 1),
  // Created before the 30-day window: outside every windowed row.
  scan("sc_pro_old", "shop_pro", ago(50 * D), "COMPLETED", ago(50 * D), 3),
  scan("sc_pro_failed", "shop_pro", ago(55 * D), "FAILED", ago(55 * D), 0),
];

// Scans that are not in the scans-run list (uninstalled shop, failed), kept
// separate so the activity rows' counts stay unchanged.
// sc_gone_failed's resolved count proves failed scans are not summed.
const extraScans: Row[] = [
  scan("sc_gone_failed", "shop_gone", ago(12 * H), "FAILED", ago(12 * H), 5),
];

const finding = (id: string, scanId: string, findingType: string): Row => ({
  id,
  scanId,
  findingType,
});

const findings: Row[] = [
  finding("f1", "sc_free1", "MALICIOUS_SCRIPT"),
  finding("f2", "sc_free1", "MALICIOUS_SCRIPT"), // same shop: counted once
  finding("f3", "sc_gone", "MALICIOUS_SCRIPT"),
  finding("f4", "sc_int", "MALICIOUS_SCRIPT"), // internal: excluded
  finding("f5", "sc_gone_failed", "MALICIOUS_SCRIPT"), // failed scan: excluded
  finding("f6", "sc_pro_old", "MALICIOUS_SCRIPT"), // outside the window
  finding("f7", "sc_std", "ORPHANED_SNIPPET"), // not malicious
];

const removal = (
  id: string,
  shopId: string,
  state: string,
  stateChangedAt: Date | null,
  leftoverCount: number,
): Row => ({ id, shopId, state, stateChangedAt, leftoverCount });

const appRemovals: Row[] = [
  removal("ar_free", "shop_free", "CLEANED", ago(2 * H), 3),
  removal("ar_std", "shop_std", "CLEANED", ago(10 * D), 5),
  removal("ar_gone", "shop_gone", "CLEANED", ago(3 * D), 2),
  removal("ar_pro_old", "shop_pro", "CLEANED", ago(40 * D), 1), // journey only
  removal("ar_pro_open", "shop_pro", "REMOVED", null, 4),
  removal("ar_pro_back", "shop_pro", "REINSTALLED", ago(5 * D), 6),
  removal("ar_int", "shop_internal", "CLEANED", ago(1 * D), 50),
  removal("ar_envdev", "shop_envdev", "CLEANED", ago(1 * D), 100),
];

const opsEvents: Row[] = [
  // Uninstalls (key = domain)
  { eventType: "shop_uninstalled", key: "gone-merchant.myshopify.com", createdAt: ago(2 * D) },
  { eventType: "shop_uninstalled", key: "renamed-dev.myshopify.com", createdAt: ago(1 * D) },
  { eventType: "shop_uninstalled", key: "app-review-abc123.myshopify.com", createdAt: ago(1 * D) },
  { eventType: "shop_uninstalled", key: "redacted-long-ago.myshopify.com", createdAt: ago(20 * D) },
  // Page visits
  { eventType: "page_visit", key: "free-merchant.myshopify.com", createdAt: ago(2 * D) },
  { eventType: "page_visit", key: "free-merchant.myshopify.com", createdAt: ago(9 * D) },
  { eventType: "page_visit", key: "std-merchant.myshopify.com", createdAt: ago(10 * D) },
  { eventType: "page_visit", key: "renamed-dev.myshopify.com", createdAt: ago(1 * D) },
  // Nudges
  {
    eventType: "nudge_shown",
    key: "free-merchant.myshopify.com",
    metadata: { nudgeKey: "upgrade_preview" },
    createdAt: ago(2 * D),
  },
  {
    eventType: "nudge_shown",
    key: "std-merchant.myshopify.com",
    metadata: { nudgeKey: "upgrade_preview" },
    createdAt: ago(25 * D),
  },
  {
    eventType: "nudge_clicked",
    key: "free-merchant.myshopify.com",
    metadata: { nudgeKey: "upgrade_preview" },
    createdAt: ago(2 * D),
  },
  {
    eventType: "nudge_dismissed",
    key: "gone-merchant.myshopify.com",
    metadata: { nudgeKey: "feedback" },
    createdAt: ago(4 * D),
  },
  {
    eventType: "nudge_shown",
    key: "free-merchant.myshopify.com",
    metadata: { nudgeKey: "something_new" },
    createdAt: ago(1 * D),
  },
  {
    eventType: "nudge_shown",
    key: "renamed-dev.myshopify.com",
    metadata: { nudgeKey: "upgrade_preview" },
    createdAt: ago(1 * D),
  },
  {
    eventType: "nudge_not_shown",
    key: "free-merchant.myshopify.com",
    metadata: { nudgeKey: "review_request", code: "cooldown" },
    createdAt: ago(1 * D),
  },
  // Errors (message is free text and must never reach the payload)
  {
    eventType: "webhook_failure",
    key: "APP_UNINSTALLED",
    message: "boom for free-merchant.myshopify.com",
    metadata: { shop: "free-merchant.myshopify.com" },
    createdAt: ago(1 * H),
  },
  {
    eventType: "webhook_failure",
    key: "APP_UNINSTALLED",
    message: "degraded",
    metadata: { shop: "free-merchant.myshopify.com", degraded: true, reason: "token" },
    createdAt: ago(1 * H),
  },
  {
    eventType: "webhook_failure",
    key: "APP_UNINSTALLED",
    message: "internal store",
    metadata: { shop: "renamed-dev.myshopify.com" },
    createdAt: ago(1 * H),
  },
  {
    eventType: "api_error",
    key: "graphql_throttled",
    message: "x",
    metadata: { level: "error" },
    createdAt: ago(2 * D),
  },
  {
    eventType: "api_error",
    key: "graphql_throttled",
    message: "x",
    metadata: { level: "warn" },
    createdAt: ago(2 * D),
  },
  {
    eventType: "api_error",
    key: "server_error",
    message: "x",
    metadata: { level: "error", shopDomain: "nw-dev-store-2.myshopify.com" },
    createdAt: ago(2 * D),
  },
  { eventType: "function_failure", key: "operator-digest", message: "x", createdAt: ago(3 * D) },
  {
    eventType: "function_failure",
    key: "scan-theme",
    message: "x",
    metadata: { shop: "renamed-dev.myshopify.com" },
    createdAt: ago(3 * D),
  },
  {
    eventType: "function_failure",
    key: "scan-theme",
    message: "x",
    metadata: { shop: "app-review-abc123.myshopify.com" },
    createdAt: ago(3 * D),
  },
  {
    eventType: "api_error",
    key: "oops.some-merchant.myshopify.com",
    message: "x",
    metadata: { level: "error" },
    createdAt: ago(2 * D),
  },
  {
    eventType: "client_error",
    key: "free-merchant.myshopify.com",
    message: "TypeError at free-merchant.myshopify.com",
    metadata: { kind: "boundary", path: "/app" },
    createdAt: ago(5 * H),
  },
  {
    eventType: "client_error",
    key: "renamed-dev.myshopify.com",
    message: "x",
    metadata: { kind: "boundary" },
    createdAt: ago(5 * H),
  },
  {
    eventType: "client_error",
    key: "free-merchant.myshopify.com",
    message: "old",
    metadata: { kind: "fetch" },
    createdAt: ago(10 * D),
  },
];

type Tables = Record<"shop" | "scan" | "finding" | "appRemoval" | "opsEvent", Row[]>;

function matches(row: Row, where: Row | undefined, model: string, tables: Tables): boolean {
  if (!where) return true;
  for (const [field, cond] of Object.entries(where)) {
    if (model === "finding" && field === "scan") {
      const s = tables.scan.find((r) => r.id === row.scanId);
      if (!s || !matches(s, cond as Row, "scan", tables)) return false;
      continue;
    }
    const v = row[field];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[]; gte?: Date };
      if (c.in && !c.in.includes(v)) return false;
      if (c.gte && !(v instanceof Date && v >= c.gte)) return false;
    } else if (v !== cond) return false;
  }
  return true;
}

function project(
  row: Row,
  select: Record<string, unknown> | undefined,
  model: string,
  tables: Tables,
): Row {
  if (!select) return { ...row };
  return Object.fromEntries(
    Object.entries(select).map(([k, sel]) => {
      if (model === "finding" && k === "scan") {
        const s = tables.scan.find((r) => r.id === row.scanId)!;
        return [k, project(s, (sel as { select: Record<string, unknown> }).select, "scan", tables)];
      }
      return [k, row[k]];
    }),
  );
}

function groupByMin(
  rows: Row[],
  by: string[],
  min: Record<string, boolean>,
): Array<Row & { _min: Record<string, Date | null> }> {
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const key = JSON.stringify(by.map((f) => r[f]));
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.values()].map((rs) => ({
    ...Object.fromEntries(by.map((f) => [f, rs[0][f]])),
    _min: Object.fromEntries(
      Object.keys(min).map((f) => {
        const dates = rs.map((r) => r[f]).filter((d): d is Date => d instanceof Date);
        const first = dates.length ? new Date(Math.min(...dates.map((d) => d.getTime()))) : null;
        return [f, first];
      }),
    ),
  }));
}

export interface FakeDb {
  db: Record<string, unknown>;
  /** Every property access other than `<model>.findMany` / `<model>.groupBy`. Must stay empty. */
  touched: string[];
  findManyCalls: string[];
  /** The args of every findMany, in call order. */
  findManyArgs: Array<{ model: string; args?: { where?: Row; select?: Record<string, unknown> } }>;
  groupByCalls: string[];
}

export function makeFakeDb(overrides?: Partial<Tables>): FakeDb {
  const touched: string[] = [];
  const findManyCalls: string[] = [];
  const findManyArgs: FakeDb["findManyArgs"] = [];
  const groupByCalls: string[] = [];
  const tables: Tables = {
    shop: shops,
    scan: [...scans, ...extraScans],
    finding: findings,
    appRemoval: appRemovals,
    opsEvent: opsEvents,
    ...overrides,
  };
  const delegate = (model: keyof Tables) =>
    new Proxy(
      {},
      {
        get: (_t, prop: string) => {
          if (prop === "findMany") {
            return async (args?: { where?: Row; select?: Record<string, unknown> }) => {
              findManyCalls.push(model);
              findManyArgs.push({ model, args });
              return tables[model]
                .filter((r) => matches(r, args?.where, model, tables))
                .map((r) => project(r, args?.select, model, tables));
            };
          }
          if (prop === "groupBy") {
            return async (args: { by: string[]; where?: Row; _min: Record<string, boolean> }) => {
              groupByCalls.push(model);
              const rows = tables[model].filter((r) => matches(r, args.where, model, tables));
              return groupByMin(rows, args.by, args._min);
            };
          }
          touched.push(`${model}.${prop}`);
          return () => {
            throw new Error(`unexpected db call ${model}.${prop}`);
          };
        },
      },
    );
  const db = new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop in tables) return delegate(prop as keyof Tables);
        touched.push(prop);
        return () => {
          throw new Error(`unexpected db access ${prop}`);
        };
      },
    },
  );
  return { db: db as Record<string, unknown>, touched, findManyCalls, findManyArgs, groupByCalls };
}

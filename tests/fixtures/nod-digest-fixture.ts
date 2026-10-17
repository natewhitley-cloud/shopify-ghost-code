/**
 * In-memory fake of the three Prisma delegates the NOD digest loader reads
 * (shop, scan, opsEvent), plus a fixture world. Only findMany exists; any other
 * access (a write) is recorded in `touched` so tests can assert read-only.
 */

export const NOW = new Date("2026-10-17T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const H = 3_600_000;
const D = 24 * H;

type Row = Record<string, unknown>;

const shops: Row[] = [
  {
    id: "shop_free",
    domain: "free-merchant.myshopify.com",
    plan: "free",
    installedAt: ago(3 * D),
    uninstalledAt: null,
    isInternal: false,
    lastSeenAt: ago(1 * D),
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

const scans: Row[] = [
  { shopId: "shop_free", createdAt: ago(2 * H) },
  { shopId: "shop_free", createdAt: ago(3 * D) },
  { shopId: "shop_std", createdAt: ago(15 * D) },
  { shopId: "shop_internal", createdAt: ago(1 * D) },
  { shopId: "shop_gone", createdAt: ago(5 * D) },
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

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [field, cond] of Object.entries(where)) {
    const v = row[field];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[]; gte?: Date };
      if (c.in && !c.in.includes(v)) return false;
      if (c.gte && !((v as Date) >= c.gte)) return false;
    } else if (v !== cond) return false;
  }
  return true;
}

function project(row: Row, select: Record<string, boolean> | undefined): Row {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).map((k) => [k, row[k]]));
}

export interface FakeDb {
  db: Record<string, unknown>;
  /** Every property access other than `<model>.findMany`. Must stay empty. */
  touched: string[];
  findManyCalls: string[];
}

export function makeFakeDb(overrides?: { shops?: Row[] }): FakeDb {
  const touched: string[] = [];
  const findManyCalls: string[] = [];
  const tables: Record<string, Row[]> = {
    shop: overrides?.shops ?? shops,
    scan: scans,
    opsEvent: opsEvents,
  };
  const delegate = (model: string) =>
    new Proxy(
      {},
      {
        get: (_t, prop: string) => {
          if (prop === "findMany") {
            return async (args?: { where?: Row; select?: Record<string, boolean> }) => {
              findManyCalls.push(model);
              return tables[model]
                .filter((r) => matches(r, args?.where))
                .map((r) => project(r, args?.select));
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
        if (prop in tables) return delegate(prop);
        touched.push(prop);
        return () => {
          throw new Error(`unexpected db access ${prop}`);
        };
      },
    },
  );
  return { db: db as Record<string, unknown>, touched, findManyCalls };
}

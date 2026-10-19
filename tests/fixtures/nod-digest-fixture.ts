/**
 * In-memory fake of the Prisma delegates the NOD digest loader reads (shop,
 * scan, finding, appRemoval, opsEvent, unknownScript, scanDomain,
 * signatureSubmission), plus a fixture world. Only findMany and groupBy (with
 * _min) exist; any other access (a write) is recorded in `touched` so tests can
 * assert read-only. Relations (`finding.scan`, `signatureSubmission.unknownScript`)
 * filter and select through the related row by its foreign key. Where clauses
 * support equality (null included), `in`, `gte`, `lt` and `OR`.
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

// Scans that are not in the scans-run list (uninstalled shop, failed, excluded
// shop), kept separate so the activity rows' counts stay unchanged.
// sc_gone_failed's resolved count proves failed scans are not summed.
const extraScans: Row[] = [
  scan("sc_gone_failed", "shop_gone", ago(12 * H), "FAILED", ago(12 * H), 5),
  // Internal shop, before the 7-day window: a first sighting that is not "new".
  scan("sc_int_old", "shop_internal", ago(20 * D), "COMPLETED", ago(20 * D), 0),
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

// ---- Research (NOD ADR-011) world ----
// Strings that must never reach the payload (merchant free text, paths, code).
export const SECRET_SUGGESTION = "Secret Merchant Suggestion";
export const SECRET_PATH = "secret-path-xyz";
export const SECRET_FILENAME = "snippets/secret-file.liquid";
export const SECRET_SNIPPET = "SECRET_SNIPPET_CODE";

let usSeq = 0;
const us = (
  scanId: string,
  createdAt: Date,
  url: string,
  domain: string | null,
  id = `us_${++usSeq}`,
): Row => ({
  id,
  scanId,
  createdAt,
  url,
  domain,
  filename: SECRET_FILENAME,
  lineNumber: 1,
  resourceType: "script",
  codeSnippet: SECRET_SNIPPET,
});
const scriptUrl = (host: string) => `https://${host}/${SECRET_PATH}.js`;

export const unknownScripts: Row[] = [
  // cdn.alpha-app.com: free + std (+ internal, ignored) in the window; first
  // seen 50d ago at shop_pro. shops 2, sightings 3, not new.
  us("sc_free1", ago(2 * H), scriptUrl("cdn.alpha-app.com"), "cdn.alpha-app.com", "us_alpha_free"),
  us("sc_free2", ago(3 * D), scriptUrl("cdn.alpha-app.com"), "cdn.alpha-app.com"),
  us("sc_std", ago(15 * D), scriptUrl("cdn.alpha-app.com"), "cdn.alpha-app.com", "us_alpha_std"),
  us("sc_int", ago(1 * D), scriptUrl("cdn.alpha-app.com"), "cdn.alpha-app.com", "us_alpha_int"),
  us("sc_pro_old", ago(50 * D), scriptUrl("cdn.alpha-app.com"), "cdn.alpha-app.com"),
  // legacy.beta-tools.io: legacy null domain rows, host parsed from url. New (5d).
  us("sc_gone", ago(5 * D), scriptUrl("legacy.beta-tools.io"), null, "us_beta_gone"),
  us("sc_free1", ago(2 * H), "//legacy.beta-tools.io/other.js", null),
  // solo.gamma-shop.com: one store in the window; a legacy row 50d ago makes it not new.
  us("sc_free1", ago(2 * H), scriptUrl("solo.gamma-shop.com"), "solo.gamma-shop.com", "us_gamma"),
  us("sc_pro_old", ago(50 * D), scriptUrl("solo.gamma-shop.com"), null),
  // Benign library (Google Fonts): never counted.
  us(
    "sc_free1",
    ago(2 * H),
    "https://fonts.googleapis.com/css?family=Inter",
    "fonts.googleapis.com",
  ),
  us(
    "sc_std",
    ago(15 * D),
    "https://fonts.googleapis.com/css?family=Inter",
    "fonts.googleapis.com",
  ),
  // A myshopify host at two stores: counted (new), never queued.
  us(
    "sc_free1",
    ago(2 * H),
    scriptUrl("cdn.other-store.myshopify.com"),
    "cdn.other-store.myshopify.com",
  ),
  us(
    "sc_gone",
    ago(5 * D),
    scriptUrl("cdn.other-store.myshopify.com"),
    "cdn.other-store.myshopify.com",
  ),
  // An IP address host (port dropped by URL parsing) at two stores: counted, never queued.
  us("sc_free1", ago(2 * H), `http://203.0.113.5:8080/${SECRET_PATH}.js`, "203.0.113.5"),
  us("sc_std", ago(15 * D), `http://203.0.113.5:8080/${SECRET_PATH}.js`, "203.0.113.5"),
  // cdn.jota-app.com: two stores in the last 7d, but first seen 20d ago at the
  // internal shop: first sighting is all-time and any shop, so not new.
  us("sc_free1", ago(2 * H), scriptUrl("cdn.jota-app.com"), "cdn.jota-app.com"),
  us("sc_gone", ago(5 * D), scriptUrl("cdn.jota-app.com"), "cdn.jota-app.com"),
  us("sc_int_old", ago(20 * D), scriptUrl("cdn.jota-app.com"), "cdn.jota-app.com"),
  // Seen only at the internal shop: not counted at all.
  us("sc_int", ago(1 * D), scriptUrl("internal-only.delta.dev"), "internal-only.delta.dev"),
  // Malformed url, legacy null domain: no host, skipped.
  us("sc_free1", ago(2 * H), "not a url", null),
];

const sd = (
  scanId: string,
  createdAt: Date,
  domain: string,
  flags: { matched?: boolean; benign?: boolean } = {},
): Row => ({
  id: `sd_${scanId}_${domain}`,
  scanId,
  createdAt,
  domain,
  matched: flags.matched ?? false,
  benign: flags.benign ?? false,
  appName: null,
  sources: ["script"],
  refCount: 1,
});

export const scanDomains: Row[] = [
  // api.kappa-svc.com: three stores. shops 3, sightings 3, not new.
  sd("sc_free1", ago(2 * H), "api.kappa-svc.com"),
  sd("sc_gone", ago(5 * D), "api.kappa-svc.com"),
  sd("sc_std", ago(15 * D), "api.kappa-svc.com"),
  // Same host as an unknown script: not an unmatched host.
  sd("sc_free1", ago(2 * H), "cdn.alpha-app.com"),
  sd("sc_std", ago(15 * D), "cdn.alpha-app.com"),
  // Matched or benign: never counted.
  sd("sc_free1", ago(2 * H), "known.app-sig.com", { matched: true }),
  sd("sc_std", ago(15 * D), "known.app-sig.com", { matched: true }),
  sd("sc_free1", ago(2 * H), "cdn.benign-cdn.com", { benign: true }),
  sd("sc_std", ago(15 * D), "cdn.benign-cdn.com", { benign: true }),
  // One store: counted, not queued.
  sd("sc_std", ago(15 * D), "solo-host.lambda.net"),
  // fresh.mu-cdn.com: new, two stores; an older MATCHED row at shop_pro would
  // make it not new, so it has none.
  sd("sc_free1", ago(2 * H), "fresh.mu-cdn.com"),
  sd("sc_gone", ago(5 * D), "fresh.mu-cdn.com"),
  // Internal shop only: not counted.
  sd("sc_int", ago(1 * D), "internal-only.nu.dev"),
];

const sub = (
  id: string,
  unknownScriptId: string,
  shopId: string,
  status: string,
  createdAt: Date,
): Row => ({
  id,
  unknownScriptId,
  shopId,
  status,
  createdAt,
  suggestedAppName: SECRET_SUGGESTION,
  reviewedAt: null,
});

export const signatureSubmissions: Row[] = [
  sub("sub1", "us_alpha_free", "shop_free", "PENDING", ago(1 * D)),
  sub("sub2", "us_alpha_std", "shop_std", "ACCEPTED", ago(10 * D)),
  sub("sub3", "us_beta_gone", "shop_gone", "PENDING", ago(20 * D)), // legacy null domain
  sub("sub4", "us_alpha_int", "shop_internal", "PENDING", ago(1 * D)), // internal: ignored
  sub("sub5", "us_gamma", "shop_free", "REJECTED", ago(2 * D)),
];

/**
 * A minimal research world: one active, non-internal-unless-said shop per
 * handle (`<handle>.myshopify.com`, id `shop_<handle>`) with one successful
 * scan in the window (`sc_<handle>`), plus one UnknownScript (`scripts`) or
 * unmatched ScanDomain (`domains`) row per host per listed handle. Pass the
 * result to makeFakeDb.
 */
export function researchWorld(opts: {
  shops: Array<{ handle: string; isInternal?: boolean }>;
  scripts?: Record<string, string[]>;
  domains?: Record<string, string[]>;
}): Partial<Tables> {
  const at = ago(1 * D);
  return {
    shop: opts.shops.map(({ handle, isInternal = false }) => ({
      id: `shop_${handle}`,
      domain: `${handle}.myshopify.com`,
      plan: "free",
      installedAt: ago(90 * D),
      uninstalledAt: null,
      isInternal,
      lastSeenAt: null,
      firstResultsViewedAt: null,
    })),
    scan: opts.shops.map(({ handle }) =>
      scan(`sc_${handle}`, `shop_${handle}`, at, "COMPLETED", at),
    ),
    unknownScript: Object.entries(opts.scripts ?? {}).flatMap(([host, handles]) =>
      handles.map((h) => us(`sc_${h}`, at, scriptUrl(host), host)),
    ),
    scanDomain: Object.entries(opts.domains ?? {}).flatMap(([host, handles]) =>
      handles.map((h) => sd(`sc_${h}`, at, host)),
    ),
    signatureSubmission: [],
  };
}

type Tables = Record<
  | "shop"
  | "scan"
  | "finding"
  | "appRemoval"
  | "opsEvent"
  | "unknownScript"
  | "scanDomain"
  | "signatureSubmission",
  Row[]
>;

// model -> relation field -> [related model, foreign key on this model]
const RELATIONS: Record<string, Record<string, [keyof Tables, string]>> = {
  finding: { scan: ["scan", "scanId"] },
  signatureSubmission: { unknownScript: ["unknownScript", "unknownScriptId"] },
};

const related = (row: Row, model: string, field: string, tables: Tables) => {
  const rel = RELATIONS[model]?.[field];
  return rel ? tables[rel[0]].find((r) => r.id === row[rel[1]]) : undefined;
};

function matches(row: Row, where: Row | undefined, model: string, tables: Tables): boolean {
  if (!where) return true;
  for (const [field, cond] of Object.entries(where)) {
    if (field === "OR") {
      if (!(cond as Row[]).some((w) => matches(row, w, model, tables))) return false;
      continue;
    }
    const rel = RELATIONS[model]?.[field];
    if (rel) {
      const r = related(row, model, field, tables);
      if (!r || !matches(r, cond as Row, rel[0], tables)) return false;
      continue;
    }
    const v = row[field];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[]; gte?: Date; lt?: Date };
      if (c.in && !c.in.includes(v)) return false;
      if (c.gte && !(v instanceof Date && v >= c.gte)) return false;
      if (c.lt && !(v instanceof Date && v < c.lt)) return false;
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
      const rel = RELATIONS[model]?.[k];
      if (rel) {
        const r = related(row, model, k, tables)!;
        return [k, project(r, (sel as { select: Record<string, unknown> }).select, rel[0], tables)];
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
    unknownScript: unknownScripts,
    scanDomain: scanDomains,
    signatureSubmission: signatureSubmissions,
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

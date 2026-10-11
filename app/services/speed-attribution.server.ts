/**
 * PageSpeed (Lighthouse) result -> store speed summary (gc-wt3y). Pure.
 *
 * Reads only what the report shows, from one `lighthouseResult`:
 *   - metrics: performance score, LCP, TBT, CLS, FCP, Speed Index,
 *     total-byte-weight, request count;
 *   - per-URL cost, then grouped by app:
 *       network-requests   transferSize + request count (every request)
 *       third-parties-insight per-URL subItems: mainThreadTime (Lighthouse
 *                          13+; older results carry the same subItems under
 *                          third-party-summary, read only when the insight is
 *                          absent). Lighthouse 13 dropped per-URL blocking
 *                          time, so the report has no per-app blocking figure;
 *                          the page-level TBT metric remains.
 *       bootup-time        per-script `total`: main-thread time for URLs the
 *                          third-party summary does not list (first-party
 *                          hosted app files, small third parties)
 *       unused-javascript  wastedBytes / totalBytes -> unused %
 *   Third-party-summary rows without a real URL (Lighthouse's per-entity
 *   "other resources" remainder) are skipped: they cannot be attributed and
 *   bootup-time covers the larger of those scripts.
 *
 * Attribution reuses the scanner's matcher (identifyAppForExternalUrl, the
 * same one behind ScanDomain matched/appName) and Shopify first-party check
 * (isShopifyDomain). On the store's own hosts and Shopify hosts only an APP
 * EMBED (a theme app extension asset, `.../extensions/<id>/<handle>/...` on
 * cdn.shopify.com or the store's /cdn/shop/) can belong to an app: named by
 * the matcher when it knows the app, else "App embed (<handle>)" (only apps
 * ship extensions, so it is an app row, not "other third-party", which would
 * lump every unknown embed under cdn.shopify.com). Every other URL on those
 * hosts (theme assets /cdn/shop/t/, /s/files/, Shopify's own scripts) is
 * first party even when its file name matches an app signature: a theme file
 * named back-in-stock.js is the merchant's theme code, not the app (gc-wt3y
 * #4). Third-party hosts: a known app by the matcher, else "other
 * third-party", grouped by host.
 *
 * Only this summary is kept; the raw multi-MB result is dropped by the caller.
 */

import { identifyAppForExternalUrl, isShopifyDomain } from "./scan-engine.server";
import { isPasswordPath } from "./storefront-fetcher.server";
import type { SpeedCostRow, SpeedMetrics } from "../lib/speed-report";

/** Keep at most this many "other third-party" host rows per page. */
export const MAX_OTHER_THIRD_PARTY_ROWS = 15;

export type SpeedRunSummary = {
  /** Lighthouse's final URL (after redirects); null when absent. */
  finalUrl: string | null;
  /** The run ended on the storefront password page. */
  passwordProtected: boolean;
  metrics: SpeedMetrics;
  apps: SpeedCostRow[];
  otherThirdParty: SpeedCostRow[];
  firstParty: { mainThreadMs: number; transferBytes: number };
};

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function auditItems(audits: Obj, id: string): Obj[] {
  const items = obj(obj(audits[id])?.details)?.items;
  return Array.isArray(items) ? items.filter((i): i is Obj => obj(i) !== null) : [];
}

function auditNumeric(audits: Obj, id: string): number | null {
  return num(obj(audits[id])?.numericValue);
}

function roundOrNull(v: number | null): number | null {
  return v === null ? null : Math.round(v);
}

/** An http(s) URL string (skips data:, blob:, Lighthouse's "Other resources" label). */
function isHttpUrl(v: unknown): v is string {
  return typeof v === "string" && /^https?:\/\//i.test(v);
}

/**
 * A theme app extension asset: `/extensions/<id>/<handle>/...` (cdn.shopify.com)
 * or `/cdn/shop/extensions/<id>/<handle>/...` (the store's own host). Group 1
 * is the handle (the extension's name, with a trailing `-<version>`).
 */
const APP_EMBED_PATH_RE = /^(?:\/cdn\/shop)?\/extensions\/[^/]+\/([a-z0-9][a-z0-9-]*)\//i;

export type UrlAttribution =
  | { kind: "app"; name: string }
  | { kind: "first_party" }
  | { kind: "other"; name: string };

/**
 * Who a requested URL belongs to on this store (see the file header for the
 * precedence). `storeHosts` are the shop's own storefront hosts, lowercased.
 */
export function attributeSpeedUrl(url: string, storeHosts: ReadonlySet<string>): UrlAttribution {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: "first_party" };
  }
  const host = parsed.hostname.toLowerCase();
  if (storeHosts.has(host) || isShopifyDomain(host)) {
    const embed = APP_EMBED_PATH_RE.exec(parsed.pathname);
    if (!embed) return { kind: "first_party" };
    const appName = identifyAppForExternalUrl(url);
    if (appName) return { kind: "app", name: appName };
    const handle = embed[1].toLowerCase().replace(/-\d+$/, "");
    return { kind: "app", name: `App embed (${handle})` };
  }
  const appName = identifyAppForExternalUrl(url);
  if (appName) return { kind: "app", name: appName };
  return { kind: "other", name: host };
}

type UrlCost = {
  transferBytes: number;
  requestCount: number;
  tpsMainMs: number | null;
  bootupMs: number | null;
  unusedBytes: number;
  scriptBytes: number;
};

function emptyCost(): UrlCost {
  return {
    transferBytes: 0,
    requestCount: 0,
    tpsMainMs: null,
    bootupMs: null,
    unusedBytes: 0,
    scriptBytes: 0,
  };
}

type RowAcc = {
  mainThreadMs: number;
  transferBytes: number;
  requestCount: number;
  unusedBytes: number;
  scriptBytes: number;
};

function toRow(name: string, a: RowAcc): SpeedCostRow {
  return {
    name,
    mainThreadMs: Math.round(a.mainThreadMs),
    transferBytes: Math.round(a.transferBytes),
    unusedPct: a.scriptBytes > 0 ? Math.round((a.unusedBytes / a.scriptBytes) * 100) : null,
    requestCount: a.requestCount,
  };
}

/** Heaviest first: main-thread time, then bytes, then name (stable output). */
function byCost(a: SpeedCostRow, b: SpeedCostRow): number {
  return (
    b.mainThreadMs - a.mainThreadMs ||
    b.transferBytes - a.transferBytes ||
    a.name.localeCompare(b.name)
  );
}

/**
 * Summarize one lighthouseResult. Returns null when it is not a usable result
 * (no audits object). `storeHosts`: the shop's primary + myshopify hosts.
 */
export function summarizeLighthouse(
  lhr: unknown,
  storeHosts: Iterable<string>,
): SpeedRunSummary | null {
  const root = obj(lhr);
  const audits = obj(root?.audits);
  if (!root || !audits) return null;

  const finalUrlRaw = root.finalDisplayedUrl ?? root.finalUrl ?? root.mainDocumentUrl;
  const finalUrl = typeof finalUrlRaw === "string" ? finalUrlRaw : null;
  let passwordProtected = false;
  if (finalUrl) {
    try {
      passwordProtected = isPasswordPath(new URL(finalUrl).pathname);
    } catch {
      passwordProtected = false;
    }
  }

  const scoreRaw = num(obj(obj(root.categories)?.performance)?.score);
  const networkItems = auditItems(audits, "network-requests");
  const diagnostics = auditItems(audits, "diagnostics")[0];
  const metrics: SpeedMetrics = {
    score: scoreRaw === null ? null : Math.round(scoreRaw * 100),
    lcpMs: roundOrNull(auditNumeric(audits, "largest-contentful-paint")),
    tbtMs: roundOrNull(auditNumeric(audits, "total-blocking-time")),
    cls: auditNumeric(audits, "cumulative-layout-shift"),
    fcpMs: roundOrNull(auditNumeric(audits, "first-contentful-paint")),
    speedIndexMs: roundOrNull(auditNumeric(audits, "speed-index")),
    totalBytes: roundOrNull(auditNumeric(audits, "total-byte-weight")),
    requestCount: networkItems.length > 0 ? networkItems.length : num(diagnostics?.numRequests),
  };

  // Per-URL cost from each audit.
  const costs = new Map<string, UrlCost>();
  const costFor = (url: string): UrlCost => {
    let c = costs.get(url);
    if (!c) {
      c = emptyCost();
      costs.set(url, c);
    }
    return c;
  };

  for (const item of networkItems) {
    if (!isHttpUrl(item.url)) continue;
    const c = costFor(item.url);
    c.transferBytes += num(item.transferSize) ?? 0;
    c.requestCount += 1;
  }
  const thirdPartyAudit =
    auditItems(audits, "third-parties-insight").length > 0
      ? "third-parties-insight"
      : "third-party-summary";
  for (const entity of auditItems(audits, thirdPartyAudit)) {
    const subItems = obj(entity.subItems)?.items;
    if (!Array.isArray(subItems)) continue;
    for (const raw of subItems) {
      const sub = obj(raw);
      if (!sub || !isHttpUrl(sub.url)) continue;
      const c = costFor(sub.url);
      c.tpsMainMs = (c.tpsMainMs ?? 0) + (num(sub.mainThreadTime) ?? 0);
    }
  }
  for (const item of auditItems(audits, "bootup-time")) {
    if (!isHttpUrl(item.url)) continue;
    const c = costFor(item.url);
    c.bootupMs = (c.bootupMs ?? 0) + (num(item.total) ?? 0);
  }
  for (const item of auditItems(audits, "unused-javascript")) {
    if (!isHttpUrl(item.url)) continue;
    const c = costFor(item.url);
    c.unusedBytes += num(item.wastedBytes) ?? 0;
    c.scriptBytes += num(item.totalBytes) ?? 0;
  }

  // Group by owner.
  const hosts = new Set([...storeHosts].map((h) => h.toLowerCase()));
  const apps = new Map<string, RowAcc>();
  const others = new Map<string, RowAcc>();
  const firstParty = { mainThreadMs: 0, transferBytes: 0 };
  const accFor = (map: Map<string, RowAcc>, name: string): RowAcc => {
    let a = map.get(name);
    if (!a) {
      a = {
        mainThreadMs: 0,
        transferBytes: 0,
        requestCount: 0,
        unusedBytes: 0,
        scriptBytes: 0,
      };
      map.set(name, a);
    }
    return a;
  };

  for (const [url, c] of costs) {
    // Main thread: Lighthouse's third-party attribution when it lists the URL,
    // else the script's bootup time. One source per URL, never both.
    const mainMs = c.tpsMainMs ?? c.bootupMs ?? 0;
    const owner = attributeSpeedUrl(url, hosts);
    if (owner.kind === "first_party") {
      firstParty.mainThreadMs += mainMs;
      firstParty.transferBytes += c.transferBytes;
      continue;
    }
    const a = accFor(owner.kind === "app" ? apps : others, owner.name);
    a.mainThreadMs += mainMs;
    a.transferBytes += c.transferBytes;
    a.requestCount += c.requestCount;
    a.unusedBytes += c.unusedBytes;
    a.scriptBytes += c.scriptBytes;
  }

  const hasCost = (r: SpeedCostRow) => r.mainThreadMs > 0 || r.transferBytes > 0;
  return {
    finalUrl,
    passwordProtected,
    metrics,
    apps: [...apps]
      .map(([name, a]) => toRow(name, a))
      .filter(hasCost)
      .sort(byCost),
    otherThirdParty: [...others]
      .map(([name, a]) => toRow(name, a))
      .filter(hasCost)
      .sort(byCost)
      .slice(0, MAX_OTHER_THIRD_PARTY_ROWS),
    firstParty: {
      mainThreadMs: Math.round(firstParty.mainThreadMs),
      transferBytes: Math.round(firstParty.transferBytes),
    },
  };
}

/**
 * The MEDIAN run by performance score, to cut PageSpeed's run-to-run noise.
 * Runs with no score are ignored unless no run has one (then the first run).
 * Ascending sort, stable on ties (earlier run first), lower-middle element:
 * 3 runs -> the middle one; 2 runs (one failed) -> the lower score, the
 * conservative pick. Null for no runs.
 */
export function selectMedianRun<T extends { metrics: { score: number | null } }>(
  runs: T[],
): T | null {
  if (runs.length === 0) return null;
  const scored = runs
    .map((run, index) => ({ run, index }))
    .filter((r) => r.run.metrics.score !== null);
  if (scored.length === 0) return runs[0];
  scored.sort((a, b) => a.run.metrics.score! - b.run.metrics.score! || a.index - b.index);
  return scored[Math.floor((scored.length - 1) / 2)].run;
}

/**
 * Merchant summary email (gc-ol95). Replaces the per-change "new findings"
 * alert (gc-syz.4/5): ONE summary per store after each SCHEDULED
 * scan (Professional weekly, Standard monthly; Free never), and ONLY when
 * something changed since the last summary. Merchants test many apps, so
 * per-change mail would be spam; nothing changed means no email, and the same
 * information is never sent twice.
 *
 * "Changed" = new findings, fixed findings, an app newly no longer active
 * (AppRemoval REMOVED) or an app's leftovers newly cleaned up (CLEANED), all
 * measured since the scan covered by the last summary (else the theme's
 * previous scan). The finding diff reuses the in-app diff's guards
 * (ignores, scanDiffOptions coverage, restrictToLiveInBoth), so a permission
 * grant or a newly live detector never counts as "new".
 *
 * CONSENT: nobody gets an email without knowing it is on. Sendable only when
 * the plan includes it, the toggle is on, AND the merchant either saw Home's
 * "Summary emails are on" notice (summaryNoticeShownAt) or turned the toggle
 * on themselves (summaryOptedInAt). Shops paid before this shipped have
 * neither and stay ineligible until they opt in.
 *
 * Sent as multipart text + HTML with the same facts in the same order.
 * Content is a transactional service message: counts and app names only.
 * Never code snippets, file names, customer data, upsell, or a claim that an
 * app was removed or uninstalled (we only observe it is no longer active).
 *
 * NEVER THROWS: a failed email must never fail or retry a scan.
 */

import { filterIgnoredFindings } from "./finding-aggregation.server";
import {
  ALERT_WINDOW_TOLERANCE,
  buildBodyUnsubscribeUrl,
  buildHeaderUnsubscribeUrl,
  buildScanAdminUrl,
  getMerchantAlertConfigStatus,
  sendMerchantAlert,
} from "./merchant-alert.server";
import {
  diffScans,
  djb2Hex,
  parseLiveFindingTypes,
  restrictToLiveInBoth,
  scanDiffOptions,
} from "./scan-differ.server";
import type { DiffableFinding, ScanCoverage } from "./scan-differ.server";
import { refreshShopContact } from "./shop-alert-email.server";
import { getPlanFeatures } from "../lib/billing.server";
import { logger } from "../lib/logger.server";
import { canReceiveAlerts, getAlertWindowMs } from "../lib/plan-gating.server";
import { safeErrorFields } from "../lib/safe-error";
import type { SummaryCadence } from "../lib/summary-email-copy";
import type { SummaryRemovalRow } from "../models/app-removal.server";
import type { ShopIgnores } from "../models/ignored-finding.server";
import { ensureUnsubscribeToken, recordMerchantAlert } from "../models/merchant-alert.server";
import type { AdminApiContext } from "../types/shopify";

/** Apps listed per section; the rest are summarized as "- and K more". */
export const MAX_APPS_IN_EMAIL = 5;

/** Sender identity printed in every footer. */
export const SENDER_NAME = "Alpenglow Software LLC";
export const SUPPORT_EMAIL = "support@alpenglowsoftware.com";
/** 128x128 PNG on our public site, shown at 32x32 left of SENDER_NAME in the HTML footer. */
export const ALPENGLOW_LOGO_URL = "https://alpenglowsoftware.com/assets/icons/alpenglow.png";
/** Label of the scan deep link (text: "{label}:" then the URL; HTML: the link text). */
const SCAN_LINK_LABEL = "See the details in GhostCode";

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

export type SummaryApp = { appName: string; leftoverCount: number };

export type SummaryChanges = {
  newCount: number;
  fixedCount: number;
  /** Non-ignored findings in the current scan ("Still in your theme"). */
  openCount: number;
  inactiveApps: SummaryApp[];
  cleanedApps: SummaryApp[];
};

/** What "since" means in the copy: the last summary's scan, or the previous scan. */
export type SummaryBaseline = "last_summary" | "previous_scan";

/** True when the summary has anything to report (else: no email). */
export function hasSummaryChanges(c: SummaryChanges): boolean {
  return (
    c.newCount > 0 || c.fixedCount > 0 || c.inactiveApps.length > 0 || c.cleanedApps.length > 0
  );
}

const byAppName = (a: SummaryApp, b: SummaryApp) => a.appName.localeCompare(b.appName);

/**
 * App changes within the summary period from AppRemoval rows touched by the
 * period's scans. Newly no longer active = detected on a period scan and still
 * REMOVED. Cleaned up = turned CLEANED on a period scan. An app that went
 * inactive and came back (REINSTALLED) is omitted, as is any REINSTALLED row.
 * One line per app: newly inactive wins over an older cleaned-up row.
 */
export function summarizeAppRemovals(
  rows: readonly SummaryRemovalRow[],
  periodScanIds: ReadonlySet<string>,
): { inactiveApps: SummaryApp[]; cleanedApps: SummaryApp[] } {
  const inactive = new Map<string, SummaryRemovalRow>();
  const cleaned = new Map<string, SummaryRemovalRow>();
  for (const row of rows) {
    if (row.state === "REMOVED" && periodScanIds.has(row.detectedScanId)) {
      const prior = inactive.get(row.appName);
      if (!prior || prior.detectedAt < row.detectedAt) inactive.set(row.appName, row);
    } else if (
      row.state === "CLEANED" &&
      row.stateChangedScanId !== null &&
      periodScanIds.has(row.stateChangedScanId)
    ) {
      const prior = cleaned.get(row.appName);
      if (!prior || prior.detectedAt < row.detectedAt) cleaned.set(row.appName, row);
    }
  }
  for (const appName of inactive.keys()) cleaned.delete(appName);
  const toApp = (r: SummaryRemovalRow): SummaryApp => ({
    appName: r.appName,
    leftoverCount: r.leftoverCount,
  });
  return {
    inactiveApps: [...inactive.values()].map(toApp).sort(byAppName),
    cleanedApps: [...cleaned.values()].map(toApp).sort(byAppName),
  };
}

type BaselineScan = ScanCoverage & { findings: DiffableFinding[]; liveFindingTypes: unknown };

/**
 * Finding counts for the summary, with the same guards as the in-app diff:
 * ignored findings never count, a category either scan did not audit is
 * neither new nor fixed (scanDiffOptions), and only types live in BOTH scans
 * count (restrictToLiveInBoth), so a permission grant or a newly live detector
 * cannot produce "new". A scan without a recorded live set cannot be judged.
 */
export function computeFindingChanges(args: {
  currentFindings: DiffableFinding[];
  currentCoverage: ScanCoverage & { skippedFiles: readonly string[] };
  currentLiveFindingTypes: unknown;
  baseline: BaselineScan;
  ignores: ShopIgnores;
}):
  | { ok: true; newCount: number; fixedCount: number; openCount: number }
  | { ok: false; reason: "baseline_unversioned" | "current_unversioned" } {
  const baselineLive = parseLiveFindingTypes(args.baseline.liveFindingTypes);
  if (!baselineLive) return { ok: false, reason: "baseline_unversioned" };
  const currentLive = parseLiveFindingTypes(args.currentLiveFindingTypes);
  if (!currentLive) return { ok: false, reason: "current_unversioned" };

  const current = filterIgnoredFindings(args.currentFindings, args.ignores).kept;
  const diff = diffScans(
    current,
    filterIgnoredFindings(args.baseline.findings, args.ignores).kept,
    scanDiffOptions(args.currentCoverage, args.baseline),
  );
  return {
    ok: true,
    newCount: restrictToLiveInBoth(diff.newFindings, baselineLive, currentLive).length,
    fixedCount: restrictToLiveInBoth(diff.resolvedFindings, baselineLive, currentLive).length,
    openCount: current.length,
  };
}

/**
 * Order-independent hash of what a summary reported (the ledger's
 * findingSetHash column): counts plus the app lines.
 */
export function buildSummaryHash(c: SummaryChanges): string {
  const apps = (list: SummaryApp[]) => list.map((a) => `${a.appName}\0${a.leftoverCount}`).sort();
  return djb2Hex(
    JSON.stringify({
      n: c.newCount,
      f: c.fixedCount,
      o: c.openCount,
      i: apps(c.inactiveApps),
      c: apps(c.cleanedApps),
    }),
  );
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

const SINCE_PHRASE: Record<SummaryBaseline, string> = {
  last_summary: "since your last summary",
  previous_scan: "since your previous scan",
};

const items = (n: number) => (n === 1 ? "1 item" : `${n} items`);

/** Longest store name the subject and opening line show. */
export const MAX_STORE_NAME_IN_EMAIL = 80;

/**
 * The store name as the email shows it: the cached Shop.storeName with control
 * characters (newlines included) turned into spaces, invisible format
 * characters dropped, whitespace collapsed, and capped at
 * MAX_STORE_NAME_IN_EMAIL characters. The myshopify domain when the name is
 * null or blank. The HTML builder escapes the result like any other value.
 */
export function storeNameForEmail(storeName: string | null, shopDomain: string): string {
  const clean = (storeName ?? "")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return shopDomain;
  const chars = Array.from(clean);
  return chars.length > MAX_STORE_NAME_IN_EMAIL
    ? chars.slice(0, MAX_STORE_NAME_IN_EMAIL).join("").trimEnd()
    : clean;
}

/**
 * One digest subject for every summary, whatever changed: no status, no app
 * names, no cadence. "GhostCode digest for {Store Name}".
 */
export function buildSummarySubject(storeName: string | null, shopDomain: string): string {
  return `GhostCode digest for ${storeNameForEmail(storeName, shopDomain)}`;
}

function cappedLines(apps: SummaryApp[], line: (a: SummaryApp) => string): string[] {
  const shown = apps.slice(0, MAX_APPS_IN_EMAIL).map(line);
  const extra = apps.length - MAX_APPS_IN_EMAIL;
  if (extra > 0) shown.push(`- and ${extra} more`);
  return shown;
}

export type SummaryBodyOptions = {
  /** Cached Shop.storeName; the domain stands in when it is null or blank. */
  storeName: string | null;
  shopDomain: string;
  cadence: SummaryCadence;
  changes: SummaryChanges;
  baseline: SummaryBaseline;
  scanUrl: string;
  unsubscribeUrl: string;
};

/**
 * The body's facts in order, shared by the text and HTML versions so they can
 * never drift: the intro, one block per app section, the counts, then the
 * scan and unsubscribe links. Plain strings: the HTML builder escapes them.
 */
function buildSummaryContent(opts: SummaryBodyOptions) {
  const { changes: c } = opts;
  const since = SINCE_PHRASE[opts.baseline];
  const appBlocks: string[][] = [];
  if (c.inactiveApps.length > 0) {
    appBlocks.push(
      cappedLines(
        c.inactiveApps,
        (a) => `- ${a.appName} is no longer active. It left ${items(a.leftoverCount)} behind.`,
      ),
    );
  }
  if (c.cleanedApps.length > 0) {
    appBlocks.push(
      cappedLines(c.cleanedApps, (a) =>
        a.leftoverCount === 1
          ? `- ${a.appName}: cleaned up. The 1 item it left is gone.`
          : `- ${a.appName}: cleaned up. All ${a.leftoverCount} items it left are gone.`,
      ),
    );
  }
  return {
    intro: `Here is your ${opts.cadence} digest for ${storeNameForEmail(opts.storeName, opts.shopDomain)} from GhostCode.`,
    appBlocks,
    counts: [
      `New ${since}: ${c.newCount}`,
      `Fixed ${since}: ${c.fixedCount}`,
      `Still in your theme: ${c.openCount}`,
    ],
    scanUrl: opts.scanUrl,
    unsubscribeUrl: opts.unsubscribeUrl,
  };
}

/** Plain-text body. Counts and app names only; see the module comment. */
export function buildSummaryText(opts: SummaryBodyOptions): string {
  const body = buildSummaryContent(opts);
  const lines = [body.intro, ""];
  for (const block of body.appBlocks) lines.push(...block, "");
  lines.push(
    ...body.counts,
    "",
    `${SCAN_LINK_LABEL}:`,
    body.scanUrl,
    "",
    SENDER_NAME,
    SUPPORT_EMAIL,
    `Unsubscribe: ${body.unsubscribeUrl}`,
  );
  return lines.join("\n");
}

/** Escape a value for HTML text or a double-quoted attribute. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const FONT_STACK = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const LINK_STYLE = "color:#1a56db;text-decoration:underline";

/**
 * HTML body, sent alongside the text (multipart). Same facts in the same order
 * as buildSummaryText. Email-client-safe: table layout, inline styles only, no
 * external CSS, no scripts. Every interpolated value is escaped. Exported so
 * the rendered email can be eyeballed (write the string to a .html file).
 */
export function buildSummaryHtml(opts: SummaryBodyOptions): string {
  const body = buildSummaryContent(opts);
  const block = (lines: string[], pad = "0 0 16px") =>
    `<tr><td style="padding:${pad}">${lines.map(escapeHtml).join("<br>")}</td></tr>`;
  const link = (href: string, label: string) =>
    `<a href="${escapeHtml(href)}" style="${LINK_STYLE}">${escapeHtml(label)}</a>`;
  // App lines render as a real bullet list (the text version keeps "- ").
  const list = (lines: string[]) =>
    `<tr><td style="padding:0 0 16px"><ul style="margin:0;padding:0 0 0 20px">` +
    lines
      .map((l) => `<li style="margin:0 0 4px">${escapeHtml(l.replace(/^- /, ""))}</li>`)
      .join("") +
    `</ul></td></tr>`;
  const rows = [
    block([body.intro]),
    ...body.appBlocks.map(list),
    block(body.counts),
    `<tr><td style="padding:0 0 24px">${link(body.scanUrl, SCAN_LINK_LABEL)}</td></tr>`,
    `<tr><td style="padding:16px 0 0;border-top:1px solid #e5e5e5">` +
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
      `<td valign="middle" style="padding:0 12px 0 0">` +
      `<img src="${escapeHtml(ALPENGLOW_LOGO_URL)}" width="32" height="32" alt="${escapeHtml(SENDER_NAME)}" style="border-radius:6px;display:block"></td>` +
      `<td valign="middle" style="font-size:13px;line-height:1.5;color:#555555">` +
      `${escapeHtml(SENDER_NAME)}<br>` +
      `${link(`mailto:${SUPPORT_EMAIL}`, SUPPORT_EMAIL)}<br>` +
      `${link(body.unsubscribeUrl, "Unsubscribe")}` +
      `</td></tr></table></td></tr>`,
  ];
  return [
    "<!doctype html>",
    '<html lang="en">',
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>',
    '<body style="margin:0;padding:0;background:#ffffff">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff">',
    '<tr><td align="center" style="padding:24px 16px">',
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;font-family:${FONT_STACK};font-size:15px;line-height:1.5;color:#1a1a1a;text-align:left">`,
    ...rows,
    "</table>",
    "</td></tr>",
    "</table>",
    "</body>",
    "</html>",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export type SummaryShop = {
  id: string;
  domain: string;
  plan: string;
  alertsEnabled: boolean;
  alertEmail: string | null;
  storeName: string | null;
  uninstalledAt: Date | null;
  summaryNoticeShownAt: Date | null;
  summaryOptedInAt: Date | null;
};

export type SummaryShopSkipReason =
  | "shop_uninstalled"
  | "plan_not_eligible"
  | "shop_opted_out"
  | "no_consent";

/**
 * The shop-level gates (no I/O): installed, a plan that includes summaries,
 * the toggle on, and consent (notice shown or the merchant opted in). Returns
 * the first failing reason, or null when the shop may receive a summary.
 */
export function summaryShopSkipReason(shop: SummaryShop): SummaryShopSkipReason | null {
  if (shop.uninstalledAt) return "shop_uninstalled";
  if (!canReceiveAlerts(shop.plan)) return "plan_not_eligible";
  if (!shop.alertsEnabled) return "shop_opted_out";
  if (!shop.summaryNoticeShownAt && !shop.summaryOptedInAt) return "no_consent";
  return null;
}

export type LatestSummary = { scanId: string; sentAt: Date } | null;

/**
 * Per-scan idempotency and the cadence throttle: a summary already sent for
 * THIS scan (an Inngest retry) is never sent again, and at most one summary
 * goes out per plan window (with ALERT_WINDOW_TOLERANCE for scheduler jitter).
 */
export function summaryRateSkipReason(
  plan: string,
  scanId: string,
  latest: LatestSummary,
  now: Date = new Date(),
): "already_sent" | "throttled" | "plan_not_eligible" | null {
  if (latest?.scanId === scanId) return "already_sent";
  const windowMs = getAlertWindowMs(plan);
  if (windowMs === null) return "plan_not_eligible";
  if (latest && now.getTime() - latest.sentAt.getTime() < windowMs * ALERT_WINDOW_TOLERANCE) {
    return "throttled";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export type SummaryOutcomeReason =
  | "sent"
  | "sent_not_recorded"
  | "disabled"
  | "no_transport"
  | "no_sender"
  | SummaryShopSkipReason
  | "already_sent"
  | "throttled"
  | "nothing_changed"
  | "no_recipient"
  | "no_app_url"
  | "no_unsubscribe_token"
  | "send_failed"
  | "exception";

export interface SummaryOutcome {
  sent: boolean;
  reason: SummaryOutcomeReason;
}

const skip = (reason: SummaryOutcomeReason): SummaryOutcome => ({ sent: false, reason });

/** Prisma unique-constraint violation (the ledger row already exists). */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002"
  );
}

/**
 * Run every gate and, if all pass, email the shop owner one summary for
 * `scan`, then record it in the ledger. Order: env gates, shop gates
 * (uninstalled, plan, toggle, consent), idempotency + throttle, nothing
 * changed, recipient and store name (freshly read, else the cached ones), app
 * URL, unsubscribe token, send, record. `admin` may be null (dead offline
 * token): the cached Shop.alertEmail and Shop.storeName are then used. Never
 * throws.
 */
export async function sendScanSummary(args: {
  shop: SummaryShop;
  scan: { id: string };
  changes: SummaryChanges;
  baseline: SummaryBaseline;
  admin: AdminApiContext | null;
  /** Latest ledger row, already loaded by the caller. */
  latestSummary: LatestSummary;
}): Promise<SummaryOutcome> {
  const { shop, scan, changes, baseline, admin, latestSummary } = args;
  try {
    const config = getMerchantAlertConfigStatus();
    if (!config.configured) return skip(config.reason);

    const shopSkip = summaryShopSkipReason(shop);
    if (shopSkip) return skip(shopSkip);
    const rateSkip = summaryRateSkipReason(shop.plan, scan.id, latestSummary);
    if (rateSkip) return skip(rateSkip);
    if (!hasSummaryChanges(changes)) return skip("nothing_changed");

    // refreshShopContact never throws; a field it could not read is null.
    const fresh = admin ? await refreshShopContact(shop.domain, admin) : null;
    const recipient = fresh?.email ?? shop.alertEmail;
    const storeName = fresh?.storeName ?? shop.storeName;
    if (!recipient) return skip("no_recipient");

    const appUrl = process.env.SHOPIFY_APP_URL?.replace(/\/+$/, "");
    if (!appUrl) return skip("no_app_url");
    const token = await ensureUnsubscribeToken(shop.id);
    if (!token) return skip("no_unsubscribe_token");

    const cadence = getPlanFeatures(shop.plan).alertCadence;
    // summaryShopSkipReason already excluded "none"; this narrows the type.
    if (cadence === "none") return skip("plan_not_eligible");

    const bodyOptions: SummaryBodyOptions = {
      storeName,
      shopDomain: shop.domain,
      cadence,
      changes,
      baseline,
      scanUrl: buildScanAdminUrl(shop.domain, scan.id),
      unsubscribeUrl: buildBodyUnsubscribeUrl(appUrl, token),
    };
    const result = await sendMerchantAlert({
      to: recipient,
      subject: buildSummarySubject(storeName, shop.domain),
      text: buildSummaryText(bodyOptions),
      html: buildSummaryHtml(bodyOptions),
      unsubscribeUrl: buildHeaderUnsubscribeUrl(appUrl, token),
      // Same key on an Inngest retry: Resend returns the original response.
      idempotencyKey: `summary-email:${scan.id}`,
    });
    if (!result.sent) return skip("send_failed");

    try {
      await recordMerchantAlert({
        shopId: shop.id,
        scanId: scan.id,
        findingSetHash: buildSummaryHash(changes),
        newCount: changes.newCount,
        fixedCount: changes.fixedCount,
        inactiveAppCount: changes.inactiveApps.length,
        cleanedAppCount: changes.cleanedApps.length,
        recipient,
      });
    } catch (error) {
      // (shopId, scanId) already recorded by an earlier attempt: still sent once.
      if (isUniqueViolation(error)) return { sent: true, reason: "sent" };
      // Mail is out but the ledger write failed: the Resend idempotency key
      // covers a retry within 24h; surface it loudly (no PII).
      logger.error("Summary email sent but ledger write failed", {
        context: "summary-email",
        scanId: scan.id,
        ...safeErrorFields(error),
      });
      return { sent: true, reason: "sent_not_recorded" };
    }
    return { sent: true, reason: "sent" };
  } catch (error) {
    logger.error("Summary email failed", {
      context: "summary-email",
      ...safeErrorFields(error),
    });
    return skip("exception");
  }
}

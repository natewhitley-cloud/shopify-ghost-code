/**
 * The Store speed page's plan-gated report read (gc-wt3y), shared by the page
 * loader (app/routes/app.speed.tsx) and the Sidekick speed tool (gc-5nok), so
 * both gate exactly the same way:
 *   - Standard / Professional (`speedReport`): every recent report, as the
 *     full view (a FREE_TEST report from before an upgrade included), with the
 *     plan's cadence (Standard monthly, Professional weekly) and whether it
 *     has Run now (Professional only, gc-d0ui).
 *   - Free (`freeSpeedTest`): ONLY FREE_TEST reports (a downgraded shop's
 *     paid history stays hidden), stripped to the free test's view (homepage
 *     score, core timings, ONE costliest app).
 *   - A plan with neither: no report data is read at all.
 *
 * `requestedAt` (the Run now / free test slot) is read for the page; the
 * Sidekick tool ignores it, an accepted extra indexed read to keep ONE gate.
 *
 * Read-only and side-effect free: the page's upgrade ask and its nudge
 * telemetry stay in the route. Reaches only the read-only speed data modules
 * (the model and the pure lib), never the PageSpeed client or the worker.
 */
import { isRuntimeMaliciousCheckLive } from "./soft-launch-flags.server";
import { KNOWN_MALICIOUS_DOMAINS, type MaliciousDomain } from "../data/malicious-domains.server";
import { getPlanFeatures, type PlanFeatures } from "../lib/billing.server";
import { logger } from "../lib/logger.server";
import type { MaliciousRisk } from "../lib/security-risk";
import {
  buildFreeSpeedTestView,
  buildSpeedReportView,
  SPEED_REPORT_ORIGIN,
} from "../lib/speed-report";
import type { FreeSpeedTestView, SpeedPageResult, SpeedReportView } from "../lib/speed-report";
import {
  countFreeSpeedTestAttempts,
  getFreeSpeedTestUsedAt,
  getRecentSpeedReports,
  getSpeedReportRequestedAt,
} from "../models/speed-report.server";

export type SpeedPageReport =
  | { access: "locked" }
  | { access: "free"; freeTest: FreeSpeedTestView; requestedAt: Date | null }
  | {
      access: "report";
      view: SpeedReportView;
      cadence: "weekly" | "monthly";
      runNow: boolean;
      requestedAt: Date | null;
    };

/** Standard / Professional: the full, recurring speed report (narrows the cadence). */
function hasFullSpeedReport(
  features: PlanFeatures,
): features is PlanFeatures & { speedReportCadence: "weekly" | "monthly" } {
  return features.speedReport && features.speedReportCadence !== "none";
}

export async function readSpeedPageReport(
  shop: { id: string; plan: string },
  now: Date,
): Promise<SpeedPageReport> {
  const features = getPlanFeatures(shop.plan);
  if (hasFullSpeedReport(features)) {
    const [rows, requestedAt] = await Promise.all([
      getRecentSpeedReports(shop.id),
      getSpeedReportRequestedAt(shop.id),
    ]);
    return {
      access: "report",
      view: buildSpeedReportView(rows, now),
      cadence: features.speedReportCadence,
      runNow: features.speedRunNow,
      requestedAt,
    };
  }
  if (!features.freeSpeedTest) return { access: "locked" };

  const [rows, usedAt, requestedAt, attempts] = await Promise.all([
    getRecentSpeedReports(shop.id, { origin: SPEED_REPORT_ORIGIN.FREE_TEST }),
    getFreeSpeedTestUsedAt(shop.id),
    getSpeedReportRequestedAt(shop.id),
    countFreeSpeedTestAttempts(shop.id),
  ]);
  return {
    access: "free",
    freeTest: buildFreeSpeedTestView(rows, usedAt, now, attempts),
    requestedAt,
  };
}

// ---------------------------------------------------------------------------
// Known malicious code seen in the speed test (gc-0htk)
// ---------------------------------------------------------------------------

/**
 * One Security risk banner per listed domain the speed test's browser
 * requested, from the stored pages (SpeedPageResult.maliciousDomains), naming
 * the pages. A domain no longer on the list is not shown. Sorted by domain.
 */
export function speedSecurityRisks(
  pages: readonly SpeedPageResult[],
  domains: ReadonlyArray<MaliciousDomain> = KNOWN_MALICIOUS_DOMAINS,
): MaliciousRisk[] {
  const pagesByDomain = new Map<string, Array<"home" | "product">>();
  for (const page of pages) {
    for (const domain of page.maliciousDomains ?? []) {
      const seen = pagesByDomain.get(domain) ?? [];
      if (!seen.includes(page.page)) seen.push(page.page);
      pagesByDomain.set(domain, seen);
    }
  }
  const risks: MaliciousRisk[] = [];
  for (const [domain, speedPages] of [...pagesByDomain].sort(([a], [b]) => a.localeCompare(b))) {
    const entry = domains.find((d) => d.domain === domain);
    if (!entry) continue;
    risks.push({
      kind: "malicious",
      seenIn: "speed_test",
      speedPages,
      domain: entry.domain,
      note: entry.note,
      advice: null,
      findings: [],
      description: `${entry.domain} (${entry.note})`,
    });
  }
  return risks;
}

type SpeedSecurity = { risks: MaliciousRisk[]; testedAt: string | null };

const NO_SPEED_RISKS: SpeedSecurity = { risks: [], testedAt: null };

/** The banners for a built view's latest report with results (pure). */
function securityFromView(view: SpeedReportView): SpeedSecurity {
  const latest = view.lastResults;
  if (!latest) return NO_SPEED_RISKS;
  const risks = speedSecurityRisks(latest.pages);
  return risks.length > 0 ? { risks, testedAt: latest.createdAt } : NO_SPEED_RISKS;
}

/**
 * The Store speed page's Security risk banners (gc-0htk): known malicious
 * domains the shop's LATEST speed report with results requested, of ANY
 * origin and on EVERY plan. Deliberately outside readSpeedPageReport's plan
 * gate: a security finding is never paywalled, so a downgraded shop still
 * sees what its last paid report found. `testedAt` = that report's date.
 *
 * Off (RUNTIME_MALICIOUS_CHECK_LIVE_ENABLED not "true"): nothing is read and
 * nothing is shown. Never throws: a failed read is logged and shows nothing.
 */
async function readSpeedSecurityRisks(shopId: string, now: Date): Promise<SpeedSecurity> {
  if (!isRuntimeMaliciousCheckLive()) return NO_SPEED_RISKS;
  try {
    return securityFromView(buildSpeedReportView(await getRecentSpeedReports(shopId), now));
  } catch (err) {
    logger.warn("speed security risks unavailable", {
      function: "readSpeedSecurityRisks",
      shopId,
      errorName: err instanceof Error ? err.name : typeof err,
    });
    return NO_SPEED_RISKS;
  }
}

/**
 * Everything the Store speed page shows, read once (gc-3y89 item 4): the
 * plan-gated report and the speed-test Security risk banners. (The Sidekick
 * speed tool reads only readSpeedPageReport: item 9 is deferred.)
 *
 * On Standard / Professional the report view already holds the latest report
 * with results of any origin (the same rows readSpeedSecurityRisks reads), so
 * the banners come from it and the speed reports are read ONCE. On other
 * plans the two reads differ (Free sees only FREE_TEST rows; the banners
 * still come from the latest report of any origin) and run in parallel.
 *
 * `speedTestRepeats` (gc-3y89 item 10): on a plan without the recurring
 * report no newer speed test will replace this one (the one free test, or a
 * downgraded shop's last paid report), so the banner is dated rather than
 * reading as current.
 */
export async function readSpeedPageData(
  shop: { id: string; plan: string },
  now: Date,
): Promise<{ report: SpeedPageReport; security: SpeedSecurity }> {
  if (hasFullSpeedReport(getPlanFeatures(shop.plan))) {
    const report = await readSpeedPageReport(shop, now);
    const security =
      report.access === "report" && isRuntimeMaliciousCheckLive()
        ? securityFromView(report.view)
        : NO_SPEED_RISKS;
    return { report, security };
  }
  const [report, security] = await Promise.all([
    readSpeedPageReport(shop, now),
    readSpeedSecurityRisks(shop.id, now),
  ]);
  return {
    report,
    security: {
      ...security,
      risks: security.risks.map((risk) => ({ ...risk, speedTestRepeats: false })),
    },
  };
}

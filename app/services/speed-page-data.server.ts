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
import { getPlanFeatures } from "../lib/billing.server";
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

export async function readSpeedPageReport(
  shop: { id: string; plan: string },
  now: Date,
): Promise<SpeedPageReport> {
  const features = getPlanFeatures(shop.plan);
  if (features.speedReport && features.speedReportCadence !== "none") {
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
export async function readSpeedSecurityRisks(
  shopId: string,
  now: Date,
): Promise<{ risks: MaliciousRisk[]; testedAt: string | null }> {
  const none = { risks: [], testedAt: null };
  if (!isRuntimeMaliciousCheckLive()) return none;
  try {
    const latest = buildSpeedReportView(await getRecentSpeedReports(shopId), now).lastResults;
    if (!latest) return none;
    const risks = speedSecurityRisks(latest.pages);
    return risks.length > 0 ? { risks, testedAt: latest.createdAt } : none;
  } catch (err) {
    logger.warn("speed security risks unavailable", {
      function: "readSpeedSecurityRisks",
      shopId,
      errorName: err instanceof Error ? err.name : typeof err,
    });
    return none;
  }
}

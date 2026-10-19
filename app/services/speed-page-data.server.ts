/**
 * The Store speed page's plan-gated report read (gc-wt3y), shared by the page
 * loader (app/routes/app.speed.tsx) and the Sidekick speed tool (gc-5nok), so
 * both gate exactly the same way:
 *   - Professional (`speedReport`): every recent report, as the full view.
 *   - Free / Standard (`freeSpeedTest`): ONLY FREE_TEST reports (a downgraded
 *     shop's Professional history stays hidden), stripped to the free test's
 *     view (homepage score, core timings, ONE costliest app).
 *   - A plan with neither: no report data is read at all.
 *
 * `requestedAt` (the Run now / free test slot) is read for the page; the
 * Sidekick tool ignores it, an accepted extra indexed read to keep ONE gate.
 *
 * Read-only and side-effect free: the page's upgrade ask and its nudge
 * telemetry stay in the route. Reaches only the read-only speed data modules
 * (the model and the pure lib), never the PageSpeed client or the worker.
 */
import { getPlanFeatures } from "../lib/billing.server";
import {
  buildFreeSpeedTestView,
  buildSpeedReportView,
  SPEED_REPORT_ORIGIN,
} from "../lib/speed-report";
import type { FreeSpeedTestView, SpeedReportView } from "../lib/speed-report";
import {
  countFreeSpeedTestAttempts,
  getFreeSpeedTestUsedAt,
  getRecentSpeedReports,
  getSpeedReportRequestedAt,
} from "../models/speed-report.server";

export type SpeedPageReport =
  | { access: "locked" }
  | { access: "free"; freeTest: FreeSpeedTestView; requestedAt: Date | null }
  | { access: "pro"; view: SpeedReportView; requestedAt: Date | null };

export async function readSpeedPageReport(
  shop: { id: string; plan: string },
  now: Date,
): Promise<SpeedPageReport> {
  const features = getPlanFeatures(shop.plan);
  if (features.speedReport) {
    const [rows, requestedAt] = await Promise.all([
      getRecentSpeedReports(shop.id),
      getSpeedReportRequestedAt(shop.id),
    ]);
    return { access: "pro", view: buildSpeedReportView(rows, now), requestedAt };
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

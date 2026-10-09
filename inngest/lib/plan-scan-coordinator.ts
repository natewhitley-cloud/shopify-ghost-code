/**
 * Plan-cadence scheduled-scan coordinator (gc-iefo).
 *
 * One cron per paid plan fans out a `poll/check-shop` event for every active
 * shop on that plan; the poll-check-shop worker then starts a SCHEDULED scan
 * for each, whether or not the theme changed since the last scan. The plan
 * cohorts are disjoint, so the coordinators never double-dispatch a shop:
 *   - weekly-scan:  Professional, weekly
 *   - monthly-scan: Standard, monthly
 * Free has no scheduled scans.
 *
 * Fan-out pattern:
 *   1. Coordinator (this): fast, one DB read + chunked event sends
 *      (fanOutShopChecks).
 *   2. Worker (poll-check-shop.ts): one invocation per shop, concurrency-capped,
 *      each with independent retries.
 *
 * Every coordinator is wrapped in withCronHeartbeat under its function id, so
 * CRON_HEARTBEAT_EXPECTATIONS must list that id with the cron's interval.
 */

import { inngest } from "../client";
import { fanOutShopChecks } from "./fan-out";
import { withCronHeartbeat } from "./heartbeat";

export function createPlanScanCoordinator(config: {
  /** Inngest function id AND heartbeat key. Never rename: it orphans the cron. */
  id: string;
  name: string;
  cron: string;
  /** Canonical stored Shop.plan value (PLANS.*), e.g. "Professional". */
  plan: string;
}) {
  return inngest.createFunction(
    { id: config.id, name: config.name },
    { cron: config.cron },
    withCronHeartbeat(config.id, async ({ step, logger }) => {
      const shops = await step.run("fetch-plan-shops", async () => {
        const db = (await import("../../app/db.server")).default;
        return db.shop.findMany({
          // exclude uninstalled-pending-redact shops (gc-grd)
          where: { plan: config.plan, uninstalledAt: null },
          select: { id: true, domain: true },
        });
      });

      logger.info(`[${config.id}] Fanning out ${shops.length} ${config.plan} shop checks`);
      if (shops.length === 0) return { total: 0, dispatched: 0 };

      await fanOutShopChecks(step, shops);

      logger.info(`[${config.id}] Coordinator complete`, {
        total: shops.length,
        dispatched: shops.length,
      });
      return { total: shops.length, dispatched: shops.length };
    }),
  );
}

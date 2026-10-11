/**
 * Store speed report (gc-wt3y): weekly coordinator + per-shop worker.
 * Professional only, DARK unless SPEED_REPORT_LIVE_ENABLED === "true".
 *
 * Trigger design: its OWN Sunday cron (08:10 UTC), not an event chained off
 * the weekly scan (06:40 UTC). The report measures the live storefront, not
 * the theme scan, so there is no data dependency; a failed or slow theme scan
 * must not cost the merchant their speed report; chaining off scan completion
 * would also fire on every manual and publish-triggered scan and need its own
 * dedupe. 90 minutes later the Sunday scan batch has drained from the shared
 * Inngest slot pool, and the cron gets the dead-man's-switch heartbeat like
 * every other cron.
 *
 * Quota guardrails (PageSpeed: 25,000 calls/day, ~400 per 100 s):
 *   - concurrency 1 across all shops (and 1 per shop), and the calls inside a
 *     run are sequential steps, so a Sunday batch is a slow single file (one
 *     call at a time, each 10-40 s), nowhere near the per-100 s limit;
 *   - each call is its OWN step: Inngest memoizes it, so a retry of a later
 *     step never re-issues a call; runPageSpeedAttempt never throws for a
 *     Google failure, so a call step is not retried either;
 *   - retries: 1 (a DB blip), finish timeout 45 m: a failed run cannot loop;
 *   - the global daily budget is reserved before each call (inside the step);
 *   - a 429 / 4xx / password page / exhausted budget / lost eligibility halts
 *     the rest of the run.
 *   - Manual "Run now" runs get queue priority over the Sunday batch.
 */

import { inngest } from "../client";
import { fanOutInChunks } from "../lib/fan-out";
import { withCronHeartbeat } from "../lib/heartbeat";

// Sunday 08:10 UTC: 90 min after weekly-scan (06:40), off ClearSignal's
// :00/:02/:07 cluster on the shared Inngest account.
export const SPEED_REPORT_CRON = "10 8 * * 0";

export const SPEED_REPORT_WEEKLY_ID = "speed-report-weekly";

export const speedReportWeekly = inngest.createFunction(
  { id: SPEED_REPORT_WEEKLY_ID, name: "Store Speed Report: Professional (Coordinator)" },
  { cron: SPEED_REPORT_CRON },
  withCronHeartbeat(SPEED_REPORT_WEEKLY_ID, async ({ step, logger }) => {
    const { isSpeedReportLive } = await import("../../app/services/speed-report-config.server");
    if (!isSpeedReportLive()) {
      logger.info(`[${SPEED_REPORT_WEEKLY_ID}] dark (SPEED_REPORT_LIVE_ENABLED off), no work`);
      return { total: 0, dispatched: 0, disabled: true };
    }

    const { shops, day } = await step.run("fetch-professional-shops", async () => {
      const db = (await import("../../app/db.server")).default;
      const { PLANS } = await import("../../app/lib/plans");
      const rows = await db.shop.findMany({
        where: { plan: PLANS.PROFESSIONAL, uninstalledAt: null },
        select: { id: true },
      });
      return { shops: rows, day: new Date().toISOString().slice(0, 10) };
    });

    logger.info(`[${SPEED_REPORT_WEEKLY_ID}] Fanning out ${shops.length} speed reports`);
    if (shops.length === 0) return { total: 0, dispatched: 0 };

    await fanOutInChunks(step, shops, "fan-out-speed-reports-chunk", async (chunk) => {
      const { inngest: client } = await import("../client");
      await client.send(
        chunk.map((shop) => ({
          name: "speed-report/requested" as const,
          // Event id = idempotency: a re-sent chunk (or a second coordinator
          // run the same day) cannot start a second report for the shop.
          id: `speed-report-${shop.id}-${day}`,
          data: { shopId: shop.id, origin: "SCHEDULED" as const },
        })),
      );
    });
    return { total: shops.length, dispatched: shops.length };
  }),
);

export const speedReportRun = inngest.createFunction(
  {
    id: "speed-report-run",
    name: "Store Speed Report: Run One Shop",
    retries: 1,
    concurrency: [{ limit: 1 }, { key: "event.data.shopId", limit: 1 }],
    // Seconds of queue priority: a merchant waiting on "Run now" goes ahead of
    // scheduled reports queued up to 10 minutes earlier.
    priority: { run: "event.data.origin == 'MANUAL' ? 600 : 0" },
    timeouts: { finish: "45m" },
  },
  { event: "speed-report/requested" },
  async ({ event, step }) => {
    const svc = await import("../../app/services/speed-report.server");
    const { SPEED_RUNS_PER_PAGE } = await import("../../app/lib/speed-report");
    const { shopId, origin, reportId } = event.data;

    const prep = await step.run("prepare", () =>
      svc.prepareSpeedReportRun({ shopId, origin, reportId }),
    );
    if (!prep.proceed) return { outcome: prep.outcome };

    const resolved = await step.run("resolve-urls", async () => {
      try {
        const { unauthenticated } = await import("../../app/shopify.server");
        const { admin } = await unauthenticated.admin(prep.shopDomain);
        return await svc.resolveSpeedTargets(admin);
      } catch {
        return { ok: false as const };
      }
    });

    const finalizeBase = {
      reportId: prep.reportId,
      shopDomain: prep.shopDomain,
      origin,
      startedAt: prep.startedAt,
    };
    if (!resolved.ok) {
      const result = await step.run("finalize", () =>
        svc.finalizeSpeedReport({ ...finalizeBase, targets: null, tested: [] }),
      );
      return { outcome: result.status };
    }

    const { targets } = resolved;
    const pages: Array<{ page: "home" | "product"; url: string }> = [
      { page: "home", url: targets.homeUrl },
    ];
    if (targets.product.status === "OK") pages.push({ page: "product", url: targets.product.url });

    const tested: Array<{
      page: "home" | "product";
      url: string;
      attempts: Awaited<ReturnType<typeof svc.runPageSpeedAttempt>>[];
    }> = [];
    let halted: Awaited<ReturnType<typeof svc.runPageSpeedAttempt>> | null = null;
    for (const target of pages) {
      const attempts: Awaited<ReturnType<typeof svc.runPageSpeedAttempt>>[] = [];
      tested.push({ ...target, attempts });
      if (halted) continue;
      for (let run = 1; run <= SPEED_RUNS_PER_PAGE; run++) {
        const attempt = await step.run(`psi-${target.page}-${run}`, () =>
          svc.runPageSpeedAttempt({
            shopId,
            page: target.page,
            pageUrl: target.url,
            primaryHost: targets.primaryHost,
            storeHosts: targets.storeHosts,
          }),
        );
        attempts.push(attempt);
        if (svc.attemptHaltsRun(attempt)) {
          halted = attempt;
          break;
        }
        if (svc.attemptHaltsPage(attempt)) break;
      }
    }

    const haltCode = halted ? svc.attemptFailureCode(halted) : undefined;
    const result = await step.run("finalize", () =>
      svc.finalizeSpeedReport({ ...finalizeBase, targets, tested, haltCode }),
    );
    return { outcome: result.status, calls: result.calls };
  },
);

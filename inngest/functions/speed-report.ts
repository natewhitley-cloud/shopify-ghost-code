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
 *     call at a time, typically ~30 s, up to PAGESPEED_TIMEOUT_MS = 240 s on
 *     a heavy storefront), nowhere near the per-100 s limit;
 *   - each call is its OWN step: Inngest memoizes a finished step, so a retry
 *     of a later step does not re-issue it; runPageSpeedAttempt never throws
 *     for a Google failure, so a Google error does not retry the step either.
 *     A call step CAN still repeat if the worker dies after the call but
 *     before its result is recorded (crash, deploy, lost response): with
 *     retries: 1 that is at most one extra call, reserved against the budget
 *     like any other;
 *   - retries: 1 (a DB blip), finish timeout 55 m: a failed run cannot loop.
 *     Without a crash the worst case is 6 calls (2 pages x
 *     SPEED_RUNS_PER_PAGE) x 240 s = 24 m. Retries apply PER STEP, so a worker
 *     crash or deploy mid-call can repeat a 240 s call; 55 m absorbs about
 *     five such repeats and stays below SPEED_REPORT_STUCK_MS (60 m). In practice a timeout ends that page's remaining runs
 *     (attemptHaltsPage), so a slow store spends at most one timeout per page;
 *   - start timeout 6 h: a run still queued that long is cancelled (a manual
 *     click can wait behind the Sunday batch at concurrency 1, so this is
 *     generous; the UI's queued threshold, SPEED_REPORT_QUEUED_STUCK_MS, is
 *     longer still). NOTE: a Sunday batch that needs more than 6 h of worker
 *     time single file would get its tail cancelled; revisit this with the
 *     concurrency when Professional grows;
 *   - a run that dies (onFailure) or is cancelled (speed-report-cancelled, on
 *     Inngest's inngest/function.cancelled: timeouts cancel, they do not fail)
 *     closes its RUNNING report as FAILED and hands a Run-now slot back;
 *   - the global daily budget is reserved before each call (inside the step);
 *   - a password-protected storefront is found BEFORE any call by one
 *     storefront GET (password-check); PageSpeed's final URL / 401 are the
 *     fallback when that read fails;
 *   - a 429 / 4xx / password page / exhausted budget / lost eligibility halts
 *     the rest of the run; a page that cannot load or a timed-out call halts
 *     only that page.
 *   - Manual "Run now" runs and free tests get queue priority over the
 *     Sunday batch.
 *
 * Free speed test (FREE_TEST origin, plans without the report): the same
 * worker, homepage only. No product lookup (Admin or /products.json), no
 * product call; every gate re-checks the plan and that the free test is still
 * unused. The weekly cron stays Professional-only.
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

export const SPEED_REPORT_RUN_ID = "speed-report-run";

/** Inngest's function_id for the worker: "<app id>-<function id>". */
const SPEED_REPORT_RUN_FUNCTION_ID = `ghost-code-${SPEED_REPORT_RUN_ID}`;

export const speedReportRun = inngest.createFunction(
  {
    id: SPEED_REPORT_RUN_ID,
    name: "Store Speed Report: Run One Shop",
    retries: 1,
    concurrency: [{ limit: 1 }, { key: "event.data.shopId", limit: 1 }],
    // Seconds of queue priority: a merchant waiting on "Run now" or a free
    // test goes ahead of scheduled reports queued up to 10 minutes earlier.
    priority: {
      run: "event.data.origin == 'MANUAL' || event.data.origin == 'FREE_TEST' ? 600 : 0",
    },
    timeouts: { start: "6h", finish: "55m" },
    // Retries exhausted: close the report instead of leaving it RUNNING.
    onFailure: async ({ event }) => {
      const svc = await import("../../app/services/speed-report.server");
      const run = svc.abandonedRunFromEvent(event.data.event, event.data.run_id);
      if (run) await svc.closeAbandonedSpeedReport(run, "worker_failed");
    },
  },
  { event: "speed-report/requested" },
  async ({ event, step, runId }) => {
    const svc = await import("../../app/services/speed-report.server");
    const { SPEED_REPORT_ORIGIN, SPEED_RUNS_PER_PAGE } = await import("../../app/lib/speed-report");
    const { shopId, origin, reportId } = event.data;
    // A free test is homepage only, whatever the shop's plan is now.
    const homeOnly = origin === SPEED_REPORT_ORIGIN.FREE_TEST;

    const prep = await step.run("prepare", () =>
      svc.prepareSpeedReportRun({ shopId, origin, reportId, runId }),
    );
    if (!prep.proceed) return { outcome: prep.outcome };

    const resolved = await step.run("resolve-urls", async () => {
      try {
        const { unauthenticated } = await import("../../app/shopify.server");
        const { admin } = await unauthenticated.admin(prep.shopDomain);
        return await svc.resolveSpeedTargets(admin, { homeOnly });
      } catch {
        // No Admin session (offline token gone): not the merchant's address.
        return { ok: false as const, reason: "admin_unavailable" as const };
      }
    });

    const finalizeBase = {
      reportId: prep.reportId,
      shopId,
      shopDomain: prep.shopDomain,
      origin,
      startedAt: prep.startedAt,
    };
    if (!resolved.ok) {
      const result = await step.run("finalize", () =>
        svc.finalizeSpeedReport({
          ...finalizeBase,
          targets: null,
          targetsFailure: resolved.reason,
          tested: [],
        }),
      );
      return { outcome: result.status };
    }

    let { targets } = resolved;
    const pages: Array<{ page: "home" | "product"; url: string }> = [
      { page: "home", url: targets.homeUrl },
    ];
    if (!homeOnly && targets.product.status === "OK") {
      pages.push({ page: "product", url: targets.product.url });
    }

    // Zero-PageSpeed-cost check first: a password page is found without
    // spending (or reserving) a single call.
    const precheck = await step.run("password-check", () =>
      svc.precheckStorefrontPassword({
        shopId,
        origin,
        primaryHost: targets.primaryHost,
        storeHosts: targets.storeHosts,
      }),
    );
    if (precheck === "password") {
      const result = await step.run("finalize", () =>
        svc.finalizeSpeedReport({
          ...finalizeBase,
          targets,
          tested: pages.map((p) => ({ ...p, attempts: [] })),
          passwordProtected: true,
        }),
      );
      return { outcome: result.status, calls: result.calls };
    }

    // No read_products: the product page from the public /products.json
    // (gc-9mbw), only now that the store is known not to be password-protected.
    if (!homeOnly && targets.product.status === "NEEDS_PRODUCT_ACCESS") {
      const product = await step.run("product-fallback", () =>
        svc.resolvePublicProductTarget({
          shopId,
          primaryHost: targets.primaryHost,
          storeHosts: targets.storeHosts,
        }),
      );
      targets = { ...targets, product };
      if (product.status === "OK") pages.push({ page: "product", url: product.url });
    }

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
            origin,
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

/**
 * A speed-report-run cancelled by its start or finish timeout (or by hand)
 * fires no onFailure, only Inngest's inngest/function.cancelled system event:
 * close its report as FAILED/stuck and hand a Run-now slot back.
 */
export const speedReportCancelled = inngest.createFunction(
  { id: "speed-report-cancelled", name: "Store Speed Report: Close Cancelled Run" },
  {
    event: "inngest/function.cancelled",
    if: `event.data.function_id == '${SPEED_REPORT_RUN_FUNCTION_ID}'`,
  },
  async ({ event }) => {
    const svc = await import("../../app/services/speed-report.server");
    // The cancel payload carries the triggering event (not in the SDK's type).
    const original = (event.data as { event?: unknown }).event;
    const run = svc.abandonedRunFromEvent(original, event.data.run_id);
    if (!run) return { closed: false };
    await svc.closeAbandonedSpeedReport(run, "stuck");
    return { closed: true };
  },
);

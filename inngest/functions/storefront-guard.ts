/**
 * Inngest function: storefront-guard (gc-1q1s.5). The checkout guard's ONE
 * hourly cron. DARK unless STOREFRONT_GUARD_LIVE_ENABLED === "true".
 *
 * Shape (spike A2): select the due shops in one step, then check them in
 * GUARD_CHUNK_SIZE chunks, one named step per chunk, GUARD_POOL shops in
 * parallel inside a chunk. NOT one event per shop: Inngest Free meters every
 * run and every step against a 50k/month quota shared by three apps, and a
 * per-shop fan-out would hit it at about 17 paid shops. Batched, the cost is
 * about 720 runs x (run + select + chunks) a month.
 *
 * concurrency 1: an hour that overruns never overlaps the next. A chunk step's
 * worst case is about 60 s (15 shops, pool 5, two 10 s reads each). A thrown
 * chunk retries as a whole, which is safe: a retry re-checks the chunk's
 * shops (at most two more GETs each), and the optimistic-locked state write
 * means no retry can overwrite a newer write.
 *
 * Plan cadence and backoff live in isGuardDue (storefront-guard.server).
 * Telemetry: one structured log line per run with counts by outcome and the
 * run's step count; no per-shop OpsEvent rows (spike A7). The quota
 * tripwire (gc-1q1s.9) writes at most one constant-keyed row a day.
 *
 * Schedule: hourly at :17 (STOREFRONT_GUARD_CRON), clear of :37
 * (monitor-deep-health) and ClearSignal's :02/:07.
 */

import { inngest } from "../client";
import { fanOutInChunks } from "../lib/fan-out";
import { withCronHeartbeat } from "../lib/heartbeat";

export const STOREFRONT_GUARD_CRON = "17 * * * *";
export const STOREFRONT_GUARD_ID = "storefront-guard";
/** Shops per chunk step (tunable; keeps a step under about 60 s). */
export const GUARD_CHUNK_SIZE = 15;
/** Shops checked in parallel inside a chunk. */
export const GUARD_POOL = 5;
/**
 * At most this many shops per run (40 chunks at about 60 s worst case). The
 * rest stay due and go first next hour. Raise with the pool when installs grow.
 */
export const MAX_GUARD_SHOPS_PER_RUN = 600;

/** A due shop as the select step returns it (JSON: the consent time is ISO). */
type DueShop = { id: string; domain: string; plan: string; emailConsentAt: string | null };

export const storefrontGuard = inngest.createFunction(
  {
    id: STOREFRONT_GUARD_ID,
    name: "Checkout Guard: Hourly Storefront Check",
    concurrency: { limit: 1 },
    retries: 1,
  },
  { cron: STOREFRONT_GUARD_CRON },
  withCronHeartbeat(STOREFRONT_GUARD_ID, async ({ step, logger }) => {
    const { isStorefrontGuardLive } = await import("../../app/services/soft-launch-flags.server");
    if (!isStorefrontGuardLive()) {
      logger.info(`[${STOREFRONT_GUARD_ID}] dark (STOREFRONT_GUARD_LIVE_ENABLED off), no work`);
      return { due: 0, disabled: true };
    }

    const { shops, firedAt } = await step.run("select-due-shops", async () => {
      const { listGuardCandidateShops } = await import("../../app/models/storefront-guard.server");
      const { guardEmailConsentAt, isGuardDue } =
        await import("../../app/services/storefront-guard.server");
      const now = new Date();
      const candidates = await listGuardCandidateShops();
      // Never-checked first, then the longest-waiting, capped so one run
      // stays well inside the hour (the first live run makes every shop due).
      const lastChecked = (s: (typeof candidates)[number]) =>
        s.storefrontGuardState?.lastCheckedAt?.getTime() ?? -Infinity;
      const due: DueShop[] = candidates
        .filter((s) => isGuardDue(s, now))
        .sort((a, b) => lastChecked(a) - lastChecked(b))
        .slice(0, MAX_GUARD_SHOPS_PER_RUN)
        .map((s) => ({
          id: s.id,
          domain: s.domain,
          plan: s.plan,
          emailConsentAt: guardEmailConsentAt(s)?.toISOString() ?? null,
        }));
      return { shops: due, firedAt: now.toISOString() };
    });

    if (shops.length === 0) {
      logger.info(`[${STOREFRONT_GUARD_ID}] no shops due`);
      return { due: 0 };
    }

    const chunkResults = await fanOutInChunks(
      step,
      shops,
      "check-chunk",
      async (chunk) => {
        const { checkGuardShop, mapPool } =
          await import("../../app/services/storefront-guard.server");
        const { unauthenticated } = await import("../../app/shopify.server");
        const now = new Date();
        // Stamped with the run's fire time, so a late chunk never makes its
        // shops skip the next hour, and a retried chunk skips what it checked.
        const runAt = new Date(firedAt);
        return mapPool(chunk, GUARD_POOL, (shop) =>
          checkGuardShop(
            shop,
            now,
            { getAdmin: async (domain) => (await unauthenticated.admin(domain)).admin },
            runAt,
          ),
        );
      },
      GUARD_CHUNK_SIZE,
    );

    const results = chunkResults.flat();
    const byOutcome: Record<string, number> = {};
    for (const r of results) {
      const key = r.status === "checked" || r.status === "stale" ? r.outcome : r.status;
      byOutcome[key] = (byOutcome[key] ?? 0) + 1;
    }
    const opened = results.flatMap((r) => (r.status === "checked" ? r.opened : []));

    // Incident email (gc-1q1s.7): one step per shop with an open, not yet
    // emailed KNOWN_MALICIOUS / SCRIPT_LOADER episode on a plan with guard
    // email, for a shop that consented (pre-filtered before any step,
    // gc-1q1s.10), within 24 h of the later of its opening and the consent
    // (checkGuardShop's toEmail), so a failed or throttled send is retried
    // next run. Incidents batched into one email.
    // Only when the email flag is on; sendGuardIncidentEmail re-checks every
    // gate (consent, turn-off, unsubscribe, transport, throttle).
    const { isStorefrontGuardEmailLive } =
      await import("../../app/services/soft-launch-flags.server");
    const emailable = results.flatMap((r) => (r.status === "checked" ? r.toEmail : []));
    const emailed: Record<string, string> = {};
    if (emailable.length > 0 && isStorefrontGuardEmailLive()) {
      const byShop = new Map<string, string[]>();
      for (const o of emailable)
        byShop.set(o.shopId, [...(byShop.get(o.shopId) ?? []), o.incidentId]);
      for (const [shopId, incidentIds] of byShop) {
        const outcome = await step.run(`notify-${shopId}`, async () => {
          const { getGuardEmailShop } = await import("../../app/models/storefront-guard.server");
          const { sendGuardIncidentEmail } =
            await import("../../app/services/storefront-guard-email.server");
          const shop = await getGuardEmailShop(shopId);
          if (!shop) return { sent: false, reason: "shop_not_found" };
          let admin = null;
          try {
            const { unauthenticated } = await import("../../app/shopify.server");
            admin = (await unauthenticated.admin(shop.domain)).admin;
          } catch {
            admin = null; // the cached owner email is used
          }
          return sendGuardIncidentEmail({ shop, incidentIds, admin });
        });
        emailed[shopId] = outcome.reason;
      }
    }
    // Inngest quota tripwire (gc-1q1s.9): project this run's steps over a
    // month of hourly runs; past the threshold, page the operator (at most
    // once a day). Pure arithmetic first, so the alert step (one more step)
    // runs only when the projection is over.
    const quota = await import("../../app/services/storefront-guard-quota.server");
    const runSteps = quota.guardRunSteps({
      chunks: Math.ceil(shops.length / GUARD_CHUNK_SIZE),
      notifySteps: Object.keys(emailed).length,
    });
    const projectedMonthlySteps = quota.projectGuardMonthlySteps(runSteps);
    const stepAlert = quota.guardMonthlyStepAlert();
    if (projectedMonthlySteps > stepAlert) {
      await step.run("quota-alert", () =>
        quota.alertGuardQuotaOnce({
          projected: projectedMonthlySteps,
          threshold: stepAlert,
          runSteps,
          due: shops.length,
          now: new Date(),
        }),
      );
    }
    logger.info(`[${STOREFRONT_GUARD_ID}] run complete`, {
      event: "storefront_guard_run",
      firedAt,
      due: shops.length,
      byOutcome,
      opened: opened.length,
      emailed,
      runSteps,
      projectedMonthlySteps,
    });
    return { due: shops.length, byOutcome, opened: opened.length, emailed };
  }),
);

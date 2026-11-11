/**
 * Inngest function: clean-copy (gc-tib slice 4)
 *
 * Trigger: `clean-copy/requested` { shopId, fixRunId }, sent by
 * requestCleanCopy after preflight created the FixRun. Gated by
 * CLEAN_COPY_ENABLED (default off): flag off = the run is failed FLAG_OFF
 * before any Admin call.
 *
 * Steps (at most 17 per run, sleeps included; Inngest budget is tight, no crons):
 *   load            run exists, belongs to the shop, still active
 *   duplicate       duplicate MAIN once, or adopt the copy a crashed attempt
 *                   made (by its unique name); skipped when copyThemeId is set
 *   check-copy-N    poll processing, with step.sleep between checks
 *                   (COPY_POLL_WAITS); the last check fails DUPLICATE_TIMEOUT
 *   write           per-file drift guard, splice, one upsert, job poll,
 *                   post-read (clean-copy.server writeCleanCopy)
 *   finalize        completed / partial / failed (pending items -> INCOMPLETE)
 *
 * We never call themePublish (spike D2), and the Admin adapter refuses any
 * write whose target is not an UNPUBLISHED theme other than the source.
 *
 * Failures: a run-ending problem is recorded on the run by the service and
 * ends the function cleanly; ACCESS_DENIED (scope or exemption missing)
 * throws NonRetriableError so Inngest never retries it. Transient errors
 * retry the step (every step is safe to re-run). onFailure marks a run that
 * is still active as failed, so nothing stays "in progress" forever.
 */

import { NonRetriableError } from "inngest";

import { logger } from "../../app/lib/logger.server";
import { inngest } from "../client";

/** Waits between copy-processing checks (the copy is polled WAITS + 1 times, ~7 min). */
export const COPY_POLL_WAITS = ["10s", "20s", "30s", "60s", "120s", "180s"] as const;

type Admin = import("../../app/services/clean-copy-admin.server").CleanCopyAdmin;

async function withAdmin<T>(shopId: string, fn: (admin: Admin) => Promise<T>): Promise<T> {
  const db = (await import("../../app/db.server")).default;
  const shop = await db.shop.findUnique({ where: { id: shopId }, select: { domain: true } });
  if (!shop) throw new NonRetriableError(`Shop ${shopId} not found`);
  const { unauthenticated } = await import("../../app/shopify.server");
  const { admin } = await unauthenticated.admin(shop.domain);
  const { createCleanCopyAdmin } = await import("../../app/services/clean-copy-admin.server");
  return fn(createCleanCopyAdmin(admin));
}

/**
 * Run a service call; a CleanCopyFailure (run already marked failed) becomes
 * `{ stopped: reason }`, except ACCESS_DENIED, which must not be retried.
 */
async function guarded<T>(
  fixRunId: string,
  fn: () => Promise<T>,
): Promise<T | { stopped: string }> {
  const { CleanCopyFailure } = await import("../../app/services/clean-copy.server");
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof CleanCopyFailure)) throw err;
    logger.warn("clean-copy run stopped", { function: "clean-copy", fixRunId, reason: err.reason });
    if (err.reason === "ACCESS_DENIED") {
      throw new NonRetriableError("clean copy: ACCESS_DENIED (write_themes or exemption missing)");
    }
    return { stopped: err.reason };
  }
}

const isStopped = (v: unknown): v is { stopped: string } =>
  typeof v === "object" && v !== null && "stopped" in v;
const isSkipped = (v: unknown): boolean =>
  v === "skipped" || (typeof v === "object" && v !== null && "skipped" in v);

export const cleanCopy = inngest.createFunction(
  {
    id: "clean-copy",
    name: "Clean copy: remove selected leftover code in a theme copy",
    retries: 3,
    // One run per shop at a time, and one account-wide: the Inngest Hobby pool
    // (5 concurrent steps) is SHARED with scan-theme (limit 3) and the sibling
    // apps, so this stays at 1 to leave headroom for crons.
    concurrency: [{ key: "event.data.shopId", limit: 1 }, { limit: 1 }],
    onFailure: async ({ event, error }) => {
      const { fixRunId } = event.data.event.data;
      const { markDoNotPublishIfWritten, markFixRunFailed } =
        await import("../../app/models/fix-run.server");
      const reason =
        // The error arrives deserialized: match the message, not the class.
        /ACCESS_DENIED/.test(String((error as { message?: unknown })?.message ?? ""))
          ? "ACCESS_DENIED"
          : "INTERNAL_ERROR";
      // Conditional: a run the service already failed keeps its own reason.
      await markFixRunFailed(fixRunId, reason);
      await (
        await import("../../app/db.server")
      ).default.fixItem.updateMany({
        where: { fixRunId, status: "pending" },
        data: { status: "failed", reasonCode: reason },
      });
      // A write may have landed unverified before the crash (audit M-d).
      await markDoNotPublishIfWritten(fixRunId);
    },
  },
  { event: "clean-copy/requested" },
  async ({ event, step }) => {
    const { shopId, fixRunId } = event.data;

    const loaded = await step.run("load", async () => {
      const { runGateFailure } = await import("../../app/services/clean-copy.server");
      const { getFixRunWithItems, markFixRunFailed, ACTIVE_FIX_RUN_STATUSES } =
        await import("../../app/models/fix-run.server");
      const run = await getFixRunWithItems(fixRunId);
      if (!run || run.shopId !== shopId) return { proceed: false, why: "not_found" };
      if (!(ACTIVE_FIX_RUN_STATUSES as readonly string[]).includes(run.status)) {
        return { proceed: false, why: "not_active" };
      }
      // Flag still on, shop still on Professional (audit logic 11).
      const gate = await runGateFailure(run);
      if (gate) {
        await markFixRunFailed(fixRunId, gate);
        const db = (await import("../../app/db.server")).default;
        await db.fixItem.updateMany({
          where: { fixRunId, status: "pending" },
          data: { status: "failed", reasonCode: gate },
        });
        return { proceed: false, why: gate === "FLAG_OFF" ? "flag_off" : "not_professional" };
      }
      return { proceed: true, why: null };
    });
    if (!loaded.proceed) return { fixRunId, outcome: loaded.why };

    const dup = await step.run("duplicate", () =>
      withAdmin(shopId, async (admin) => {
        const { ensureCopyTheme } = await import("../../app/services/clean-copy.server");
        return guarded(fixRunId, () => ensureCopyTheme(admin, fixRunId));
      }),
    );
    if (isStopped(dup)) return { fixRunId, outcome: dup.stopped };
    if (isSkipped(dup) || !("copyThemeId" in dup)) return { fixRunId, outcome: "not_active" };
    const { copyThemeId } = dup;

    for (let i = 0; i <= COPY_POLL_WAITS.length; i++) {
      const final = i === COPY_POLL_WAITS.length;
      const check = await step.run(`check-copy-${i}`, () =>
        withAdmin(shopId, async (admin) => {
          const { checkCopyReady } = await import("../../app/services/clean-copy.server");
          return guarded(fixRunId, () => checkCopyReady(admin, fixRunId, copyThemeId, final));
        }),
      );
      if (isStopped(check)) return { fixRunId, outcome: check.stopped };
      if (isSkipped(check)) return { fixRunId, outcome: "not_active" };
      if (check === "ready") break;
      await step.sleep(`wait-copy-${i}`, COPY_POLL_WAITS[i]);
    }

    const written = await step.run("write", () =>
      withAdmin(shopId, async (admin) => {
        const { writeCleanCopy } = await import("../../app/services/clean-copy.server");
        return guarded(fixRunId, () => writeCleanCopy(admin, fixRunId));
      }),
    );
    if (isStopped(written)) return { fixRunId, outcome: written.stopped };
    if (isSkipped(written)) return { fixRunId, outcome: "not_active" };

    const final = await step.run("finalize", async () => {
      const { finalizeFixRun } = await import("../../app/models/fix-run.server");
      return finalizeFixRun(fixRunId);
    });
    return { fixRunId, outcome: final?.status ?? "not_active" };
  },
);

/**
 * Periodic install-status reconciler (gc-dyt).
 *
 * A daily backstop for MISSED `app/uninstalled` webhooks. That webhook is
 * unreliable: shops that uninstalled weeks ago can still carry
 * `uninstalledAt = null` and intact Session rows because the handler never ran,
 * so the operator digest over-counts churned shops as active. This cron
 * authoritatively re-checks every ACTIVE shop against the Shopify Admin API and
 * marks the ones whose access token has been revoked (the definitive uninstall
 * signal), independent of the webhook.
 *
 * SAFETY RULE (this file can churn a live paying merchant if wrong):
 *   A shop is marked uninstalled ONLY on one of two DEFINITIVE uninstall signals:
 *     (a) a 401 / revoked-token error from the Admin GraphQL probe — surfaced when
 *         the offline token is NOT yet expired but has been revoked; and
 *     (b) a REJECTED offline-token refresh surfaced by unauthenticated.admin —
 *         because `future.expiringOfflineAccessTokens` is on, expired tokens are
 *         refreshed BEFORE the admin client is returned, and Shopify rejects the
 *         refresh (InvalidJwtError, or an HttpResponseError 400 with
 *         body.error === 'invalid_subject_token') exactly when the app is no
 *         longer installed. This is the COMMON case once the daily cron runs
 *         after the token TTL, so it must be treated as an uninstall, not skipped.
 *   EVERYTHING else — throttling (429 / THROTTLED), network errors, timeouts, 5xx
 *   (including the library's `new Response(500)` refresh wrapper), a missing
 *   session (SessionNotFoundError), or any ambiguous/unexpected error — is treated
 *   as "status unknown" and the shop is SKIPPED this run (never marked). When in
 *   doubt, do NOT mark. This mirrors the ACCESS_DENIED-vs-transient discipline in
 *   app/lib/scope-check.server.ts.
 *
 * SCOPE: this job ONLY detects + marks uninstalled (reusing the shared
 * markShopUninstalledWithEvent path so the webhook and this reconciler can't
 * drift). It does NOT redact/delete shop data — a marked-uninstalled shop still
 * needs redaction, which stays with shop/redact (48h grace) + the separate
 * gc-qkd cleanup. That residual is a known, separately-tracked gap.
 *
 * Cron: 6:00 AM America/Denver, one hour BEFORE the 7:00 AM operator-digest, so
 * the digest reflects any shop this run freshly marked (the digest counts
 * uninstalls from the SHOP_UNINSTALLED OpsEvent stream, which this run writes).
 * Wrapped in withCronHeartbeat so it participates in the dead-man's-switch
 * (registered in CRON_HEARTBEAT_EXPECTATIONS).
 */

import { HttpResponseError, InvalidJwtError } from "@shopify/shopify-api";

import { logger } from "../../app/lib/logger.server";
import { inngest } from "../client";
import { withCronHeartbeat } from "../lib/heartbeat";

// The heartbeat key + the constant key for the per-run summary OpsEvent. Both
// intentionally equal the Inngest function id.
export const RECONCILE_INSTALLS_KEY = "reconcile-installs";

// Pause between per-shop probes so a large active set can't hammer the Admin API
// (an Inngest duration string). N is ~10 today; a `{ shop { name } }` probe costs
// ~1 point against the 50 pt/s budget, so this is defensive headroom for growth.
// step.sleep is a no-op under the test step mock, so tests stay fast.
const PAUSE_BETWEEN_SHOPS = "500ms";

/** Result of probing one shop's install status. */
export type InstallStatus = "installed" | "uninstalled" | "ambiguous";

// ---------------------------------------------------------------------------
// Pure classification (exported for unit testing; no Prisma/Shopify/IO)
// ---------------------------------------------------------------------------

/**
 * Shopify's classic revoked/invalid-token wording, surfaced on a thrown error's
 * message when the structured HTTP status isn't available. Deliberately narrow:
 * it must NOT match throttling ("Throttled" / 429), 5xx, or network errors.
 */
const REVOKED_TOKEN_MESSAGE =
  /invalid api key or access token|unrecognized login|(access token|api token)\b.{0,30}(invalid|revoked|expired)|401 unauthorized/i;

/**
 * Best-effort HTTP status extraction from a thrown Shopify client error. The
 * @shopify/shopify-api client throws HttpResponseError (and its throttling /
 * retriable subclasses) with the status on `err.response.code`; other clients
 * use `status` / `statusCode`. Returns null when no numeric status is present.
 */
export function extractHttpStatus(error: unknown): number | null {
  if (error === null || typeof error !== "object") return null;
  const e = error as Record<string, unknown>;
  const response = e.response as Record<string, unknown> | undefined;
  if (response && typeof response.code === "number") return response.code;
  for (const key of ["status", "statusCode"] as const) {
    const v = e[key];
    if (typeof v === "number") return v;
  }
  return null;
}

/**
 * DEFINITIVE auth failure = positive proof the access token is revoked (the app
 * was uninstalled). True ONLY for an HTTP 401, or a message that explicitly names
 * an invalid/revoked token or a "401 Unauthorized". Conservative by design:
 * anything not provably a 401 returns false, so a throttle (429), 5xx, network
 * error, or unexpected error can NEVER be mistaken for an uninstall.
 */
export function isDefinitiveAuthFailure(error: unknown): boolean {
  if (extractHttpStatus(error) === 401) return true;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return REVOKED_TOKEN_MESSAGE.test(message);
}

/**
 * DEFINITIVE uninstall signal surfaced by `unauthenticated.admin` itself (before
 * any GraphQL call). Because `future.expiringOfflineAccessTokens` is enabled, the
 * library refreshes an expired offline token inside `unauthenticated.admin`; when
 * the app has been uninstalled, Shopify REJECTS that refresh and the library
 * re-throws the rejection. True ONLY for those definitive rejections:
 *   - an InvalidJwtError, OR
 *   - an HttpResponseError whose response is a 400 with body.error ===
 *     'invalid_subject_token'.
 * Everything else the library can throw here — its `new Response(500)` transient
 * wrapper, a SessionNotFoundError, network errors, or anything unexpected — is
 * NOT a definitive signal and returns false (SKIP, never mark). Defensive about
 * the `response.body` shape (may be a string or object) and never throws.
 */
export function isRefreshTokenRejected(error: unknown): boolean {
  if (error instanceof InvalidJwtError) return true;
  if (error instanceof HttpResponseError) {
    const response = error.response as { code?: unknown; body?: unknown } | undefined;
    if (!response || response.code !== 400) return false;
    const body = response.body;
    if (body !== null && typeof body === "object") {
      return (body as Record<string, unknown>).error === "invalid_subject_token";
    }
    return false;
  }
  return false;
}

/**
 * Classify a probe that RETURNED (did not throw), from its HTTP status:
 *   - 401                 → uninstalled. Defensive/not currently reachable: the
 *     @shopify/shopify-api client THROWS on an auth failure (handled by
 *     isDefinitiveAuthFailure in the catch) rather than returning a 401 here.
 *     Retained so a client that ever surfaces a returned 401 is still classified.
 *   - 200 / no status     → installed (a successful round-trip means the token works)
 *   - anything else (429, 5xx, ...) → ambiguous (transient; never proof of uninstall)
 */
export function classifyResponseStatus(status: number | undefined): InstallStatus {
  if (status === 401) return "uninstalled";
  if (status === undefined || status === 200) return "installed";
  return "ambiguous";
}

// ---------------------------------------------------------------------------
// Per-shop probe + mark (I/O; runs inside a step)
// ---------------------------------------------------------------------------

/** Mark a shop uninstalled via the SHARED path (records event + revokes access). */
async function markUninstalled(domain: string): Promise<void> {
  const { markShopUninstalledWithEvent } = await import("../../app/models/shop.server");
  const { newlyMarked } = await markShopUninstalledWithEvent(domain, {
    source: "reconciler",
    message: "reconciler-detected uninstall (missed app/uninstalled webhook)",
  });
  // NOTE (known gap): this only detects + marks. Redaction of the shop's data
  // still flows through shop/redact (48h grace) + gc-qkd cleanup, not here.
  // newlyMarked=false means this shop was already uninstalled (e.g. a step retry
  // after a successful mark): idempotent no-op, no duplicate SHOP_UNINSTALLED
  // event. The probe still classifies "uninstalled" upstream either way.
  logger.warn("reconcile-installs: marked shop uninstalled", {
    function: "reconcile-installs",
    domain,
    newlyMarked,
  });
}

/**
 * Probe one shop's install status via the SAME auth path background jobs use
 * (unauthenticated.admin → one cheap Admin GraphQL call) and mark it uninstalled
 * IFF the probe is a definitive auth failure. Returns the classification so the
 * caller can tally the run. NEVER marks on a transient/ambiguous outcome.
 */
async function checkAndMarkInstall(domain: string): Promise<InstallStatus> {
  const { unauthenticated } = await import("../../app/shopify.server");

  let adminCtx: { admin: { graphql: (q: string) => Promise<{ status?: number }> } };
  try {
    adminCtx = await unauthenticated.admin(domain);
  } catch (err) {
    // With `future.expiringOfflineAccessTokens` on, an expired offline token is
    // refreshed INSIDE unauthenticated.admin. A REJECTED refresh
    // (invalid_subject_token / InvalidJwtError) is positive proof the app is no
    // longer installed — the definitive uninstall signal for an already-expired
    // token, and the common case once the daily cron runs after the TTL. Mark it.
    if (isRefreshTokenRejected(err)) {
      await markUninstalled(domain);
      return "uninstalled";
    }
    // Anything else here is AMBIGUOUS by design: a missing Session row
    // (SessionNotFoundError), the library's `new Response(500)` transient refresh
    // wrapper, a session-storage read, or a race is NOT positive proof of an
    // uninstall. The safety rule is to mark ONLY on a definitive signal. Skip.
    logger.info("reconcile-installs: no admin context — skipping (ambiguous)", {
      function: "reconcile-installs",
      domain,
      reason: err instanceof Error ? err.message : String(err),
    });
    return "ambiguous";
  }

  const { admin } = adminCtx;

  try {
    // Cheapest possible authenticated probe: shop.name needs no optional scope.
    const response = await admin.graphql("{ shop { name } }");
    const status = classifyResponseStatus(
      typeof response?.status === "number" ? response.status : undefined,
    );
    if (status === "uninstalled") {
      await markUninstalled(domain);
    } else if (status === "ambiguous") {
      logger.info("reconcile-installs: non-200 response — skipping (ambiguous)", {
        function: "reconcile-installs",
        domain,
        httpStatus: response?.status,
      });
    }
    return status;
  } catch (err) {
    if (isDefinitiveAuthFailure(err)) {
      await markUninstalled(domain);
      return "uninstalled";
    }
    // THROTTLED (429), network, timeout, 5xx, or any unexpected error: status
    // unknown → SKIP this shop this run. Never mark on a non-definitive error.
    logger.info("reconcile-installs: transient/ambiguous probe error — skipping", {
      function: "reconcile-installs",
      domain,
      httpStatus: extractHttpStatus(err),
      reason: err instanceof Error ? err.message : String(err),
    });
    return "ambiguous";
  }
}

// ---------------------------------------------------------------------------
// Inngest function
// ---------------------------------------------------------------------------

export const reconcileInstalls = inngest.createFunction(
  { id: "reconcile-installs", name: "Periodic Install-Status Reconciler" },
  { cron: "TZ=America/Denver 0 6 * * *" },
  withCronHeartbeat(RECONCILE_INSTALLS_KEY, async ({ step }) => {
    // Load every ACTIVE shop (uninstalledAt IS NULL). Only id/domain are needed.
    // FUTURE (as N grows): re-check only shops not verified recently (e.g. track
    // a lastReconciledAt) to cut API calls — implement the simple "check all
    // active" version now.
    const shops = (await step.run("get-active-shops", async () => {
      const db = (await import("../../app/db.server")).default;
      return db.shop.findMany({
        where: { uninstalledAt: null },
        select: { id: true, domain: true },
      });
    })) as Array<{ id: string; domain: string }>;

    let marked = 0;
    let skipped = 0;
    for (let i = 0; i < shops.length; i++) {
      // One step per shop so a mid-run failure/retry resumes without re-probing
      // completed shops. Marking is idempotent (updateMany), so a retry is safe.
      const outcome = (await step.run(`check-shop-${i}`, () =>
        checkAndMarkInstall(shops[i].domain),
      )) as InstallStatus;
      if (outcome === "uninstalled") marked += 1;
      else if (outcome === "ambiguous") skipped += 1;

      // Brief pause between shops (skipped after the last) — rate-limit headroom.
      if (i < shops.length - 1) {
        await step.sleep(`pause-${i}`, PAUSE_BETWEEN_SHOPS);
      }
    }

    const checked = shops.length;

    // One counts-only summary row for observability (no per-shop rows, no domains
    // — keyed on a constant so it needs no per-shop redaction; see OPS_EVENT_TYPES).
    await step.run("record-summary", async () => {
      const { recordOpsEvent, OPS_EVENT_TYPES } = await import("../../app/models/ops-event.server");
      await recordOpsEvent({
        eventType: OPS_EVENT_TYPES.RECONCILE_SUMMARY,
        key: RECONCILE_INSTALLS_KEY,
        message: `reconcile: checked ${checked}, marked ${marked}, skipped-transient ${skipped}`,
        metadata: { checked, marked, skipped },
      });
    });

    logger.info("reconcile-installs: run complete", {
      function: "reconcile-installs",
      checked,
      marked,
      skipped,
    });

    return { status: "completed", checked, marked, skipped };
  }),
);

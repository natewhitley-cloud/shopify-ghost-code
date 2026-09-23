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
 *   A shop is marked uninstalled ONLY on one of three DEFINITIVE uninstall signals:
 *     (a) a 401 / revoked-token error from the Admin GraphQL probe — surfaced when
 *         the offline token is NOT yet expired but has been revoked;
 *     (b) a REJECTED offline-token refresh surfaced by unauthenticated.admin —
 *         because `future.expiringOfflineAccessTokens` is on, expired tokens are
 *         refreshed BEFORE the admin client is returned, and Shopify rejects the
 *         refresh (InvalidJwtError, or an HttpResponseError 400 with
 *         body.error === 'invalid_subject_token') exactly when the app is no
 *         longer installed. This is the COMMON case once the daily cron runs
 *         after the token TTL, so it must be treated as an uninstall, not skipped;
 *         and
 *     (c) a RAW-refresh rejection whose BODY proves it is shop-specific, in the
 *         disambiguation path. The library's `refreshToken` helper MASKS most
 *         refresh failures as a generic `new Response(500)` wrapper, so a genuine
 *         "requires an active refresh_token" 401 (or a 404 for a closed store)
 *         never reaches signal (b). When unauthenticated.admin fails with such a
 *         masked/non-definitive error, rawRefreshProbe() re-issues the refresh
 *         directly and classifyRefreshRejection() reads Shopify's REAL status AND
 *         body: a 404 (store gone) marks; a 401/400 marks ONLY when the body names
 *         a refresh-token/subject rejection (invalid_grant / invalid_subject_token
 *         / invalid_request+"refresh_token"). A CREDENTIAL error (invalid_client,
 *         or an unrecognized/absent body) is AMBIGUOUS and NEVER marks — the raw
 *         endpoint uses the SHARED client_id/client_secret, so a wrong secret
 *         would otherwise 400/401 every shop into a mass churn.
 *
 *   CIRCUIT BREAKER (defense-in-depth): the cron runs in two passes — probe all
 *   active shops (mark nothing), then mark them ONLY if the run does not look
 *   systemic. The run ABORTS when ALL probed shops are marked (100% churn, at ANY
 *   base size), OR when marks reach >=50% of the probed base (minimum CB_MIN_MARKS).
 *   This can no longer be silently bypassed at small base sizes. On a trip the run marks
 *   NOTHING, records a RECONCILE_ABORTED OpsEvent, and pages the operator —
 *   turning a would-be base-wide churn into one skipped run + an alert.
 *   A RAW-refresh 200 means the app is STILL INSTALLED; Shopify ROTATES the
 *   offline refresh token on that success, so rawRefreshProbe stores the rotated
 *   session and the shop is treated as installed (never marked).
 *   EVERYTHING else — throttling (429 / THROTTLED), network errors, timeouts, 5xx
 *   (including the library's `new Response(500)` refresh wrapper AND a raw-refresh
 *   5xx), a missing session (SessionNotFoundError), or any ambiguous/unexpected
 *   error — is treated as "status unknown" and the shop is SKIPPED this run (never
 *   marked). When in doubt, do NOT mark. This mirrors the ACCESS_DENIED-vs-transient
 *   discipline in app/lib/scope-check.server.ts.
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

// Run-level circuit breaker (gc-5ha). Defense-in-depth on top of body-aware
// classification: even if a systemic fault (e.g. a wrong shared client_secret)
// produced varied per-shop rejections that slipped past the body checks, a
// SINGLE run must never be able to churn the whole active base. The reconciler
// aborts a run — marking NOTHING and paging the operator — when it WOULD mark
// ALL probed shops (100% churn, at ANY base size), OR when the number it WOULD
// mark reaches >=50% of the probed base (floor CB_MIN_MARKS). The fraction is
// PRIMARY (it protects a large base); the all-probed-marked rule guarantees a
// systemic 100%-churn always trips even at N=1/N=2 — the old MAX(absolute-cap,
// fraction) form pinned the threshold at the cap and could be silently bypassed
// when checked <= the cap.
// Tune conservatively: a genuine day never churns anywhere near half the base at
// once, so a trip is a near-certain bug.
const CB_FRACTION = 0.5; // trip when >= half the probed base is marked in one run
const CB_MIN_MARKS = 3; // ordinary-churn floor: fewer than this never trips

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
 * Read a string field off a possibly-malformed JSON body without throwing. The
 * body may be an object, a raw string, null, or missing the field entirely
 * (Shopify's OAuth error bodies are objects, but a proxy/edge can substitute an
 * HTML/text error page). Returns the string value or null.
 */
function bodyStringField(body: unknown, field: string): string | null {
  if (body === null || typeof body !== "object") return null;
  const v = (body as Record<string, unknown>)[field];
  return typeof v === "string" ? v : null;
}

/**
 * Classify a RAW-refresh rejection (a non-200 from POST /admin/oauth/access_token)
 * as either a shop-specific uninstall or an AMBIGUOUS/our-side problem, from the
 * HTTP status AND the response body. This is the mass-churn guard: the refresh
 * endpoint authenticates with the SHARED client_id/client_secret, so a wrong /
 * unset / rotated-without-updating-env secret makes Shopify reject EVERY shop
 * with a 400/401 `invalid_client`. Marking on a bare status would churn the whole
 * active base in one run; we mark ONLY when the body positively identifies a
 * refresh-token / subject problem (shop-specific), never a credential problem.
 *
 *   - 404 → "uninstalled": the store is gone (shop-specific, not credential-wide;
 *     a bad client secret does not turn every store into a 404).
 *   - 401 / 400 → parse the body; "uninstalled" ONLY on a positive refresh-token /
 *     subject rejection:
 *       • error === "invalid_grant"          (refresh token revoked/invalid), OR
 *       • error === "invalid_subject_token"  (token-exchange subject rejected), OR
 *       • error === "invalid_request" AND error_description matches /refresh.?token/i
 *         (covers Shopify's "...requires an active refresh_token").
 *     Anything else — error === "invalid_client" (OUR credential problem), or an
 *     unrecognized / absent / non-object error body — is "ambiguous" (NEVER mark;
 *     that's our misconfig, not their uninstall).
 *   - anything else (5xx, unexpected status) → "ambiguous" (transient/unknown).
 *
 * Defensive: `body` may be an object, a raw string, null, or missing `error` —
 * never throws.
 */
export function classifyRefreshRejection(
  status: number,
  body: unknown,
): "uninstalled" | "ambiguous" {
  if (status === 404) return "uninstalled";
  if (status === 401 || status === 400) {
    const error = bodyStringField(body, "error");
    if (error === "invalid_grant" || error === "invalid_subject_token") return "uninstalled";
    if (error === "invalid_request") {
      const description = bodyStringField(body, "error_description");
      if (description !== null && /refresh.?token/i.test(description)) return "uninstalled";
    }
    // invalid_client / unrecognized / absent error → OUR-side or unknown → never mark.
    return "ambiguous";
  }
  // 5xx or any other status: transient/unknown → never mark.
  return "ambiguous";
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

/**
 * A shop domain as our own storage normalizes it: lowercase, `*.myshopify.com`,
 * no scheme/path/port. Deliberately case-SENSITIVE (no lowercasing before the
 * match) — every domain we write to the Shop table already comes out of this
 * shape, so a domain arriving with uppercase characters is unexpected input,
 * not a legitimate variant to normalize away. Silently lowercasing it here
 * would let a caller-supplied domain we've never validated end up dictating
 * the host `rawRefreshProbe` sends the shared client_secret to.
 */
const MYSHOPIFY_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/** True for a well-formed `*.myshopify.com` domain (see MYSHOPIFY_DOMAIN_PATTERN). */
export function isValidMyshopifyDomain(domain: string): boolean {
  return MYSHOPIFY_DOMAIN_PATTERN.test(domain);
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
 * RAW offline-token refresh probe — the disambiguator for a MASKED
 * unauthenticated.admin failure, and the ONLY code path that reaches it.
 *
 * WHY THIS EXISTS: the library's `refreshToken` helper wraps ANY refresh failure
 * that is not `invalid_subject_token` as a generic `new Response(500)`. So the
 * common expired-token uninstall — Shopify replying HTTP 401
 * `{error:"invalid_request", "requires an active refresh_token"}` (or 404 for a
 * closed store) — is masked as a 500 and never matches isRefreshTokenRejected.
 * This probe re-issues the refresh directly against Shopify and reads the REAL
 * status, so a genuine uninstall isn't misclassified "ambiguous" and skipped.
 *
 * ROTATION-STORE INVARIANT (do not remove): Shopify ROTATES the offline refresh
 * token on a SUCCESSFUL (HTTP 200) refresh — the response body carries a fresh
 * `refresh_token`, and the library's create-session.js persists it. Because this
 * probe issues that refresh itself, on a 200 it MUST write the rotated tokens
 * back to session storage. If it doesn't, the stored refresh_token is now stale
 * and a LATER reconciler run would get a definitive rejection and FALSE-CHURN a
 * live, still-installed merchant. A store failure must NOT churn: on a 200 we
 * always return "installed" even if storeSession throws.
 *
 * Status mapping (via classifyRefreshRejection for non-200): 200 → installed
 * (rotated session stored); 404 → uninstalled (store gone); 401/400 → uninstalled
 * ONLY if the body positively names a refresh-token/subject rejection
 * (invalid_grant / invalid_subject_token / invalid_request+"refresh_token"),
 * else ambiguous (invalid_client and unrecognized/absent bodies = OUR credential
 * problem, NEVER mark); no session or no refreshToken → ambiguous (can't probe);
 * network throw or any other status (5xx, ...) → ambiguous. Never marks; the
 * caller marks on "uninstalled".
 *
 * DOMAIN GUARD: `domain` comes off the Shop row, and this probe POSTs the
 * shared `client_secret` to `https://${domain}/...`. Before any fetch,
 * `domain` must match MYSHOPIFY_DOMAIN_PATTERN — a mismatch (a non-Shopify
 * host, or a lookalike such as `shop.myshopify.com.evil.com`) means the row is
 * corrupt or hostile, so the probe skips the request entirely (ambiguous)
 * rather than ever sending our credential to an arbitrary host.
 */
async function rawRefreshProbe(domain: string): Promise<InstallStatus> {
  if (!isValidMyshopifyDomain(domain)) {
    // Log `domain` as a STRUCTURED field (JSON-encoded by the logger, so it is
    // safe from log injection) — otherwise a corrupt row is untraceable while
    // it adds +1 to `skipped` every run. The caller's logs already carry
    // `domain`. No secret is logged here regardless of outcome.
    logger.warn("reconcile-installs: raw refresh probe — domain failed validation, skipping", {
      function: "reconcile-installs",
      domain,
    });
    return "ambiguous";
  }

  const { sessionStorage } = await import("../../app/shopify.server");

  const session = await sessionStorage.loadSession(`offline_${domain}`);
  if (!session || !session.refreshToken) {
    logger.info(
      "reconcile-installs: raw refresh probe — no session/refreshToken, skipping (ambiguous)",
      {
        function: "reconcile-installs",
        domain,
      },
    );
    return "ambiguous";
  }

  let res: Response;
  try {
    res = await fetch(`https://${domain}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_API_KEY,
        client_secret: process.env.SHOPIFY_API_SECRET,
        refresh_token: session.refreshToken,
        grant_type: "refresh_token",
      }),
    });
  } catch (err) {
    // Network / fetch throw: status unknown → never mark.
    logger.info("reconcile-installs: raw refresh probe network error — skipping (ambiguous)", {
      function: "reconcile-installs",
      domain,
      reason: err instanceof Error ? err.message : String(err),
    });
    return "ambiguous";
  }

  const status = res.status;

  if (status === 200) {
    // STILL INSTALLED. Persist the rotated session BEFORE returning so a later
    // run can't false-churn this shop on a now-stale stored refresh_token.
    try {
      const body = (await res.json()) as {
        access_token?: string;
        expires_in?: number;
        refresh_token?: string;
        refresh_token_expires_in?: number;
        scope?: string;
      };
      if (typeof body.access_token === "string") session.accessToken = body.access_token;
      if (typeof body.expires_in === "number") {
        session.expires = new Date(Date.now() + body.expires_in * 1000);
      }
      const hasRefreshToken = typeof body.refresh_token === "string";
      const hasRefreshExpiry = typeof body.refresh_token_expires_in === "number";
      // A well-formed 200 carries BOTH the rotated refresh_token and its expiry, or
      // NEITHER. One without the other is a signature we don't recognise — surface
      // it (a stale refresh_token could otherwise be silently retained), but do NOT
      // change the store rule: still only rotate when both are present.
      if (hasRefreshToken !== hasRefreshExpiry) {
        logger.warn(
          "reconcile-installs: raw refresh probe 200 with unexpected refresh response shape (refresh_token/expiry present without its pair) — not rotating",
          {
            function: "reconcile-installs",
            domain,
            hasRefreshToken,
            hasRefreshExpiry,
          },
        );
      }
      if (hasRefreshToken && hasRefreshExpiry) {
        session.refreshToken = body.refresh_token!;
        session.refreshTokenExpires = new Date(Date.now() + body.refresh_token_expires_in! * 1000);
      }
      if (typeof body.scope === "string") session.scope = body.scope;
      await sessionStorage.storeSession(session);
      logger.info("reconcile-installs: raw refresh probe 200 — installed, rotated session stored", {
        function: "reconcile-installs",
        domain,
        status,
      });
    } catch (err) {
      // A store (or body-parse) failure must NEVER cause a churn: the app IS
      // installed (Shopify returned 200). Log and still return installed.
      logger.error(
        "reconcile-installs: raw refresh probe 200 but storing rotated session failed — treating as installed (never mark)",
        {
          function: "reconcile-installs",
          domain,
          reason: err instanceof Error ? err.message : String(err),
        },
      );
    }
    return "installed";
  }

  // Non-200: read the body and classify. Marking "uninstalled" requires a
  // shop-specific signal (404, or a refresh-token/subject rejection in the body).
  // A credential-wide error (invalid_client, or an unparseable/absent body) is
  // AMBIGUOUS and never marks — this is the guard against a bad shared
  // client_secret 400/401-ing the whole active base into a mass churn.
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON error page (proxy/edge) → body stays null → classified ambiguous
    // on 401/400. (404 is uninstalled regardless of body.)
    body = null;
  }

  const classification = classifyRefreshRejection(status, body);
  logger.info("reconcile-installs: raw refresh probe classified", {
    function: "reconcile-installs",
    domain,
    status,
    classification,
    error: bodyStringField(body, "error"),
  });
  return classification;
}

/**
 * Probe one shop's install status via the SAME auth path background jobs use
 * (unauthenticated.admin → one cheap Admin GraphQL call) and RETURN the
 * classification. This function NEVER marks — marking is deferred to a second
 * pass gated by the run-level circuit breaker, so a systemic misclassification
 * can never mass-churn (see the two-pass handler below). It DOES still perform
 * the rotation-store side effect on a raw-refresh 200 (inside rawRefreshProbe),
 * because storing the rotated session for a still-installed shop is safe and
 * itself prevents a future false-churn.
 */
async function probeInstall(domain: string): Promise<InstallStatus> {
  const { unauthenticated } = await import("../../app/shopify.server");

  let adminCtx: { admin: { graphql: (q: string) => Promise<{ status?: number }> } };
  try {
    adminCtx = await unauthenticated.admin(domain);
  } catch (err) {
    // With `future.expiringOfflineAccessTokens` on, an expired offline token is
    // refreshed INSIDE unauthenticated.admin. A REJECTED refresh
    // (invalid_subject_token / InvalidJwtError) is positive proof the app is no
    // longer installed — the definitive uninstall signal for an already-expired
    // token, and the common case once the daily cron runs after the TTL.
    if (isRefreshTokenRejected(err)) {
      return "uninstalled";
    }
    // Otherwise the failure is MASKED: the library wraps a real 401/404 refresh
    // rejection (and transient 5xx alike) as a generic `new Response(500)`, so we
    // can't tell an uninstall from a blip here. Disambiguate with a raw refresh
    // probe that reads Shopify's true status (body-aware). Only a shop-specific
    // rejection returns "uninstalled"; a raw 200 stored the rotated session
    // (installed); anything else (incl. our-side invalid_client) is ambiguous.
    const raw = await rawRefreshProbe(domain);
    if (raw !== "installed") {
      logger.info("reconcile-installs: masked admin failure — disambiguated via raw probe", {
        function: "reconcile-installs",
        domain,
        rawProbe: raw,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    return raw;
  }

  const { admin } = adminCtx;

  try {
    // Cheapest possible authenticated probe: shop.name needs no optional scope.
    const response = await admin.graphql("{ shop { name } }");
    const status = classifyResponseStatus(
      typeof response?.status === "number" ? response.status : undefined,
    );
    if (status === "ambiguous") {
      logger.info("reconcile-installs: non-200 response — skipping (ambiguous)", {
        function: "reconcile-installs",
        domain,
        httpStatus: response?.status,
      });
    }
    return status;
  } catch (err) {
    if (isDefinitiveAuthFailure(err)) {
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

    const checked = shops.length;

    // --- Pass 1: PROBE (classify only, mark NOTHING) -----------------------
    // One step per shop so a mid-run failure/retry resumes without re-probing
    // completed shops. probeInstall never marks; it may store a rotated session
    // on a 200 (safe, and itself prevents a future false-churn).
    const probes: Array<{ domain: string; classification: InstallStatus }> = [];
    for (let i = 0; i < shops.length; i++) {
      const classification = (await step.run(`probe-shop-${i}`, () =>
        probeInstall(shops[i].domain),
      )) as InstallStatus;
      probes.push({ domain: shops[i].domain, classification });

      // Brief pause between shops (skipped after the last) — rate-limit headroom.
      if (i < shops.length - 1) {
        await step.sleep(`pause-${i}`, PAUSE_BETWEEN_SHOPS);
      }
    }

    const wouldMark = probes.filter((p) => p.classification === "uninstalled").map((p) => p.domain);
    const skipped = probes.filter((p) => p.classification === "ambiguous").length;

    // --- Circuit-breaker gate ---------------------------------------------
    // A run that WOULD mark the whole probed base, or >=half of it, is the
    // mass-churn signature of a systemic fault, not a real day of uninstalls.
    // ABORT: mark nothing, page the operator, and let a human confirm before any
    // churn happens. The fraction is primary; the all-probed-marked rule ensures a
    // 100%-churn trips at ANY base size (checked >= 1) — the mass-churn signature
    // of a wrong/rotated shared client_secret 401'ing every shop is identical at
    // N=1, N=2, or N=100, so there is no safe floor below which auto-churn is OK.
    // Design tradeoff: at N=1 a lone active shop that classifies "uninstalled" now
    // PAGES-and-aborts instead of auto-marking. That is intended — this reconciler
    // is only a BACKSTOP for MISSED app/uninstalled webhooks (real uninstalls are
    // marked directly by that webhook), so refusing to auto-churn the entire
    // remaining base on a single ambiguous-looking signal and asking a human to
    // confirm is the conservative-correct call. wouldMark holds ONLY shops
    // classified "uninstalled" (ambiguous/transient shops are excluded upstream),
    // so this never trips on a network blip or throttle.
    const churnThreshold = Math.max(CB_MIN_MARKS, Math.ceil(CB_FRACTION * checked));
    const tripped =
      (checked >= 1 && wouldMark.length === checked) || // 100% churn is systemic at ANY base size → always trip
      wouldMark.length >= churnThreshold; // or >= half the base (floor CB_MIN_MARKS)
    if (tripped) {
      await step.run("circuit-breaker-abort", async () => {
        const { recordOpsEvent, OPS_EVENT_TYPES } =
          await import("../../app/models/ops-event.server");
        const summary =
          `reconcile ABORTED by circuit breaker: ${wouldMark.length} of ${checked} active shops ` +
          `classified uninstalled (threshold ${churnThreshold}) — likely a systemic misconfig ` +
          `(e.g. wrong/rotated shared client_secret), NOT a real mass uninstall. Marked NOTHING.`;
        // The durable OpsEvent row is counts-only: NO per-shop domains in the
        // message and none in the structured metadata, so deleteShopData (which
        // purges OpsEvents by key / metadata.shop|shopDomain|shopId) leaves nothing
        // per-shop to redact and this row needs no per-shop redact coverage. The
        // domain list rides the operator EMAIL only (below) — the operator's own
        // inbox is not a GDPR-scoped store.
        await recordOpsEvent({
          eventType: OPS_EVENT_TYPES.RECONCILE_ABORTED,
          key: RECONCILE_INSTALLS_KEY,
          message: summary,
          metadata: { checked, wouldMark: wouldMark.length, threshold: churnThreshold },
        });
        const { sendOpsAlert } = await import("../../app/services/ops-alert.server");
        try {
          await sendOpsAlert(
            "Reconciler circuit breaker tripped — no shops marked",
            `${summary}\n\nDomains: ${wouldMark.join(", ")}`,
          );
        } catch {
          // paging is best-effort; the OpsEvent row is the durable record.
        }
      });

      logger.error("reconcile-installs: circuit breaker tripped — aborted, marked nothing", {
        function: "reconcile-installs",
        checked,
        wouldMark: wouldMark.length,
        threshold: churnThreshold,
      });

      return {
        status: "aborted-circuit-breaker",
        checked,
        wouldMark: wouldMark.length,
      };
    }

    // --- Pass 2: MARK (only reached when the breaker did NOT trip) ----------
    // One step per shop for resumability; markUninstalled is idempotent
    // (updateMany + suppressed duplicate event), so a retry is safe.
    for (let i = 0; i < wouldMark.length; i++) {
      const domain = wouldMark[i];
      await step.run(`mark-${domain}`, () => markUninstalled(domain));
    }
    const marked = wouldMark.length;

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

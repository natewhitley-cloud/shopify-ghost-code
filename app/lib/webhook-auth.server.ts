/**
 * Tolerant webhook authentication (gc-4hk).
 *
 * WHY THIS EXISTS: the library's `authenticate.webhook` validates the HMAC and
 * THEN loads the shop's offline session. With `future.expiringOfflineAccessTokens`
 * on, an expired stored session is refreshed inline, and when the refresh token
 * itself is dead that refresh throws: the library's refresh helper re-throws
 * InvalidJwtError / `invalid_subject_token`, and wraps EVERY other refresh
 * failure (including Shopify's common 401 "requires an active refresh_token")
 * as `new Response(500)`. Either way the whole webhook throws AFTER a valid
 * HMAC, we answer 500, and Shopify retries ~8x and gives up. That hits every
 * topic, including app/uninstalled and the GDPR redact topics (incident:
 * de66e6-c4.myshopify.com, themes/publish failed 9x on 2026-09-23). A shop with
 * NO stored session is fine: the library returns the context with
 * `admin: undefined`. None of our webhook handlers need `admin`, so we degrade
 * to exactly that shape instead of failing.
 *
 * SECURITY INVARIANT: the fallback NEVER trusts the failed library call. It
 * re-validates the HMAC itself with `@shopify/shopify-api`'s own
 * `webhooks.validate` (the same function the library calls) keyed on the same
 * SHOPIFY_API_SECRET, and rejects with the same 401/400 the library would. An
 * unauthenticated request can therefore never reach a handler through this
 * path, and records no ops event.
 */

import "@shopify/shopify-api/adapters/web-api";
import {
  LogSeverity,
  shopifyApi,
  WebhookType,
  WebhookValidationErrorReason,
} from "@shopify/shopify-api";

import { recordWebhookFailure } from "../models/ops-event.server";
import { apiVersion, authenticate } from "../shopify.server";
import { logger } from "./logger.server";

/** The library's own return type: a union where `session`/`admin` may be undefined. */
export type WebhookAuthContext = Awaited<ReturnType<typeof authenticate.webhook>>;

/** The no-session member of the union: what the degraded path returns. */
export type DegradedWebhookContext = Extract<WebhookAuthContext, { admin: undefined }>;

/** `metadata.reason` on the degraded-path `webhook_failure` ops event. */
export const DEGRADED_REASON_OFFLINE_SESSION = "offline_session_failed";

/**
 * Is this throw one of the library's DELIBERATE pre-session rejections (405
 * non-POST, 401 bad HMAC, 400 missing headers)? Those are re-thrown unchanged.
 * A thrown 5xx Response is NOT a rejection: the only place the webhook path
 * throws one is the refresh helper's `new Response(500)` wrapper, which runs
 * after the HMAC was accepted, so it takes the fallback (which re-validates).
 */
function isDeliberateRejection(err: unknown): err is Response {
  return err instanceof Response && err.status < 500;
}

/**
 * A minimal `@shopify/shopify-api` instance used ONLY for `webhooks.validate`.
 * `shopifyApp` does not expose its internal api instance, so we build one from
 * the same env vars `app/shopify.server.ts` uses (it already refuses to boot
 * without them). Built per call: the degraded path is rare and construction is
 * cheap, and there is no cached secret to go stale. apiVersion/hostName are
 * required by the config validator but unused by HMAC validation (apiVersion is
 * still the app's own, so the two instances never disagree).
 */
function webhookValidator() {
  const apiSecretKey = process.env.SHOPIFY_API_SECRET ?? "";
  const appUrl = process.env.SHOPIFY_APP_URL ?? "";
  return shopifyApi({
    apiKey: process.env.SHOPIFY_API_KEY ?? "",
    apiSecretKey,
    apiVersion,
    hostName: appUrl ? new URL(appUrl).host : "",
    isEmbeddedApp: true,
    logger: { level: LogSeverity.Warning },
  }).webhooks.validate;
}

/**
 * Re-validate the webhook ourselves and build the same context shape the
 * library returns for a shop with no stored session. Throws a 401/400
 * Response exactly as the library does when validation fails.
 */
async function validateAndBuildContext(
  request: Request,
  rawBody: string,
): Promise<DegradedWebhookContext> {
  const check = await webhookValidator()({ rawBody, rawRequest: request });
  if (!check.valid) {
    if (check.reason === WebhookValidationErrorReason.InvalidHmac) {
      throw new Response(undefined, { status: 401, statusText: "Unauthorized" });
    }
    throw new Response(undefined, { status: 400, statusText: "Bad Request" });
  }

  const payload = JSON.parse(rawBody) as Record<string, unknown>;
  if (check.webhookType === WebhookType.Webhooks) {
    return {
      apiVersion: check.apiVersion,
      shop: check.domain,
      topic: check.topic,
      webhookId: check.webhookId,
      payload,
      subTopic: check.subTopic || undefined,
      session: undefined,
      admin: undefined,
      webhookType: check.webhookType,
      name: check.name,
      triggeredAt: check.triggeredAt,
      eventId: check.eventId,
    };
  }
  return {
    apiVersion: check.apiVersion,
    shop: check.domain,
    topic: check.topic,
    webhookId: check.eventId,
    payload,
    session: undefined,
    admin: undefined,
    webhookType: check.webhookType,
    handle: check.handle,
    action: check.action,
    resourceId: check.resourceId,
    triggeredAt: check.triggeredAt,
    eventId: check.eventId,
  };
}

/**
 * Drop-in replacement for `authenticate.webhook(request)` that survives a
 * post-HMAC offline-session failure (dead refresh token) by returning the
 * no-session context (`session`/`admin` undefined) instead of throwing.
 *
 *   - library succeeds                  -> its result, unchanged
 *   - library throws a 4xx Response     -> re-thrown unchanged (405/401/400)
 *   - library throws anything else      -> log, re-validate the HMAC ourselves,
 *       valid   -> record a degraded `webhook_failure` ops event, return context
 *       invalid -> throw 401/400 like the library
 */
export async function authenticateWebhookTolerant(request: Request): Promise<WebhookAuthContext> {
  // The library consumes the body, so read it once from a clone up front.
  const rawBody = await request.clone().text();

  try {
    return await authenticate.webhook(request);
  } catch (err) {
    if (isDeliberateRejection(err)) throw err;

    const headerShop = request.headers.get("x-shopify-shop-domain") ?? undefined;
    const error =
      err instanceof Response
        ? `Response ${err.status}`
        : err instanceof Error
          ? err.message
          : String(err);
    logger.error(
      "webhook-auth-degraded: authenticate.webhook failed without a rejection; re-validating",
      {
        shop: headerShop,
        topic: request.headers.get("x-shopify-topic") ?? undefined,
        error,
      },
    );

    const context = await validateAndBuildContext(request, rawBody);

    // Only an AUTHENTICATED request reaches here, so an attacker cannot use
    // this path to write ops events. Keyed like every webhook_failure (topic
    // key, metadata.shop), so deleteShopData's metadata.shop clause redacts it.
    await recordWebhookFailure({
      topic: String(context.topic),
      shop: context.shop,
      error: err instanceof Response ? new Error(error) : err,
      degradedReason: DEGRADED_REASON_OFFLINE_SESSION,
    });

    return context;
  }
}

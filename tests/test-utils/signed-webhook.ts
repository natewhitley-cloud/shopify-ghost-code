/**
 * Real-HMAC webhook requests for tests (gc-4hk).
 *
 * Builds a Request exactly as Shopify delivers a webhook: a JSON body plus the
 * X-Shopify-* headers, with X-Shopify-Hmac-Sha256 = base64(HMAC-SHA256(body,
 * secret)). Paired with `stubWebhookEnv`, the app's real
 * `@shopify/shopify-api` `webhooks.validate` verifies it, so the HMAC path is
 * genuinely exercised instead of mocked.
 */

import { createHmac } from "node:crypto";

import { vi } from "vitest";

/** A fixed test-only secret. Never a real credential. */
export const TEST_WEBHOOK_SECRET = "test-webhook-secret-gc-4hk";
export const TEST_API_VERSION = "2026-07";

/**
 * Point the env the webhook validator reads at test values. Vite loads `.env`
 * into tests (PROD values), so this must run before any validation.
 */
export function stubWebhookEnv(): void {
  vi.stubEnv("SHOPIFY_API_SECRET", TEST_WEBHOOK_SECRET);
  vi.stubEnv("SHOPIFY_API_KEY", "test-api-key");
  vi.stubEnv("SHOPIFY_APP_URL", "https://ghost-code.test");
}

export function signBody(body: string, secret: string = TEST_WEBHOOK_SECRET): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

export interface SignedWebhookOptions {
  /** Shopify's header form, e.g. "app/uninstalled". */
  topic: string;
  shop?: string;
  payload?: unknown;
  /** Sign with this secret instead of TEST_WEBHOOK_SECRET (to forge a bad HMAC). */
  secret?: string;
  /** Replace the body AFTER signing (to simulate tampering). */
  tamperedBody?: string;
  /** Header names to leave out (to simulate a malformed delivery). */
  omitHeaders?: string[];
  method?: string;
}

export function signedWebhookRequest(options: SignedWebhookOptions): Request {
  const shop = options.shop ?? "test-shop.myshopify.com";
  const body = JSON.stringify(options.payload ?? { id: 1 });
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Shopify-Hmac-Sha256": signBody(body, options.secret),
    "X-Shopify-Topic": options.topic,
    "X-Shopify-Shop-Domain": shop,
    "X-Shopify-API-Version": TEST_API_VERSION,
    "X-Shopify-Webhook-Id": "webhook-id-1",
  };
  for (const name of options.omitHeaders ?? []) delete headers[name];

  const method = options.method ?? "POST";
  return new Request(`https://ghost-code.test/webhooks/${options.topic}`, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : (options.tamperedBody ?? body),
  });
}

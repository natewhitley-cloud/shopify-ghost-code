import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  BillingInterval,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

// Plan name constants — must match keys in the billing config below.
// Import from app/lib/billing.server.ts for feature-flag lookups.
export const PLAN_STANDARD = "Standard";
export const PLAN_PROFESSIONAL = "Professional";

const apiSecretKey = process.env.SHOPIFY_API_SECRET;
if (!apiSecretKey) {
  throw new Error("SHOPIFY_API_SECRET environment variable must be set");
}

const appUrl = process.env.SHOPIFY_APP_URL;
if (!appUrl) {
  throw new Error("SHOPIFY_APP_URL environment variable must be set");
}

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey,
  apiVersion: ApiVersion.October25,
  scopes: process.env.SCOPES?.split(","),
  appUrl,
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: {
    expiringOfflineAccessTokens: true,
  },
  billing: {
    [PLAN_STANDARD]: {
      trialDays: 7,
      lineItems: [
        {
          amount: 29,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
        },
      ],
    },
    [PLAN_PROFESSIONAL]: {
      trialDays: 7,
      lineItems: [
        {
          amount: 59,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
        },
      ],
    },
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.October25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
// Note: billing checks are performed via `const { billing } = await authenticate.admin(request)`.
// Pass isTest: process.env.NODE_ENV !== "production" at call sites.

// =============================================================================
// SECURITY AUDIT: Session Token + CSP Review  (task .25 — reviewer@a62bf81)
// Date: 2026-03-10
// =============================================================================
//
// PART 1: Session Token Audit
// ---------------------------
// Route File                              | Auth Call                    | Status
// ----------------------------------------|------------------------------|-------
// routes/_index/route.tsx                 | loader: login() redirect only| OK (public landing, no admin access)
// routes/auth.$.tsx                       | loader: authenticate.admin() | OK (auth callback handler)
// routes/auth.login/route.tsx             | loader: login(), action: login() | OK (public login form)
// routes/health.tsx                       | loader: none                 | OK (intentionally public health check)
// routes/app.tsx                          | loader: authenticate.admin() | OK (parent layout guards all /app/* children)
// routes/app._index.tsx                   | loader: authenticate.admin(), action: authenticate.admin() | OK
// routes/app.scans.tsx                    | loader: authenticate.admin() | OK
// routes/app.scans.$scanId.tsx            | loader: authenticate.admin() | OK
// routes/webhooks.app.installed.tsx       | action: authenticate.webhook() | OK
// routes/webhooks.app.scopes_update.tsx   | action: authenticate.webhook() | OK
// routes/webhooks.app.uninstalled.tsx     | action: authenticate.webhook() | OK
// routes/webhooks.app.subscriptions.update.tsx | action: authenticate.webhook() | OK
// routes/webhooks.customers.data-request.tsx | action: authenticate.webhook() | OK
// routes/webhooks.customers.redact.tsx    | action: authenticate.webhook() | OK
// routes/webhooks.shop.redact.tsx         | action: authenticate.webhook() | OK
// routes/webhooks.themes.publish.tsx      | action: authenticate.webhook() | OK
// routes/api.inngest.ts                   | loader+action: Inngest SDK handler (no Shopify admin auth) | OK (Inngest uses its own signing key verification internally)
//
// RESULT: All admin routes call authenticate.admin(request). All webhook routes
// call authenticate.webhook(request). No violations found.
//
// NOTE: app.tsx's loader calls authenticate.admin() which covers all nested
// /app/* routes at the layout level, but each child route ALSO independently
// calls authenticate.admin() — this is correct defense-in-depth for actions
// and direct-to-loader requests.
//
// PART 2: CSP Header Audit
// ------------------------
// CSP is handled entirely by addDocumentResponseHeaders (exported above and
// called in app/entry.server.tsx at line 17 on every document request).
//
// The Shopify SDK implementation in:
//   node_modules/@shopify/shopify-app-react-router/dist/cjs/server/authenticate/helpers/add-response-headers.js
//
// Sets the following CSP for embedded AppStore apps (AppDistribution.AppStore):
//   Content-Security-Policy:
//     frame-ancestors https://<shop> https://admin.shopify.com
//       https://*.spin.dev https://admin.myshopify.io https://admin.shop.dev;
//
// Additionally sets a Link preconnect/preload header pointing to:
//   https://cdn.shopify.com                    (preconnect)
//   https://cdn.shopify.com/shopifycloud/app-bridge.js   (preload as script)
//   https://cdn.shopify.com/shopifycloud/polaris.js      (preload as script)
//
// RESULT: CSP frame-ancestors is correctly set for Shopify embedded app
// iframe contexts. cdn.shopify.com is included in preload headers. No
// manual CSP configuration is required — the template handles this correctly.
//
// NOTE: The SDK's CSP only sets frame-ancestors (not script-src or style-src).
// Shopify's embedded app security model relies on App Bridge + the iframe
// boundary rather than script-src restrictions. This is correct and expected
// behavior for Shopify apps as of SDK v1.1.1 (October25 API version).
//
// PART 3: GDPR Webhook Completeness
// -----------------------------------
// All 3 required GDPR webhooks are present and return 200 OK:
//   - customers/data_request -> webhooks.customers.data-request.tsx  OK
//   - customers/redact       -> webhooks.customers.redact.tsx         OK
//   - shop/redact            -> webhooks.shop.redact.tsx              OK (cascades scan + finding + session deletion)
// =============================================================================

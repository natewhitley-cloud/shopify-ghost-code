---
paths:
  - "app/routes/**/*"
  - "app/services/**/*"
strength: must
---

# GDPR Webhooks and Billing API

## Required GDPR Webhooks

Shopify requires these three webhooks before app review approval. They MUST return 200 OK even if the app has no customer data to process.

### 1. `customers/data_request`

- Shopify asks: "What data do you have about this customer?"
- Ghost Code response: Return 200. We store no customer PII — only shop-level scan data.

### 2. `customers/redact`

- Shopify asks: "Delete all data about this customer."
- Ghost Code response: Return 200. No customer-specific data to delete.

### 3. `shop/redact`

- Shopify asks: "The merchant uninstalled. Delete all their data."
- Ghost Code response: Delete all scans, findings, and shop records for this shop. Return 200.

## Webhook Verification

All webhooks MUST verify the HMAC signature from Shopify before processing. The Shopify app template provides middleware for this — use it, do not roll your own.

## Billing (Shopify App Pricing)

This app uses **Shopify App Pricing** (formerly Managed Pricing), NOT the classic
Billing API. We do NOT call the `appSubscriptionCreate` mutation and do not build
our own pricing page. Shopify hosts plan selection, creates the subscription, and
handles the checkout.

### Plan Selection

Shopify hosts the "Select a plan" page. We only build the URL to it — see
`buildPricingPlansUrl` in `app/lib/billing.server.ts`
(`.../charges/{appHandle}/pricing_plans`) — and link the merchant there.

### Plan-State Signals (post-2026-04-28)

- The `APP_SUBSCRIPTIONS_UPDATE` webhook is **DEAD as of 2026-04-28** — Shopify
  stopped sending it for App Pricing apps. Its handler
  (`app/routes/webhooks.app.subscriptions.update.tsx`) is retained but never
  invoked. Do NOT add new plan logic there.
- When a merchant selects/confirms a plan, Shopify redirects back to the app's
  welcome link with URL params `plan_handle` and `shop`. Its PRESENCE triggers an
  immediate reconcile in `app/routes/app.tsx`.
- A periodic on-load reconcile (`reconcileShopPlan` in
  `app/services/billing-reconciler.server.ts`) is the backstop for out-of-redirect
  changes (cancellations, freezes, expirations, which have no redirect).

### Feature Gating — Source of Truth

- **NEVER trust `plan_handle`'s value to grant features.** It is an
  unauthenticated URL hint, not proof of subscription. Use it only as a
  "reconcile now" trigger.
- The stored `Shop.plan` is set exclusively from the Admin API
  `currentAppInstallation.activeSubscriptions` query inside `reconcileShopPlan`.
  Gate paid features on that stored plan (see `getPlanFeatures`), which reflects
  an actual ACTIVE subscription.
- Free tier: 1 scan per month, basic findings. Paid tiers: more scans, detailed
  findings, historical comparison (see `getPlanFeatures` for exact limits).

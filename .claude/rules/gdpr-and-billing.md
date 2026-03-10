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

## Billing API

### Subscription Model

Use GraphQL `appSubscriptionCreate` mutation to create recurring charges:

```graphql
mutation CreateSubscription($name: String!, $price: Decimal!, $returnUrl: URL!) {
  appSubscriptionCreate(
    name: $name
    lineItems: [{ plan: { appRecurringPricingDetails: { price: { amount: $price, currencyCode: USD } } } }]
    returnUrl: $returnUrl
    test: true  # Remove for production
  ) {
    appSubscription { id }
    confirmationUrl
    userErrors { field message }
  }
}
```

### Feature Gating

- Check subscription status before allowing paid features
- Free tier: 1 scan per day, basic findings
- Paid tier: unlimited scans, detailed findings, historical comparison
- Always check `appSubscription.status == ACTIVE` before granting paid access

### Testing

- Use `test: true` in mutations during development
- Test charges appear in dev store but don't process real payments

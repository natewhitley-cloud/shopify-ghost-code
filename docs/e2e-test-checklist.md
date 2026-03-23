# Ghost Code E2E Test Checklist

Manual end-to-end verification against the Shopify dev store. Run through this before submitting for app review.

**Environment**: Production (Railway) — `shopify-ghost-code-production.up.railway.app`
**Dev store**: Install via Shopify Partners dashboard
**Bead**: GC-mfj.8

---

## 1. Install & Auth

- [ ] Install app on dev store from Partners dashboard
- [ ] App loads in embedded iframe (no blank screen, no redirect loop)
- [ ] Dashboard renders with session token auth (no 401 errors)
- [ ] Refresh page — session re-establishes without re-install

## 2. Dashboard & Navigation

- [ ] Dashboard shows Theme Health tile, Findings tiles, Scan Actions
- [ ] Navigate to Scan History — no full-page reload (React Router Link)
- [ ] Navigate to Settings — plan tiles render correctly
- [ ] Navigate back to Dashboard — state preserved
- [ ] About section renders with Permission Audit description

## 3. Theme Scan

> **Note**: Free plan allows 1 scan/month. If already used, either upgrade plan first (section 4) or reset scan record in database.

- [ ] Click "New Scan" — scan queues successfully
- [ ] Inngest Cloud dashboard shows `scan-theme` function triggered
- [ ] Scan completes (poll or refresh dashboard)
- [ ] Health score displays with color-coded tile
- [ ] Finding cards show High/Medium/Low counts
- [ ] Scan appears in Scan History table
- [ ] Click scan in history — detail view loads with findings

## 4. Billing

- [ ] Trigger upgrade to Standard plan ($29/month)
- [ ] Shopify billing approval screen appears
- [ ] After approval, subscription is active
- [ ] Settings page reflects new plan (Current Plan badge)
- [ ] Plan-gated features unlock (weekly manual scans)
- [ ] Test upgrade to Professional ($49/month)
- [ ] Test cancel/downgrade flow

## 5. Webhooks

- [ ] **app/uninstalled** — Uninstall app, verify shop record cleanup in database
- [ ] **app/scopes_update** — Fires when scopes change (verify in Railway logs)
- [ ] **app_subscriptions/update** — Fires after billing change (verify in Railway logs)
- [ ] **themes/publish** — Publish a theme, verify webhook received in Railway logs
- [ ] **GDPR (customers/data_request)** — Verify route responds 200 (can test via curl or Shopify Partner test)
- [ ] **GDPR (customers/redact)** — Verify route responds 200
- [ ] **GDPR (shop/redact)** — Verify route responds 200

## 6. Scan Limits & Plan Gating

- [ ] Free plan: blocked after 1 scan/month with clear messaging
- [ ] Standard plan: 1 scan/week, manual only (no automation toggle)
- [ ] Professional plan: unlimited scans, automation available
- [ ] Upgrade prompt appears when hitting free plan limit

## 7. Error Handling

- [ ] Navigate to invalid route — error boundary renders
- [ ] Session expiry — app re-authenticates on next interaction
- [ ] Network error during scan — user sees error state, not blank screen

## 8. Re-install Flow

- [ ] Uninstall app completely
- [ ] Re-install app
- [ ] OAuth flow completes, app loads
- [ ] Previous scan data is gone (shop record was cleaned up)

---

## Results

| Section                | Pass/Fail | Notes |
| ---------------------- | --------- | ----- |
| Install & Auth         |           |       |
| Dashboard & Navigation |           |       |
| Theme Scan             |           |       |
| Billing                |           |       |
| Webhooks               |           |       |
| Scan Limits            |           |       |
| Error Handling         |           |       |
| Re-install             |           |       |

**Tested by**: **\_
**Date**: \_**
**Build**: \_\_\_

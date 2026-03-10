---
strength: must
---

# Definition of Done

What "done" means for each type of change.

## New Feature

- [ ] Implementation complete with TypeScript types
- [ ] Unit tests written (Vitest) covering happy path + edge cases
- [ ] Integration test if feature touches Shopify API or database
- [ ] Loader/action pattern used for data fetching (no client-side API calls)
- [ ] Polaris Web Components used for UI (CDN `<s-*>` tags, not React Polaris)
- [ ] No TypeScript errors (`npx tsc --noEmit`)
- [ ] Formatted (`npx prettier --write .`)
- [ ] Session token auth verified in affected loaders/actions

## Bug Fix

- [ ] Root cause identified and documented in commit message
- [ ] Regression test added that would have caught the bug
- [ ] Fix verified end-to-end in Shopify dev store

## Database Change

- [ ] Prisma migration created (`npx prisma migrate dev`)
- [ ] Migration is reversible or has documented manual rollback
- [ ] Prisma client regenerated (`npx prisma generate`)
- [ ] Seed data updated if applicable

## New Route

- [ ] Route file in `app/routes/` following React Router v7 conventions
- [ ] `loader()` handles data fetching with session token validation
- [ ] `action()` handles mutations if applicable
- [ ] Error boundary present for user-facing routes
- [ ] Tests for both loader and action

## Shopify App Review Readiness

- [ ] Three GDPR webhooks implemented and responding
- [ ] Billing API integration working for paid features
- [ ] App uninstall webhook handled (cleanup shop data)
- [ ] Privacy policy and terms of service URLs set in shopify.app.toml

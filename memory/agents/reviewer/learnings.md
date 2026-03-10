# Learnings: reviewer

## Codebase Patterns
- Architecture rule: Routes → Services → Models → Prisma. Check import direction on every review.
- All files touching server-side code must use `.server.ts` suffix.
- Polaris Web Components only (`<s-*>` tags). Flag any React Polaris imports as blocking issues.
- GraphQL only — flag any REST Admin API calls as blocking (will cause app rejection).
- GDPR webhooks must exist and return 200 — check all 3 on every compliance review.

## Gotchas
- App review rejections: 60%+ are from broken GDPR webhooks. Always verify these are wired and responding.
- Session token validation: every route loader/action must call `authenticate.admin(request)`.
- CSP headers must allow `https://cdn.shopify.com` for Polaris Web Components.
- Billing API: verify `isTest` flag is environment-driven, not hardcoded.

## Preferences
- Review against the Definition of Done checklist in `.claude/rules/definition-of-done.md`.
- Check Shopify compliance dimension: GDPR, billing, session tokens, GraphQL-only, minimal scopes.
- Flag DRY violations aggressively (user preference).
- Verify edge case handling exists for: rate limits, API errors, empty states, missing data.

## Cross-Agent Notes
- Send blocking issues to implementer or debugger with specific file:line references.
- After review, update this learnings file with any new patterns discovered.

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
- CSP headers are handled automatically by the SDK's addDocumentResponseHeaders — no manual CSP config needed. (updated: 2026-03-10, dispatch: .25)
- Billing API: verify `isTest` flag is environment-driven, not hardcoded.

## Preferences

- Review against the Definition of Done checklist in `.claude/rules/definition-of-done.md`.
- Check Shopify compliance dimension: GDPR, billing, session tokens, GraphQL-only, minimal scopes.
- Flag DRY violations aggressively (user preference).
- Verify edge case handling exists for: rate limits, API errors, empty states, missing data.

## Cross-Agent Notes

- Send blocking issues to implementer or debugger with specific file:line references.
- After review, update this learnings file with any new patterns discovered.
- app.tsx layout loader calls authenticate.admin() but child routes must ALSO call it independently in both loader AND action. Layout loader does not protect child actions. (added: 2026-03-10, dispatch: .25)
- CSP is handled by SDK's addDocumentResponseHeaders in entry.server.tsx — sets frame-ancestors for Shopify admin domains. No manual CSP config needed for standard embedded apps. (added: 2026-03-10, dispatch: .25)
- Route files can be flat (app.scans.tsx) or directories (\_index/route.tsx). Both valid in React Router v7. (added: 2026-03-10, dispatch: .25)

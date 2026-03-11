# Archived Learnings: implementer

- Layer boundaries: Routes → Services → Models → Prisma. Never import routes from services. (archived: 2026-03-10, reason: passive — covered by rule: .claude/rules/architecture.md)
- Route modules use loader() for data fetching, action() for mutations — no separate API route files. (archived: 2026-03-10, reason: passive — covered by rule: .claude/rules/architecture.md + .claude/rules/definition-of-done.md)
- GraphQL queries use cursor-based pagination with `first: 250` and `after` cursor. (archived: 2026-03-10, reason: passive — covered by rule: .claude/rules/shopify-graphql.md)
- Rate limiting: 50 points/second for GraphQL. Monitor `extensions.cost.throttleStatus` in responses. (archived: 2026-03-10, reason: passive — covered by rule: .claude/rules/shopify-graphql.md)
- Polaris uses `<s-*>` Web Components (CDN), NOT React imports. No `import { Card } from '@shopify/polaris'`. (archived: 2026-03-10, reason: passive — covered by rule: .claude/rules/polaris-web-components.md)
- Session tokens, not cookies — never use localStorage or document.cookie for auth. (archived: 2026-03-10, reason: passive — covered by rule: .claude/rules/shopify-graphql.md Authentication section)
- GDPR webhooks must ALL return 200 even if no data to process. Missing webhooks = automatic app rejection. (archived: 2026-03-10, reason: passive — covered by rule: .claude/rules/gdpr-and-billing.md)
- Webhook handlers must ALWAYS return 200. Use authenticate.webhook() for HMAC verification. Non-200 causes infinite Shopify retries. (archived: 2026-03-10, reason: passive — covered by rule: .claude/rules/gdpr-and-billing.md, duplicate of GDPR entry)

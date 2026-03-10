---
strength: must
---

# Commit Message Convention

This project uses conventional commits with scopes, matching the sibling project (ReadQuest).

## Format

```
<type>(<scope>): <description>
```

## Types

- `feat(scope):` New feature or capability
- `fix(scope):` Bug fix
- `refactor(scope):` Restructure without behavior change
- `test(scope):` Add or update tests
- `chore:` Tooling, config, dependencies, beads state
- `docs:` Documentation updates

## Common Scopes

- `scanner` — theme scanning logic
- `ui` — Polaris UI components and routes
- `api` — GraphQL queries, loaders, actions
- `db` — Prisma schema, migrations, models
- `billing` — Shopify Billing API integration
- `gdpr` — GDPR webhook handlers
- `auth` — Session token handling
- `worker` — Inngest background jobs

## Do This

- Use lowercase type and scope
- Keep subject line under 72 characters
- Describe what changed, not how

## Don't Do This

- Do not capitalize the first word after the colon
- Do not end the subject line with a period

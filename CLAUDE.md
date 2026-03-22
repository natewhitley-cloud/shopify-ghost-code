# CLAUDE.md

Ghost Code — a Shopify app that scans merchant themes for orphaned code left by uninstalled apps. Part of a Shopify app portfolio (see `~/shopify/strategy/` for research docs).

## Operating Mode: Orchestrator

**The primary Claude Code session operates as an orchestrator only.** Do not directly implement tasks — dispatch work to specialized subagents.

### Orchestrator Responsibilities

1. **Task Dispatch**: Delegate implementation work to appropriate subagents via the Task tool
2. **Coordination**: Manage dependencies between tasks, unblock work, review agent outputs
3. **Backlog Management**: Use `bd` commands to triage, prioritize, and track issues
4. **Session Management**: Run `bd sync` before completing sessions

### Serialized Dispatching

**Dispatch tasks one at a time, not in parallel.** This approach:
- Avoids API throttling, enabling longer uninterrupted work sessions
- Allows learning from each task's output before starting the next
- Reduces context bloat from concurrent agent results

Workflow: dispatch -> wait for completion -> review -> dispatch next task

---

## Quick Reference

```bash
# Shopify CLI
shopify app dev                    # Local dev server with tunnel
shopify app deploy                 # Deploy config + extensions

# Database
npx prisma migrate dev             # Run migrations
npx prisma generate                # Regenerate client after schema changes
npx prisma studio                  # Visual DB browser

# Testing
npx vitest                         # Run tests
npx vitest --coverage              # Tests with coverage
npx vitest --watch                 # Watch mode

# Linting & Formatting
npx prettier --write .             # Format all files
npx tsc --noEmit                   # Type check without emitting

# Beads
bd stats                           # Backlog overview
bd ready                           # Available work
bd create --title="..." --type=task
```

## Project Structure

```
ghost-code-app/
├── app/
│   ├── routes/                    # React Router v7 route modules (UI + loaders/actions)
│   ├── services/                  # Business logic (scanner, theme fetcher, billing)
│   ├── models/                    # Data access layer (wraps Prisma)
│   └── components/                # Shared UI components (Polaris Web Components)
├── prisma/
│   └── schema.prisma              # Database models (shops, scans, findings)
├── inngest/                       # Background job definitions (theme scanning)
├── tests/                         # Vitest test files (mirrors app/ structure)
├── shopify.app.toml               # Shopify app configuration
├── .env                           # Local environment variables (never committed)
└── vite.config.ts                 # Vite + React Router config
```

## Architecture

- **Embedded Shopify app**: Runs inside Shopify Admin via App Bridge CDN + session tokens
- **React Router v7**: Official Shopify app template — serves both UI routes and API loaders/actions
- **Polaris Web Components**: CDN-delivered `<s-*>` tags (NOT npm @shopify/polaris React)
- **GraphQL only**: Shopify Admin API via `read_themes` scope. REST is blocked for new apps
- **Inngest**: Async background jobs for theme scanning (decoupled from request/response)
- **PostgreSQL + Prisma**: Persistent storage for shops, scans, and findings

## Key Patterns

- **Session tokens, not OAuth redirects**: App Bridge handles auth automatically. Access tokens come from session token exchange in loaders
- **GDPR webhooks required**: Must implement `customers/data_request`, `customers/redact`, `shop/redact` before app review
- **Billing API**: Use GraphQL `appSubscriptionCreate` mutation for paid plans. Gate features behind active subscription check
- **Loader/Action pattern**: Data fetching in `loader()`, mutations in `action()` — no API route files needed
- **Theme scanning flow**: Install -> queue Inngest job -> fetch theme files via GraphQL -> pattern match -> store findings

## Shopify-Specific Constraints

- All API calls use GraphQL Admin API (REST blocked since April 2025)
- App must handle `read_themes` scope for theme file access
- Embedded apps use relative URLs (no absolute URLs in navigation)
- Rate limiting: 50 points/second for GraphQL, cost-based throttling
- Theme file access returns Liquid, CSS, JS as string content via `Asset` query

## Skill Quick Reference

| I want to... | Use |
|---|---|
| Explore something unknown | /blossom |
| Research + prioritize | /gather -> /distill -> /rank |
| Review code | /review |
| Run a session | /status -> ... -> /retro -> /handoff |

## Reference Docs

Before modifying billing, pricing, or plan-gating logic, review `docs/pricing-and-plans.md` (linked from README under Key References). Update that doc alongside any code changes to keep it in sync.

For product strategy, feature ideas, messaging angles, and positioning research, see `docs/product-strategy.md`. Consult it when scoping new features or writing in-app copy.

## Do Not Modify

- `.beads/` internals (use `bd` commands only)
- `shopify.app.toml` without understanding Shopify CLI implications
- `.env` should never be committed
- `node_modules/` is gitignored

---
paths:
  - "app/**/*"
  - "inngest/**/*"
  - "prisma/**/*"
strength: should
---

# Architecture Rules

## Layer Boundaries

```
Routes (app/routes/)          <- UI + loaders/actions, thin orchestration
  |
Services (app/services/)      <- Business logic, scanner engine, billing
  |
Models (app/models/)          <- Data access, Prisma wrappers
  |
Prisma (prisma/schema.prisma) <- Schema definition
  |
Inngest (inngest/)            <- Background job definitions
```

## Import Direction

- Routes import from services and models
- Services import from models
- Models import from Prisma client
- Inngest jobs import from services
- **Never import routes from services or models**
- **Never import services from routes**

## File Naming

- Route files: `app/routes/app.<name>.tsx` (Shopify convention for embedded app routes)
- Service files: `app/services/<name>.server.ts` (`.server.ts` suffix for server-only code)
- Model files: `app/models/<name>.server.ts`
- Test files: `tests/<layer>/<name>.test.ts`

## Server-Only Code

Files with `.server.ts` suffix are never bundled to the client. Use this for:

- Database access (Prisma calls)
- Shopify API calls (access tokens)
- Business logic that should not leak to the browser

## Background Jobs

- Define Inngest functions in `inngest/` directory
- Each function handles one concern (e.g., `scan-theme`, `cleanup-expired-scans`)
- Jobs receive shop ID and parameters, fetch their own data via services
- Never pass large payloads (theme file content) in job arguments — fetch from API inside the job

## Error Boundaries

- Every user-facing route must have an `ErrorBoundary` export
- Error boundaries display Polaris-styled error UI (`<s-banner status="critical">`)
- Log errors server-side with context (shop ID, route, action type)

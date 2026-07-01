# Deployment Runbook

Operational reference for deploying Ghost Code to production (Railway).

## How migrations run now

Database migrations run as a Railway **pre-deploy** step, not on container
boot. On each deploy Railway builds the new image, then runs
`preDeployCommand = "npx prisma migrate deploy"` (configured in `railway.toml`)
exactly **once**, against the production database, before traffic switches to
the new container.

Consequences:

- A failed pre-deploy **fails the deploy**. The previous container keeps
  serving traffic, so a bad migration does not cause an outage — but deploys
  are **blocked** until the failure is resolved.
- Container boot no longer runs `prisma generate` or `prisma migrate deploy`.
  The Prisma client is generated in the Docker build stage and copied into the
  runtime image (both `node_modules/.prisma` and `node_modules/@prisma/client`),
  so no runtime generation is needed. Crash-restarts no longer re-run
  migrations.

## Recovering a failed migration

A failed `migrate deploy` records a **failed row** in the `_prisma_migrations`
table. That row blocks all subsequent `migrate deploy` runs — including future
deploys — until it is resolved. `migrate deploy` will refuse to proceed while a
failed migration is recorded.

To recover:

1. Connect using the **production** `DATABASE_URL` (the same one Railway uses).
2. Determine whether the failed migration's changes were actually applied to
   the database (inspect the schema / partial state):
   - If the migration was **NOT applied** (or you manually reverted its
     changes):
     ```
     npx prisma migrate resolve --rolled-back <migration_name>
     ```
   - If the migration **actually succeeded** but was recorded as failed:
     ```
     npx prisma migrate resolve --applied <migration_name>
     ```
3. Redeploy. The pre-deploy step re-runs `migrate deploy`, which will now
   proceed past the resolved migration.

`<migration_name>` is the migration directory name under `prisma/migrations/`
(e.g. `20260601123456_add_findings_index`).

## Migration discipline

Keep migrations **additive and reversible**. This repo has **no shadow/local
database** and `.env` points at the production Railway database, so migration
authoring and any `prisma migrate dev` runs hit production. Prefer additive
changes (new tables/columns, nullable or defaulted) and gate destructive
changes carefully. A reversible migration is what makes the
`--rolled-back` recovery path above viable.

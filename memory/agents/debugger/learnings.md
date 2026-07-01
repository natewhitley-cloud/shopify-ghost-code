# Learnings: debugger

## Codebase Patterns

- Shopify GraphQL errors return in `response.errors[]` array — check for THROTTLED, ACCESS_DENIED, NOT_FOUND.
- Prisma errors have specific codes: P2002 (unique constraint), P2025 (record not found), P2003 (foreign key).
- Inngest function failures are visible in Inngest dashboard — check step-level failures.
- Rate limit state is in `extensions.cost.throttleStatus.currentlyAvailable` — log this on failures.

## Gotchas

- Shopify GID format (`gid://shopify/Theme/123`) — common bug is passing raw numeric ID instead. Webhook `payload.id` is a raw integer; must format as `gid://shopify/Theme/${id}` before passing to any Shopify API call. (updated: 2026-03-10, dispatch: S-01)
- Plan string constants must always use `PLANS.*` from `billing.server.ts` — never hardcode strings. DB stores title case (`Professional`, `Standard`) which doesn't match intuitive lowercase. (added: 2026-03-10, dispatch: S-02)
- Stale offline tokens cause silent auth failures in Inngest background jobs (not in request context).
- Theme deletion mid-scan causes NOT_FOUND on file fetch — scan function must handle gracefully.
- Prisma type misalignment after schema changes — run `npx prisma generate` to sync client types.
- Startup assertions over `|| ""` fallbacks for security-critical env vars (`SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`). An empty string silently changes security semantics. `if (!val) throw` also satisfies TypeScript narrowing. (added: 2026-03-10, dispatch: S-03)
- For SDKs that read credentials from env IMPLICITLY (Inngest reads `INNGEST_EVENT_KEY`/`INNGEST_SIGNING_KEY`), the implicit read hides the dependency and degrades silently if missing — no boot error, jobs just never run. Fix BOTH ways: a production-gated fail-fast boot guard (`if (NODE_ENV==='production' && !key) throw`, dev-permissive, in the central module loaded at boot e.g. `inngest/client.ts`) AND pass the credential explicitly at the call site (`signingKey`/`eventKey`) so the dependency is visible in code. Mirrors `shopify.server.ts` + the SENTRY_DSN optional-in-dev philosophy. (added: 2026-06-15, dispatch: GC-be2)

## Preferences

- Start diagnosis with the error message, then trace backwards through the call chain.
- Check logs first (stdout for Railway), then code, then API responses.
- Reproduce before fixing — write a failing test that demonstrates the bug.
- Protocol-relative URLs (`//host/x.js`) throw in `new URL(url)` (no scheme), so any `try{new URL(url)}catch{continue}` silently DROPS them. Normalize with an `https:` prefix first. Use the shared `hostnameFromUrl()` in `app/lib/url.server.ts` rather than re-rolling `new URL().hostname` — there were 4 duplicate extractors before GC-vu9 consolidated them. (added: 2026-07-01, dispatch: GC-vu9)
- Verify a Shopify access-scope name against the Admin API docs before "fixing" it. Commit 995f56d changed the correct `read_online_store_navigation` to a non-existent `read_url_redirects` on a false premise; the `urlRedirects` query requires `read_online_store_navigation`. A wrong scope-rename looks plausible and never fails locally. (added: 2026-07-01, dispatch: GC-vu9)

## Cross-Agent Notes

- When a fix reveals a missing test case, flag it for the tester.
- When a fix reveals a documentation gap, flag it for the reviewer.

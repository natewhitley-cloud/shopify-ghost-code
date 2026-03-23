# Agent Catalog

Quick reference for which agent to dispatch for each task type. All agents are in `.claude/agents/`.

## Agent Summary

| Agent       | Purpose                                                   | Model  | Invoke When                                                                   |
| ----------- | --------------------------------------------------------- | ------ | ----------------------------------------------------------------------------- |
| scaffolder  | Create new files and wire them into the project structure | sonnet | Task requires new route, service, model, Inngest job, or Prisma schema change |
| implementer | Write business logic, fill stubs, connect layers          | sonnet | Scaffolding exists (or is simple enough to skip), task requires real logic    |
| tester      | Write and maintain Vitest tests, verify coverage          | sonnet | Implementation complete, tests needed for new or changed code                 |
| reviewer    | Review changes for quality, security, Shopify compliance  | sonnet | After implementation and testing, before merge or commit                      |
| debugger    | Diagnose and fix bugs, trace error chains                 | sonnet | Something is broken, root cause unknown, test failures                        |

## Agent Capabilities Matrix

| Agent       | Reads Code | Writes Code    | Runs Tests | Runs Type Check | Runs Prisma | Permission Mode   |
| ----------- | ---------- | -------------- | ---------- | --------------- | ----------- | ----------------- |
| scaffolder  | Y          | Y              | N          | Y               | Y           | bypassPermissions |
| implementer | Y          | Y              | Y          | Y               | Y           | bypassPermissions |
| tester      | Y          | Y (tests only) | Y          | Y               | N           | bypassPermissions |
| reviewer    | Y          | N              | Y          | Y               | N           | default           |
| debugger    | Y          | Y              | Y          | Y               | Y           | bypassPermissions |

## Dispatch Decision Tree

```
Is something broken?
  YES -> debugger
  NO  -> Does the task need new files or schema changes?
           YES -> scaffolder (then implementer for logic)
           NO  -> Does the task need business logic written?
                    YES -> implementer
                    NO  -> Does the task need tests?
                             YES -> tester
                             NO  -> Is this a review before merge?
                                      YES -> reviewer
```

## Common Workflows

### New Feature (Full Pipeline)

1. **scaffolder** -- Create route, service, model files. Create Prisma migration if needed. Wire imports.
2. **implementer** -- Fill in business logic. Handle edge cases. Wire GraphQL queries.
3. **tester** -- Write unit tests for services/models. Write integration tests for routes.
4. **reviewer** -- Review all changes. Verify Definition of Done. Issue verdict.

### New Route (UI Only)

1. **scaffolder** -- Create `app/routes/app.<name>.tsx` with loader, action, ErrorBoundary, and Polaris Web Components skeleton.
2. **implementer** -- Implement loader data fetching, action mutations, and UI rendering.
3. **tester** -- Write tests for loader and action with mocked Shopify session.
4. **reviewer** -- Review for session validation, Polaris compliance, error handling.

### New Inngest Background Job

1. **scaffolder** -- Create `inngest/<job-name>.ts` and wire into the Inngest client.
2. **implementer** -- Implement step functions with service calls. Handle retries and failures.
3. **tester** -- Write tests with mocked step tools and GraphQL responses.
4. **reviewer** -- Review for idempotency, error handling, rate limit awareness.

### Bug Fix

1. **debugger** -- Diagnose root cause. Apply minimal fix. Write regression test.
2. **reviewer** -- Review the fix for correctness and completeness.

### Schema Change

1. **scaffolder** -- Update `prisma/schema.prisma`. Run migration. Regenerate client.
2. **implementer** -- Update model functions and service logic for new schema.
3. **tester** -- Update tests for new data shapes.
4. **reviewer** -- Review migration, model changes, and cascade effects.

### GDPR Webhook Implementation

1. **scaffolder** -- Create webhook route files and service stubs.
2. **implementer** -- Implement HMAC verification, data deletion for `shop/redact`, 200 responses for all three webhooks.
3. **tester** -- Test HMAC verification, test each webhook handler, test with invalid signatures.
4. **reviewer** -- Verify all three webhooks present, HMAC verified, `shop/redact` deletes all shop data.

### Billing API Integration

1. **scaffolder** -- Create billing service, subscription check model, billing route.
2. **implementer** -- Implement `appSubscriptionCreate` mutation, subscription status check, feature gating logic.
3. **tester** -- Test subscription creation, status checking, feature gating for free vs. paid tiers.
4. **reviewer** -- Verify `test: true` flag in dev, feature gating checks `ACTIVE` status, error handling.

## Shopify-Specific Agent Notes

All agents should be aware of these constraints:

- **GraphQL only** -- REST is blocked since April 2025
- **Session tokens** -- Not OAuth redirects. App Bridge handles auth.
- **Polaris Web Components** -- CDN `<s-*>` tags, NOT npm `@shopify/polaris`
- **`.server.ts` suffix** -- Server-only code must use this suffix
- **Rate limiting** -- 50 points/second for GraphQL, implement backoff
- **GDPR webhooks** -- Three mandatory handlers, all must return 200
- **Loader/Action pattern** -- No API route files, no client-side API calls

## Related Skills

| Skill                        | Use For                                           |
| ---------------------------- | ------------------------------------------------- |
| /blossom                     | Explore and plan work for new epics               |
| /review                      | Structured code review (the skill, not the agent) |
| /status                      | Session status check                              |
| /handoff                     | Session handoff with context preservation         |
| /retro                       | Post-session retrospective                        |
| /gather -> /distill -> /rank | Research and prioritize                           |

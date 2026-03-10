---
paths:
  - "app/**/*"
  - "inngest/**/*"
strength: must
---

# Shopify GraphQL API

## REST is Blocked

All Shopify API calls MUST use the GraphQL Admin API. REST endpoints are blocked for new apps since April 2025. Do not use `@shopify/shopify-api` REST client methods.

## Authentication

- Embedded apps use App Bridge CDN for automatic session token exchange
- Access tokens are obtained from session tokens in loaders/actions via the Shopify app template's auth utilities
- Never store access tokens in client-side code or localStorage

## Rate Limiting

- 50 cost points per second for GraphQL
- Use `throttleStatus` in query responses to monitor remaining capacity
- Implement exponential backoff for `THROTTLED` errors
- Theme file fetches are expensive — batch where possible

## Key Queries

### Theme Files

```graphql
query GetThemeAssets($themeId: ID!) {
  theme(id: $themeId) {
    files(first: 250) {
      nodes {
        filename
        body { ... on OnlineStoreThemeFileBodyText { content } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}
```

### Active Theme

```graphql
query GetActiveTheme {
  themes(first: 1, roles: MAIN) {
    nodes { id name role }
  }
}
```

## Pagination

All list queries MUST handle pagination. Use cursor-based pagination with `pageInfo.hasNextPage` and `pageInfo.endCursor`. Never assume a single page contains all results.

## Error Handling

- Check `response.errors` array before accessing `response.data`
- Handle `ACCESS_DENIED` (scope missing), `THROTTLED` (rate limit), and `NOT_FOUND` gracefully
- Log error details but never expose raw GraphQL errors to the merchant UI

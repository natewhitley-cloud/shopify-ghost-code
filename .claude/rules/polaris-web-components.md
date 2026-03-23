---
paths:
  - "app/routes/**/*"
  - "app/components/**/*"
strength: must
---

# Polaris Web Components

## CDN Delivery, Not npm

Polaris UI uses **Web Components** delivered via the Shopify CDN. The Shopify app template includes the CDN script automatically via App Bridge.

**Do NOT install `@shopify/polaris` from npm.** Do NOT use React Polaris components (`<Page>`, `<Card>`, `<Button>`, etc.).

## Tag Convention

All Polaris Web Components use the `<s-*>` prefix:

```html
<s-page>
  <s-layout>
    <s-layout-section>
      <s-card>
        <s-text variant="headingMd">Scan Results</s-text>
        <s-button variant="primary" onClick="{handleScan}">Start Scan</s-button>
      </s-card>
    </s-layout-section>
  </s-layout>
</s-page>
```

## Common Components

| React Polaris (DON'T) | Web Component (DO)  |
| --------------------- | ------------------- |
| `<Page>`              | `<s-page>`          |
| `<Card>`              | `<s-card>`          |
| `<Button>`            | `<s-button>`        |
| `<Text>`              | `<s-text>`          |
| `<Layout>`            | `<s-layout>`        |
| `<Banner>`            | `<s-banner>`        |
| `<Badge>`             | `<s-badge>`         |
| `<DataTable>`         | `<s-data-table>`    |
| `<ResourceList>`      | `<s-resource-list>` |
| `<Modal>`             | `<s-modal>`         |

## TypeScript

Web Components are standard HTML elements. For TypeScript, use `HTMLElement` types or declare custom element interfaces if strict typing is needed.

## Event Handling

Web Components emit standard DOM events. Use `addEventListener` or React's `onClick`/`onChange` handlers in JSX. Some components use custom events — check Shopify docs for event names.

## Styling

- Polaris components come pre-styled via CDN CSS
- Use Polaris design tokens for custom styling (spacing, colors, typography)
- Do not override Polaris component internals with custom CSS

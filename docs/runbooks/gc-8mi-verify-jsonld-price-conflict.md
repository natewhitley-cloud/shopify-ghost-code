# Runbook: live-store proof of `JSON_LD_PRICE_CONFLICT` (gc-8mi)

Purpose: obtain the TRUE end-to-end proof that a stale static JSON-LD price in a
theme is detected against the live product price — the one thing code/tests
cannot prove because it needs a real store, a real `read_products` grant, and a
real live-product price. The integration test
(`tests/services/jsonld-price-audit.server.test.ts`, describe
"live-path resolve→compare→emit proof (gc-8mi)") already proves the
resolve→compare→emit path with a mocked Admin API; this runbook closes the
remaining live-store gap.

> Bead-label note: gc-8mi's title says "GHOST_PRICE", but its body describes THIS
> detector — the static-JSON-LD-vs-live-product-price audit that emits
> `JSON_LD_PRICE_CONFLICT`. `GHOST_PRICE` is a separate detector and is not what
> this runbook verifies.

## What the detector does

During a theme scan, GhostCode extracts unsigned static `Product` JSON-LD blocks
from theme Liquid, resolves each to the merchant's LIVE product via the
`read_products` Admin API, and emits a `JSON_LD_PRICE_CONFLICT` finding when the
hardcoded price MATERIALLY disagrees with the live price. It is defensive by
design — see the FP-suppression pitfalls below.

## Prerequisites

1. A Shopify dev store with the GhostCode app installed.
2. The app has been granted the `read_products` scope on that store. (Without it,
   the audit records the category as skipped and emits nothing.)
3. The `JSONLD_LIVE_PRICE_ENABLED=true` environment flag is set in the
   environment running the scan worker. The step is fully inert while the flag is
   off — this is a deliberate soft-launch gate, not a scope skip.
4. Access to edit the store's active (published) theme via
   Online Store → Themes → Edit code.

## Steps

### 1. Pick a live product and record its real price

- In the dev store admin, open Products and pick one product.
- Note its `handle` (from the product URL `/products/{handle}`) and its live
  price, e.g. handle `test-widget`, price `29.99`, currency the store's currency
  (e.g. `USD`).
- To keep resolution unambiguous, prefer a single-variant product (or note the
  variant SKU if you intend to key on `sku` instead of `handle`).

### 2. Seed a DISAGREEING static JSON-LD block into the theme

- Online Store → Themes → (active theme) → Edit code.
- Open a product template or a section that renders on the product page (e.g.
  `sections/main-product.liquid`), or a snippet included there.
- Paste a static `Product` JSON-LD block whose `price` DISAGREES with the live
  price you recorded, using the SAME currency and the SAME handle so resolution
  is unambiguous. Example (live price is `29.99`; we hardcode a stale `19.99`):

```liquid
<script type="application/ld+json">
{
  "@context": "https://schema.org/",
  "@type": "Product",
  "name": "Test Widget",
  "url": "https://your-store.myshopify.com/products/test-widget",
  "offers": {
    "@type": "Offer",
    "price": "19.99",
    "priceCurrency": "USD",
    "availability": "https://schema.org/InStock"
  }
}
</script>
```

- Adjust `url` (the `/products/{handle}` path) to match your product's handle,
  `priceCurrency` to the store currency, and `price` to a value that:
  - differs from the live price, AND
  - does NOT equal any live variant price, AND
  - does NOT equal any live `compareAtPrice`.
- Save the theme file. Note the file name and the line number of the opening
  `<script ...>` tag — the finding attributes to those.

### 3. Re-run a scan

- Open the GhostCode app in the dev store admin and start a new scan (the app
  home "scan" action fires the `scan/requested` job). Wait for it to complete.

### 4. Confirm the finding

- Open the completed scan's detail page (route `app/scans/{scanId}`).
- Confirm a `JSON_LD_PRICE_CONFLICT` finding appears and that it attributes to
  the theme file and line you seeded in step 2. Its description should name both
  the static price (`19.99`) and the live price (`29.99`).

### 5. Close gc-8mi with evidence

- Record the `scanId` of the scan that produced the finding (from the scan-detail
  URL) as the evidence on the bead. That scan id is the live-store proof.

### 6. Cleanup

- Return to Edit code and REMOVE the static JSON-LD block you added in step 2.
- Save. A subsequent scan should no longer emit the finding (the differ will
  resolve it), confirming the block is gone.

## FP-suppression pitfalls (do NOT accidentally seed a suppressed case)

The detector is intentionally conservative. Any of these will (correctly)
suppress the finding — avoid them when seeding, or you'll wrongly conclude the
detector is broken:

- Currency mismatch: static `priceCurrency` differs from the store currency →
  suppressed (a different currency legitimately carries a different number).
- Static price equals ANY live variant price → suppressed (matches a real
  variant, not stale).
- Static price equals a live `compareAtPrice` → suppressed (treated as an
  intentional sale/original price).
- Product with more than 100 variants → skipped (can't be sure the static price
  doesn't match an un-fetched variant).
- Ambiguous identity → skipped: a `handle` that resolves to 0 or >1 products, or
  a `sku` that resolves to 0 or >1 variants. Use a unique handle / single-match
  sku.
- Non-numeric static price (e.g. `"call for price"`, `"$19.99"` with a symbol) →
  not compared.
- If the block carries a `sku`, the audit keys on the SKU (a specific variant)
  and will NOT fall back to the handle — make sure the SKU is the one you intend
  to compare against.

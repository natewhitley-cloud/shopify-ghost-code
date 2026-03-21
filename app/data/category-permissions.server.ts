/**
 * Category-to-expected-permissions mapping for the Permission Audit feature.
 *
 * Maps each Shopify App Store category to the OAuth scopes that apps in that
 * category would reasonably need. Apps requesting scopes outside their
 * category's expected set get flagged as potentially over-permissioned.
 *
 * Data sources:
 *   - Category slugs from the market-research SQLite DB (100 categories, 7 top-level)
 *   - Shopify OAuth access scopes from https://shopify.dev/docs/api/usage/access-scopes
 */

// ---------------------------------------------------------------------------
// Scope sensitivity levels
// ---------------------------------------------------------------------------

export const ScopeSensitivity = {
  LOW: "LOW",
  MEDIUM: "MEDIUM",
  HIGH: "HIGH",
  CRITICAL: "CRITICAL",
} as const;

export type ScopeSensitivity = (typeof ScopeSensitivity)[keyof typeof ScopeSensitivity];

// ---------------------------------------------------------------------------
// Scope → sensitivity mapping
// ---------------------------------------------------------------------------

export const SCOPE_SENSITIVITY: Record<string, ScopeSensitivity> = {
  // CRITICAL — write access to orders, customers, financial data
  write_orders: "CRITICAL",
  write_customers: "CRITICAL",
  read_all_orders: "CRITICAL",
  write_payment_terms: "CRITICAL",
  write_merchant_managed_fulfillment_orders: "CRITICAL",
  write_third_party_fulfillment_orders: "CRITICAL",
  write_gift_cards: "CRITICAL",
  write_payment_gateways: "CRITICAL",
  write_checkouts: "CRITICAL",

  // HIGH — read access to sensitive data, write access to products/inventory
  read_customers: "HIGH",
  read_orders: "HIGH",
  write_products: "HIGH",
  write_inventory: "HIGH",
  write_fulfillments: "HIGH",
  write_shipping: "HIGH",
  write_themes: "HIGH",
  write_content: "HIGH",
  write_price_rules: "HIGH",
  write_discounts: "HIGH",
  write_marketing_events: "HIGH",
  write_draft_orders: "HIGH",
  write_script_tags: "HIGH",
  write_online_store_pages: "HIGH",

  // MEDIUM — read access to store data
  read_products: "MEDIUM",
  read_inventory: "MEDIUM",
  read_content: "MEDIUM",
  read_themes: "MEDIUM",
  read_shipping: "MEDIUM",
  read_fulfillments: "MEDIUM",
  read_draft_orders: "MEDIUM",
  read_price_rules: "MEDIUM",
  read_discounts: "MEDIUM",
  read_marketing_events: "MEDIUM",
  read_script_tags: "MEDIUM",
  read_online_store_pages: "MEDIUM",
  read_gift_cards: "MEDIUM",
  read_checkouts: "MEDIUM",
  read_payment_terms: "MEDIUM",
  read_merchant_managed_fulfillment_orders: "MEDIUM",
  read_third_party_fulfillment_orders: "MEDIUM",

  // LOW — minimal-risk scopes
  read_analytics: "LOW",
  read_locales: "LOW",
  read_markets: "LOW",
  read_reports: "LOW",
  read_shopify_payments_payouts: "LOW",
  read_store_credit: "LOW",
  read_translations: "LOW",
  read_customer_merge: "LOW",
};

// ---------------------------------------------------------------------------
// Category → expected scopes mapping
// ---------------------------------------------------------------------------

/**
 * Maps category slugs to the scopes that are reasonable for apps in that
 * category. Both top-level and leaf categories are mapped. Leaf categories
 * inherit their parent's scopes implicitly — the lookup function walks up
 * the hierarchy.
 *
 * Design principle: be generous with read scopes that are plausibly needed,
 * but strict with write scopes. The goal is to catch obvious over-permissioning,
 * not to create false positives.
 */
export const CATEGORY_EXPECTED_SCOPES: Record<string, string[]> = {
  // =========================================================================
  // FINDING PRODUCTS (top-level)
  // =========================================================================
  "finding-products": [
    "read_products",
    "write_products",
    "read_inventory",
    "write_inventory",
    "read_orders",
    "read_shipping",
    "read_fulfillments",
  ],
  "finding-products-sourcing-options-dropshipping": [
    "read_products",
    "write_products",
    "read_inventory",
    "write_inventory",
    "read_orders",
    "read_shipping",
    "read_fulfillments",
    "write_fulfillments",
    "write_shipping",
  ],
  "finding-products-sourcing-options-print-on-demand-pod": [
    "read_products",
    "write_products",
    "read_inventory",
    "write_inventory",
    "read_orders",
    "read_shipping",
    "read_fulfillments",
    "write_fulfillments",
    "write_shipping",
  ],
  "finding-products-sourcing-options-wholesale": [
    "read_products",
    "write_products",
    "read_inventory",
    "write_inventory",
    "read_orders",
    "read_price_rules",
    "read_discounts",
  ],

  // =========================================================================
  // MARKETING AND CONVERSION (top-level)
  // =========================================================================
  "marketing-and-conversion": [
    "read_products",
    "read_marketing_events",
    "write_marketing_events",
    "read_analytics",
    "read_customers",
    "read_script_tags",
    "write_script_tags",
  ],
  "marketing-and-conversion-advertising": [
    "read_products",
    "read_marketing_events",
    "write_marketing_events",
    "read_analytics",
    "read_customers",
    "read_orders",
    "read_script_tags",
    "write_script_tags",
  ],
  "marketing-and-conversion-advertising-ads": [
    "read_products",
    "read_marketing_events",
    "write_marketing_events",
    "read_analytics",
    "read_customers",
    "read_orders",
    "read_script_tags",
    "write_script_tags",
  ],
  "marketing-and-conversion-checkout": [
    "read_products",
    "read_orders",
    "read_checkouts",
    "read_script_tags",
    "write_script_tags",
    "read_discounts",
    "write_discounts",
  ],
  "marketing-and-conversion-checkout-cart-customization": [
    "read_products",
    "read_orders",
    "read_checkouts",
    "read_script_tags",
    "write_script_tags",
    "read_discounts",
    "write_discounts",
  ],
  "marketing-and-conversion-checkout-order-limits": [
    "read_products",
    "read_orders",
    "read_checkouts",
    "read_script_tags",
    "write_script_tags",
  ],
  "marketing-and-conversion-customer-loyalty": [
    "read_customers",
    "read_orders",
    "read_products",
    "read_discounts",
    "write_discounts",
    "read_price_rules",
    "write_price_rules",
  ],
  "marketing-and-conversion-customer-loyalty-donations": [
    "read_orders",
    "read_products",
    "read_checkouts",
  ],
  "marketing-and-conversion-customer-loyalty-loyalty-and-rewards": [
    "read_customers",
    "read_orders",
    "read_products",
    "read_discounts",
    "write_discounts",
    "read_price_rules",
    "write_price_rules",
    "read_script_tags",
    "write_script_tags",
  ],
  "marketing-and-conversion-customer-loyalty-wishlists": [
    "read_customers",
    "read_products",
    "read_script_tags",
    "write_script_tags",
  ],
  "marketing-and-conversion-gifts": [
    "read_products",
    "write_products",
    "read_orders",
    "read_gift_cards",
    "write_gift_cards",
  ],
  "marketing-and-conversion-gifts-gift-cards": [
    "read_products",
    "write_products",
    "read_orders",
    "read_gift_cards",
    "write_gift_cards",
  ],
  "marketing-and-conversion-gifts-gift-wrap-and-messages": [
    "read_products",
    "read_orders",
    "read_checkouts",
    "read_script_tags",
    "write_script_tags",
  ],
  "marketing-and-conversion-marketing": [
    "read_products",
    "read_customers",
    "read_marketing_events",
    "write_marketing_events",
    "read_analytics",
    "read_orders",
    "read_script_tags",
    "write_script_tags",
  ],
  "marketing-and-conversion-marketing-email-marketing": [
    "read_products",
    "read_customers",
    "read_marketing_events",
    "write_marketing_events",
    "read_analytics",
    "read_orders",
    "read_script_tags",
    "write_script_tags",
  ],
  "marketing-and-conversion-marketing-abandoned-cart": [
    "read_products",
    "read_customers",
    "read_orders",
    "read_checkouts",
    "read_marketing_events",
    "write_marketing_events",
    "read_script_tags",
    "write_script_tags",
  ],
  "marketing-and-conversion-marketing-sms-marketing": [
    "read_products",
    "read_customers",
    "read_marketing_events",
    "write_marketing_events",
    "read_orders",
    "read_script_tags",
    "write_script_tags",
  ],
  "marketing-and-conversion-marketing-web-push": [
    "read_products",
    "read_customers",
    "read_marketing_events",
    "write_marketing_events",
    "read_script_tags",
    "write_script_tags",
  ],
  "marketing-and-conversion-promotions": [
    "read_products",
    "read_discounts",
    "write_discounts",
    "read_price_rules",
    "write_price_rules",
    "read_script_tags",
    "write_script_tags",
  ],
  "marketing-and-conversion-promotions-discounts": [
    "read_products",
    "read_discounts",
    "write_discounts",
    "read_price_rules",
    "write_price_rules",
    "read_orders",
    "read_script_tags",
    "write_script_tags",
  ],
  "marketing-and-conversion-promotions-giveaways-and-contests": [
    "read_products",
    "read_customers",
    "read_discounts",
    "write_discounts",
    "read_script_tags",
    "write_script_tags",
  ],
  "marketing-and-conversion-social-trust": [
    "read_products",
    "read_orders",
    "read_script_tags",
    "write_script_tags",
  ],
  "marketing-and-conversion-social-trust-product-reviews": [
    "read_products",
    "read_orders",
    "read_customers",
    "read_script_tags",
    "write_script_tags",
    "read_content",
  ],
  "marketing-and-conversion-social-trust-social-proof": [
    "read_products",
    "read_orders",
    "read_script_tags",
    "write_script_tags",
  ],
  "marketing-and-conversion-upsell-and-bundles": [
    "read_products",
    "write_products",
    "read_orders",
    "read_discounts",
    "write_discounts",
    "read_script_tags",
    "write_script_tags",
  ],
  "marketing-and-conversion-upsell-and-bundles-countdown-timer": [
    "read_products",
    "read_script_tags",
    "write_script_tags",
    "read_themes",
  ],
  "marketing-and-conversion-upsell-and-bundles-pre-orders": [
    "read_products",
    "write_products",
    "read_orders",
    "read_inventory",
    "read_script_tags",
    "write_script_tags",
  ],
  "marketing-and-conversion-upsell-and-bundles-product-bundles": [
    "read_products",
    "write_products",
    "read_orders",
    "read_discounts",
    "write_discounts",
    "read_price_rules",
    "write_price_rules",
    "read_inventory",
    "read_script_tags",
    "write_script_tags",
  ],
  "marketing-and-conversion-upsell-and-bundles-stock-alerts": [
    "read_products",
    "read_inventory",
    "read_customers",
    "read_script_tags",
    "write_script_tags",
  ],
  "marketing-and-conversion-upsell-and-bundles-upsell-and-cross-sell": [
    "read_products",
    "write_products",
    "read_orders",
    "read_discounts",
    "write_discounts",
    "read_script_tags",
    "write_script_tags",
  ],

  // =========================================================================
  // ORDERS AND SHIPPING (top-level)
  // =========================================================================
  "orders-and-shipping": [
    "read_orders",
    "read_shipping",
    "read_fulfillments",
    "read_inventory",
    "read_products",
  ],
  "orders-and-shipping-inventory": [
    "read_inventory",
    "write_inventory",
    "read_products",
    "write_products",
    "read_orders",
    "read_locations",
  ],
  "orders-and-shipping-inventory-erp": [
    "read_inventory",
    "write_inventory",
    "read_products",
    "write_products",
    "read_orders",
    "write_orders",
    "read_customers",
    "read_fulfillments",
    "read_locations",
  ],
  "orders-and-shipping-inventory-inventory-optimization": [
    "read_inventory",
    "write_inventory",
    "read_products",
    "read_orders",
    "read_analytics",
    "read_locations",
  ],
  "orders-and-shipping-inventory-inventory-sync": [
    "read_inventory",
    "write_inventory",
    "read_products",
    "write_products",
    "read_locations",
  ],
  "orders-and-shipping-orders": [
    "read_orders",
    "write_orders",
    "read_products",
    "read_customers",
    "read_fulfillments",
  ],
  "orders-and-shipping-orders-invoices-and-receipts": [
    "read_orders",
    "read_products",
    "read_customers",
    "read_draft_orders",
  ],
  "orders-and-shipping-orders-order-editing": [
    "read_orders",
    "write_orders",
    "read_products",
    "write_products",
    "read_customers",
    "read_inventory",
  ],
  "orders-and-shipping-orders-order-tracking": [
    "read_orders",
    "read_shipping",
    "read_fulfillments",
    "read_customers",
    "read_script_tags",
    "write_script_tags",
  ],
  "orders-and-shipping-returns-and-warranty": [
    "read_orders",
    "read_customers",
    "read_products",
    "read_fulfillments",
    "read_shipping",
  ],
  "orders-and-shipping-returns-and-warranty-returns-and-exchanges": [
    "read_orders",
    "write_orders",
    "read_customers",
    "read_products",
    "read_fulfillments",
    "read_shipping",
    "write_shipping",
    "read_inventory",
    "write_inventory",
  ],
  "orders-and-shipping-returns-and-warranty-warranties-and-insurance": [
    "read_orders",
    "read_customers",
    "read_products",
    "read_fulfillments",
  ],
  "orders-and-shipping-shipping-solutions": [
    "read_orders",
    "read_shipping",
    "write_shipping",
    "read_fulfillments",
    "write_fulfillments",
    "read_products",
    "read_customers",
    "read_inventory",
  ],
  "orders-and-shipping-shipping-solutions-shipping": [
    "read_orders",
    "read_shipping",
    "write_shipping",
    "read_fulfillments",
    "write_fulfillments",
    "read_products",
    "read_customers",
    "read_inventory",
  ],

  // =========================================================================
  // SALES CHANNELS (top-level)
  // =========================================================================
  "sales-channels": [
    "read_products",
    "write_products",
    "read_orders",
    "read_inventory",
    "read_analytics",
  ],
  "marketing-and-conversion-advertising-affiliate-programs": [
    "read_products",
    "read_orders",
    "read_customers",
    "read_analytics",
    "read_marketing_events",
    "write_marketing_events",
  ],
  "sales-channels-selling-in-person": [
    "read_products",
    "read_orders",
    "read_inventory",
    "read_customers",
    "read_locations",
  ],
  "sales-channels-selling-in-person-retail": [
    "read_products",
    "read_orders",
    "read_inventory",
    "read_customers",
    "read_locations",
  ],
  "sales-channels-selling-online": [
    "read_products",
    "write_products",
    "read_orders",
    "read_inventory",
    "write_inventory",
    "read_analytics",
  ],
  "sales-channels-selling-online-marketplaces": [
    "read_products",
    "write_products",
    "read_orders",
    "write_orders",
    "read_inventory",
    "write_inventory",
    "read_shipping",
    "read_fulfillments",
    "read_customers",
  ],

  // =========================================================================
  // SELLING PRODUCTS (top-level)
  // =========================================================================
  "selling-products": ["read_products", "write_products", "read_orders", "read_inventory"],
  "selling-products-custom-products": [
    "read_products",
    "write_products",
    "read_orders",
    "read_script_tags",
    "write_script_tags",
  ],
  "selling-products-custom-products-product-variants": [
    "read_products",
    "write_products",
    "read_script_tags",
    "write_script_tags",
  ],
  "selling-products-digital-goods-and-services": [
    "read_products",
    "write_products",
    "read_orders",
    "read_customers",
    "read_fulfillments",
    "write_fulfillments",
  ],
  "selling-products-payments": [
    "read_orders",
    "read_products",
    "read_checkouts",
    "read_payment_terms",
  ],
  "selling-products-payments-subscriptions": [
    "read_orders",
    "read_products",
    "write_products",
    "read_customers",
    "read_checkouts",
    "read_script_tags",
    "write_script_tags",
  ],
  "selling-products-pricing": [
    "read_products",
    "write_products",
    "read_price_rules",
    "write_price_rules",
    "read_discounts",
    "write_discounts",
    "read_markets",
  ],

  // =========================================================================
  // STORE DESIGN (top-level)
  // =========================================================================
  "store-design": [
    "read_themes",
    "write_themes",
    "read_content",
    "read_script_tags",
    "write_script_tags",
    "read_online_store_pages",
  ],
  "store-design-storefronts": [
    "read_themes",
    "write_themes",
    "read_content",
    "write_content",
    "read_products",
    "read_script_tags",
    "write_script_tags",
    "read_online_store_pages",
    "write_online_store_pages",
  ],
  "store-design-content": [
    "read_content",
    "write_content",
    "read_products",
    "read_themes",
    "read_online_store_pages",
    "write_online_store_pages",
  ],
  "store-design-content-blogs": [
    "read_content",
    "write_content",
    "read_online_store_pages",
    "write_online_store_pages",
  ],
  "store-design-content-metafields": [
    "read_products",
    "write_products",
    "read_content",
    "write_content",
  ],
  "store-design-content-product-content": [
    "read_products",
    "write_products",
    "read_content",
    "write_content",
  ],
  "store-design-design-elements": [
    "read_themes",
    "write_themes",
    "read_script_tags",
    "write_script_tags",
  ],
  "store-design-design-elements-animation-and-effects": [
    "read_themes",
    "write_themes",
    "read_script_tags",
    "write_script_tags",
  ],
  "store-design-design-elements-badges-and-icons": [
    "read_themes",
    "write_themes",
    "read_products",
    "read_script_tags",
    "write_script_tags",
  ],
  "store-design-images-and-media": [
    "read_products",
    "write_products",
    "read_themes",
    "read_content",
    "write_content",
  ],
  "store-design-internationalization": [
    "read_locales",
    "read_translations",
    "read_markets",
    "read_products",
    "read_themes",
  ],
  "store-design-internationalization-currency-and-translation": [
    "read_locales",
    "read_translations",
    "read_markets",
    "read_products",
    "read_themes",
    "read_script_tags",
    "write_script_tags",
  ],
  "store-design-notifications": [
    "read_script_tags",
    "write_script_tags",
    "read_themes",
    "read_products",
    "read_customers",
  ],
  "store-design-notifications-banners": [
    "read_script_tags",
    "write_script_tags",
    "read_themes",
    "read_products",
  ],
  "store-design-notifications-forms": [
    "read_script_tags",
    "write_script_tags",
    "read_customers",
    "read_themes",
  ],
  "store-design-notifications-pop-ups": [
    "read_script_tags",
    "write_script_tags",
    "read_themes",
    "read_products",
    "read_customers",
  ],
  "store-design-product-display": [
    "read_products",
    "read_themes",
    "read_script_tags",
    "write_script_tags",
  ],
  "store-design-product-display-collections": [
    "read_products",
    "write_products",
    "read_themes",
    "read_script_tags",
    "write_script_tags",
  ],
  "store-design-product-display-product-comparison": [
    "read_products",
    "read_themes",
    "read_script_tags",
    "write_script_tags",
  ],
  "store-design-search-and-navigation": [
    "read_products",
    "read_themes",
    "read_content",
    "read_script_tags",
    "write_script_tags",
    "read_online_store_pages",
  ],
  "store-design-search-and-navigation-navigation-and-menus": [
    "read_themes",
    "write_themes",
    "read_online_store_pages",
    "read_script_tags",
    "write_script_tags",
  ],
  "store-design-search-and-navigation-search-and-filters": [
    "read_products",
    "read_themes",
    "read_content",
    "read_script_tags",
    "write_script_tags",
  ],
  "store-design-site-optimization": [
    "read_themes",
    "read_script_tags",
    "write_script_tags",
    "read_products",
    "read_analytics",
  ],
  "store-design-site-optimization-seo": [
    "read_products",
    "write_products",
    "read_themes",
    "read_content",
    "read_script_tags",
    "write_script_tags",
    "read_online_store_pages",
    "read_analytics",
  ],

  // =========================================================================
  // STORE MANAGEMENT (top-level)
  // =========================================================================
  "store-management": ["read_orders", "read_products", "read_analytics", "read_reports"],
  "store-management-support": [
    "read_customers",
    "read_orders",
    "read_products",
    "read_script_tags",
    "write_script_tags",
  ],
  "store-management-support-chat": [
    "read_customers",
    "read_orders",
    "read_products",
    "read_script_tags",
    "write_script_tags",
  ],
  "store-management-support-faq": [
    "read_products",
    "read_content",
    "write_content",
    "read_themes",
    "read_script_tags",
    "write_script_tags",
    "read_online_store_pages",
    "write_online_store_pages",
  ],
  "store-management-support-helpdesk": [
    "read_customers",
    "read_orders",
    "read_products",
    "read_script_tags",
    "write_script_tags",
  ],
  "store-management-support-surveys": [
    "read_customers",
    "read_orders",
    "read_script_tags",
    "write_script_tags",
  ],
  "store-management-finances": [
    "read_orders",
    "read_products",
    "read_analytics",
    "read_reports",
    "read_shopify_payments_payouts",
  ],
  "store-management-finances-accounting": [
    "read_orders",
    "read_products",
    "read_customers",
    "read_inventory",
    "read_analytics",
    "read_reports",
    "read_shopify_payments_payouts",
  ],
  "store-management-finances-taxes": [
    "read_orders",
    "read_products",
    "read_customers",
    "read_shipping",
    "read_analytics",
  ],
  "store-management-operations": ["read_orders", "read_products", "read_analytics", "read_reports"],
  "store-management-operations-analytics": [
    "read_orders",
    "read_products",
    "read_customers",
    "read_analytics",
    "read_reports",
    "read_inventory",
    "read_marketing_events",
  ],
  "store-management-operations-bulk-editor": [
    "read_products",
    "write_products",
    "read_inventory",
    "write_inventory",
    "read_orders",
  ],
  "store-management-operations-staff-notifications": [
    "read_orders",
    "read_products",
    "read_inventory",
  ],
  "store-management-operations-workflow-automation": [
    "read_orders",
    "write_orders",
    "read_products",
    "write_products",
    "read_customers",
    "read_inventory",
    "write_inventory",
    "read_fulfillments",
    "write_fulfillments",
    "read_draft_orders",
    "write_draft_orders",
    "read_script_tags",
    "write_script_tags",
  ],
  "store-management-security": [
    "read_orders",
    "read_customers",
    "read_products",
    "read_themes",
    "read_script_tags",
  ],
};

// ---------------------------------------------------------------------------
// Lookup functions
// ---------------------------------------------------------------------------

/**
 * Category parent hierarchy for walking up to find expected scopes.
 * Maps child slug → parent slug. Top-level categories have no entry.
 */
const CATEGORY_PARENTS: Record<string, string> = {
  "finding-products-sourcing-options-dropshipping": "finding-products",
  "finding-products-sourcing-options-print-on-demand-pod": "finding-products",
  "finding-products-sourcing-options-wholesale": "finding-products",
  "marketing-and-conversion-advertising": "marketing-and-conversion",
  "marketing-and-conversion-checkout": "marketing-and-conversion",
  "marketing-and-conversion-customer-loyalty": "marketing-and-conversion",
  "marketing-and-conversion-gifts": "marketing-and-conversion",
  "marketing-and-conversion-marketing": "marketing-and-conversion",
  "marketing-and-conversion-marketing-email-marketing": "marketing-and-conversion",
  "marketing-and-conversion-promotions": "marketing-and-conversion",
  "marketing-and-conversion-social-trust": "marketing-and-conversion",
  "marketing-and-conversion-social-trust-product-reviews": "marketing-and-conversion",
  "marketing-and-conversion-upsell-and-bundles": "marketing-and-conversion",
  "store-management-support": "marketing-and-conversion",
  "marketing-and-conversion-advertising-ads": "marketing-and-conversion-advertising",
  "marketing-and-conversion-checkout-cart-customization": "marketing-and-conversion-checkout",
  "marketing-and-conversion-checkout-order-limits": "marketing-and-conversion-checkout",
  "marketing-and-conversion-customer-loyalty-donations":
    "marketing-and-conversion-customer-loyalty",
  "marketing-and-conversion-customer-loyalty-loyalty-and-rewards":
    "marketing-and-conversion-customer-loyalty",
  "marketing-and-conversion-customer-loyalty-wishlists":
    "marketing-and-conversion-customer-loyalty",
  "marketing-and-conversion-gifts-gift-cards": "marketing-and-conversion-gifts",
  "marketing-and-conversion-gifts-gift-wrap-and-messages": "marketing-and-conversion-gifts",
  "marketing-and-conversion-marketing-abandoned-cart": "marketing-and-conversion-marketing",
  "marketing-and-conversion-marketing-sms-marketing": "marketing-and-conversion-marketing",
  "marketing-and-conversion-marketing-web-push": "marketing-and-conversion-marketing",
  "marketing-and-conversion-promotions-discounts": "marketing-and-conversion-promotions",
  "marketing-and-conversion-promotions-giveaways-and-contests":
    "marketing-and-conversion-promotions",
  "marketing-and-conversion-social-trust-social-proof": "marketing-and-conversion-social-trust",
  "marketing-and-conversion-upsell-and-bundles-countdown-timer":
    "marketing-and-conversion-upsell-and-bundles",
  "marketing-and-conversion-upsell-and-bundles-pre-orders":
    "marketing-and-conversion-upsell-and-bundles",
  "marketing-and-conversion-upsell-and-bundles-product-bundles":
    "marketing-and-conversion-upsell-and-bundles",
  "marketing-and-conversion-upsell-and-bundles-stock-alerts":
    "marketing-and-conversion-upsell-and-bundles",
  "marketing-and-conversion-upsell-and-bundles-upsell-and-cross-sell":
    "marketing-and-conversion-upsell-and-bundles",
  "orders-and-shipping-inventory": "orders-and-shipping",
  "orders-and-shipping-orders": "orders-and-shipping",
  "orders-and-shipping-returns-and-warranty": "orders-and-shipping",
  "orders-and-shipping-shipping-solutions": "orders-and-shipping",
  "orders-and-shipping-shipping-solutions-shipping": "orders-and-shipping",
  "orders-and-shipping-inventory-erp": "orders-and-shipping-inventory",
  "orders-and-shipping-inventory-inventory-optimization": "orders-and-shipping-inventory",
  "orders-and-shipping-inventory-inventory-sync": "orders-and-shipping-inventory",
  "orders-and-shipping-orders-invoices-and-receipts": "orders-and-shipping-orders",
  "orders-and-shipping-orders-order-editing": "orders-and-shipping-orders",
  "orders-and-shipping-orders-order-tracking": "orders-and-shipping-orders",
  "orders-and-shipping-returns-and-warranty-returns-and-exchanges":
    "orders-and-shipping-returns-and-warranty",
  "orders-and-shipping-returns-and-warranty-warranties-and-insurance":
    "orders-and-shipping-returns-and-warranty",
  "marketing-and-conversion-advertising-affiliate-programs": "sales-channels",
  "sales-channels-selling-in-person": "sales-channels",
  "sales-channels-selling-in-person-retail": "sales-channels",
  "sales-channels-selling-online": "sales-channels",
  "sales-channels-selling-online-marketplaces": "sales-channels-selling-online",
  "store-design-storefronts": "sales-channels",
  "selling-products-custom-products": "selling-products",
  "selling-products-custom-products-product-variants": "selling-products",
  "selling-products-digital-goods-and-services": "selling-products",
  "selling-products-payments": "selling-products",
  "selling-products-payments-subscriptions": "selling-products",
  "selling-products-pricing": "selling-products",
  "store-design-content": "store-design",
  "store-design-design-elements": "store-design",
  "store-design-images-and-media": "store-design",
  "store-design-internationalization": "store-design",
  "store-design-internationalization-currency-and-translation": "store-design",
  "store-design-notifications": "store-design",
  "store-design-product-display": "store-design",
  "store-design-search-and-navigation": "store-design",
  "store-design-site-optimization": "store-design",
  "store-design-site-optimization-seo": "store-design",
  "store-design-content-blogs": "store-design-content",
  "store-design-content-metafields": "store-design-content",
  "store-design-content-product-content": "store-design-content",
  "store-design-design-elements-animation-and-effects": "store-design-design-elements",
  "store-design-design-elements-badges-and-icons": "store-design-design-elements",
  "store-design-notifications-banners": "store-design-notifications",
  "store-design-notifications-forms": "store-design-notifications",
  "store-design-notifications-pop-ups": "store-design-notifications",
  "store-design-product-display-collections": "store-design-product-display",
  "store-design-product-display-product-comparison": "store-design-product-display",
  "store-design-search-and-navigation-navigation-and-menus": "store-design-search-and-navigation",
  "store-design-search-and-navigation-search-and-filters": "store-design-search-and-navigation",
  "store-management-finances": "store-management",
  "store-management-operations": "store-management",
  "store-management-operations-analytics": "store-management",
  "store-management-security": "store-management",
  "store-management-finances-accounting": "store-management-finances",
  "store-management-finances-taxes": "store-management-finances",
  "store-management-operations-bulk-editor": "store-management-operations",
  "store-management-operations-staff-notifications": "store-management-operations",
  "store-management-operations-workflow-automation": "store-management-operations",
  "store-management-support-chat": "store-management-support",
  "store-management-support-faq": "store-management-support",
  "store-management-support-helpdesk": "store-management-support",
  "store-management-support-surveys": "store-management-support",
};

/**
 * Returns the expected scopes for a category, walking up the parent hierarchy
 * if the exact slug has no mapping. Returns an empty array for unknown
 * categories (treat as "no expectations" — flag everything).
 */
function getExpectedScopesForCategory(categorySlug: string): string[] {
  let slug: string | undefined = categorySlug;

  while (slug) {
    const scopes = CATEGORY_EXPECTED_SCOPES[slug];
    if (scopes) {
      return scopes;
    }
    slug = CATEGORY_PARENTS[slug];
  }

  return [];
}

/**
 * Returns scopes from `grantedScopes` that are NOT expected for the given
 * category. These are candidates for over-permissioning alerts.
 *
 * If the category is unknown (no mapping and no parent mapping), returns
 * an empty array rather than flagging everything — unknown categories should
 * be handled at a higher level.
 */
export function getUnexpectedScopes(categorySlug: string, grantedScopes: string[]): string[] {
  const expected = getExpectedScopesForCategory(categorySlug);

  // Unknown category — can't make a judgment
  if (expected.length === 0) {
    return [];
  }

  const expectedSet = new Set(expected);
  return grantedScopes.filter((scope) => !expectedSet.has(scope));
}

/**
 * Returns the sensitivity level for a given scope handle.
 * Defaults to MEDIUM for unrecognized scopes — better to surface them
 * than to silently ignore.
 */
export function getScopeSensitivity(scope: string): ScopeSensitivity {
  return SCOPE_SENSITIVITY[scope] ?? ScopeSensitivity.MEDIUM;
}

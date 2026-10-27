/**
 * Checkout guard new-host allowlist (gc-1q1s.2): script hosts so common on
 * Shopify storefronts that reporting them as "a new script source" would only
 * train merchants to ignore the guard. A host here is never a NEW_SCRIPT_HOST
 * incident. It is still matched against the known-malicious list and the
 * loader checks, which this list never affects.
 *
 * Inclusion bar: a vendor-operated tag or SDK host, documented by the vendor
 * as the place its storefront snippet loads from (citation per entry). Never
 * a shared multi-tenant host that anyone can publish to (jsdelivr, unpkg,
 * azurefd.net, cloudfront.net, ...): a compromised file there must stay
 * visible. Matching is exact or dot-boundary on the hostname.
 */
export type GuardAllowedHost = { host: string; citation: string };

export const STOREFRONT_GUARD_ALLOWED_HOSTS: ReadonlyArray<GuardAllowedHost> = [
  {
    host: "googletagmanager.com",
    citation: "https://developers.google.com/tag-platform/gtagjs/install",
  },
  {
    host: "google-analytics.com",
    citation: "https://developers.google.com/analytics/devguides/collection/ga4",
  },
  {
    host: "connect.facebook.net",
    citation: "https://developers.facebook.com/docs/meta-pixel/get-started",
  },
  {
    host: "analytics.tiktok.com",
    citation: "https://ads.tiktok.com/help/article/get-started-pixel",
  },
  {
    host: "static.klaviyo.com",
    citation: "https://developers.klaviyo.com/en/docs/javascript_api",
  },
  {
    host: "static-tracking.klaviyo.com",
    citation: "https://developers.klaviyo.com/en/docs/javascript_api",
  },
  {
    // Shop Pay and Shop app surfaces (Shopify-operated, not under shopify.com).
    host: "shop.app",
    citation: "https://help.shopify.com/en/manual/payments/shop-pay",
  },
];

/** Whether `host` (lower case) is on the allowlist (exact or dot-boundary). */
export function isGuardAllowedHost(host: string): boolean {
  return STOREFRONT_GUARD_ALLOWED_HOSTS.some(
    (entry) => host === entry.host || host.endsWith(`.${entry.host}`),
  );
}

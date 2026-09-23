/**
 * Curated list of KNOWN-MALICIOUS domains observed injecting code into Shopify
 * themes (skimmers, fake-CDN loaders, redirect injectors). Drives the
 * MALICIOUS_SCRIPT detector.
 *
 * Inclusion bar: only add a domain with a concrete, citable source (a public
 * incident report or a verified prod observation). A false positive here tells
 * a merchant their store is compromised, so precision matters more than recall.
 * Never list a shared multi-tenant host (azurefd.net, jsdelivr.net, GTM, etc.)
 * or a subdomain whose attribution is disputed: e.g. the azurefd.net
 * `frontendInjection.js` host from the jsdeliver.cloud thread was left OUT
 * because the thread ties it to Microsoft Clarity app blocks.
 *
 * Matching is exact-or-dot-boundary on the hostname, so listing a base domain
 * covers all of its subdomains, and lookalikes of the lookalike (e.g.
 * "notjsdeliver.cloud") do NOT match.
 */
export const KNOWN_MALICIOUS_DOMAINS: ReadonlyArray<{ domain: string; note: string }> = [
  {
    // Fake "Shopify CDN" typosquatting jsDelivr (real: jsdelivr.net). Injected
    // by the unauthorized "Product Network" app and left behind after uninstall.
    // Source: community.shopify.com/t/600137; seen in prod 2026-09-22.
    domain: "jsdeliver.cloud",
    note: "lookalike of the jsDelivr CDN",
  },
  {
    // Expired Everflow tracking domain re-registered by an attacker (2021-09-24)
    // to serve a JavaScript skimmer at /scripts/shopify/click.js. Flagged by
    // Netcraft. Source: community.shopify.com/t/73409. NOT to be confused with
    // Everflow's legitimate tracker domains.
    domain: "cb28utrk.com",
    note: "hijacked tracking domain serving a card skimmer",
  },
];

/**
 * Returns the matched list entry when `hostname` is a known-malicious domain
 * (or a subdomain of one), else null. Case-insensitive.
 */
export function matchMaliciousDomain(hostname: string): { domain: string; note: string } | null {
  const host = hostname.toLowerCase();
  return (
    KNOWN_MALICIOUS_DOMAINS.find(({ domain }) => host === domain || host.endsWith(`.${domain}`)) ??
    null
  );
}

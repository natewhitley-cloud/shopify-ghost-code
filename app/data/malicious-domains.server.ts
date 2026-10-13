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
 *
 * Considered and excluded (do not add without new evidence):
 *   - bootcss.com, bootcdn.net, staticfile.net, staticfile.org: same operator
 *     as polyfill.io, but live general-purpose CDNs; only specific bootcss
 *     files were shown malicious.
 *   - unionadjs.com: re-registered by a different owner 2024-12.
 *   - polyfill.com: on a domain marketplace.
 */
export type MaliciousDomain = {
  domain: string;
  /** Merchant-facing: what the domain is, shown in brackets after it. */
  note: string;
  /**
   * Merchant-facing: replaces the default "likely injected code" wording of
   * the finding description (see maliciousDescription). Set it for a domain
   * that a theme or app developer added in good faith before it turned bad,
   * where "injected" and "compromised" would be false.
   */
  advice?: string;
  /**
   * Set ONLY for a domain that developers added to themes in good faith before
   * it turned bad. For those, a reference left inside an HTML or JS/CSS comment
   * is a remediation (the merchant or developer commented the tag out), not an
   * attack, and such domains also turn up in vendored-library comments. The
   * detector does not report those inert references. Kept separate from
   * `advice` on purpose: wording and matching are independent decisions.
   *
   * Never set it for an attacker-injected domain: nobody comments one of those
   * out in good faith, so any reference to it stays reported, comment or not.
   */
  ignoreInComments?: true;
};

export const KNOWN_MALICIOUS_DOMAINS: ReadonlyArray<MaliciousDomain> = [
  {
    // A non-Shopify lookalike of the jsDelivr CDN (real: jsdelivr.net) using a
    // `shopify.` subdomain. In community.shopify.com/t/600137 the merchant
    // reports Shopify Support calling `shopify.jsdeliver.cloud` a red flag and
    // not a legitimate Shopify domain. Seen in prod 2026-09-22 as
    // `shopify.jsdeliver.cloud/config.js`; on 2026-10-12 that URL served a copy
    // of Shopify's currency-rates script with rates frozen around mid-2023.
    // Registered 2023-06-11 (Amazon Registrar), behind Cloudflare. No
    // security-vendor analysis exists, and the thread's mention of the Product
    // Network app is the merchant's unverified guess.
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
  {
    // Sold to Funnull in Feb 2024; from June 2024 `cdn.polyfill.io` served JS
    // redirecting mobile visitors to betting/scam sites. Namecheap suspended it
    // 2024-06-27; US Treasury sanctioned Funnull 2025-05-29. Still not under
    // trusted control (2026-10). Old themes and app snippets hard-coded
    // `cdn.polyfill.io/v2|v3/polyfill.min.js`. Sources:
    // sansec.io/research/polyfill-supply-chain-attack; blog.cloudflare.com
    // (automatically-replacing-polyfill-io-links...);
    // home.treasury.gov/news/press-releases/sb0149. NEVER list the legitimate
    // replacements `cdnjs.cloudflare.com` (path /polyfill), `polyfill-fastly.io`,
    // `polyfill-fastly.net`.
    domain: "polyfill.io",
    note: "sold in 2024 and then served malicious redirects",
    advice:
      "It is no longer under trusted control. Remove this reference; modern browsers do not need it",
    ignoreInComments: true,
  },
  {
    // Fake Google Analytics host that delivered the polyfill.io payload.
    // Spelling is from Sansec and Cloudflare (g-o-o-g-i-e, a-n-a-i-y-t-i-c-s);
    // some press misspells it. Same sources as polyfill.io.
    domain: "googie-anaiytics.com",
    note: "fake Google Analytics domain that delivered malicious redirects",
  },
  {
    // `www.wp54trk.com/scripts/shopify/click.js` redirected mobile visitors to
    // betting/fake-store sites, Dec 2024 to Apr 2025. Same path shape as
    // cb28utrk.com. Evidence is Shopify Community reports only (no vendor
    // analysis): community.shopify.com/t/375008, /t/392505, /t/397689,
    // /t/410823. Unregistered as of 2026-10-12, so anyone could re-register it.
    domain: "wp54trk.com",
    note: "tracking domain reported redirecting shoppers to scam sites",
  },
  {
    // `shinedezign.tk/preorder/js/preorder.js` in theme.liquid; Shopify staff
    // named it as the cause of redirects (2023-07-15):
    // community.shopify.com/t/231016. Exact `.tk` host only; a namesake on
    // another TLD must not match (dot-boundary matching already guarantees
    // this). Single staff post, no payload analysis.
    domain: "shinedezign.tk",
    note: "script host Shopify staff tied to redirects to random sites",
    advice: "Remove this reference",
    ignoreInComments: true,
  },
  {
    // Fake checkout host in the 2026-10-10 checkout hijack delivered through a
    // compromised third-party app: shoppers were redirected to
    // `www.biliing.top/check-out/`, which posted card details to
    // `/api/submissions`. Source: romanzipp.com/blog/shopify-hit-with-phishing-attack
    // (author reported it to URLhaus and Google Safe Browsing). Spelling is the
    // attacker's (b-i-l-i-i-n-g); `billing.top` is a different domain and must
    // not match. In that incident the payload was fetched at runtime by the
    // app, not written to the theme, so this entry only catches the domain
    // when it is pasted into theme code.
    domain: "biliing.top",
    note: "fake checkout domain from a 2026 card-phishing attack on Shopify stores",
  },
  {
    // Listed next to biliing.top in the same attacker payload's redirect
    // config (same source). Named in the config only: the write-up did not
    // observe a page served from it.
    domain: "checkout-confirm.top",
    note: "domain set up for a 2026 card-phishing attack on Shopify stores",
  },
  {
    // Same payload config as checkout-confirm.top (same source, same limit).
    domain: "order-confirm.top",
    note: "domain set up for a 2026 card-phishing attack on Shopify stores",
  },
];

/**
 * Returns the matched list entry when `hostname` is a known-malicious domain
 * (or a subdomain of one), else null. Case-insensitive.
 */
export function matchMaliciousDomain(hostname: string): MaliciousDomain | null {
  // Strip a trailing FQDN dot ("jsdeliver.cloud.") so it cannot slip past.
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return (
    KNOWN_MALICIOUS_DOMAINS.find(({ domain }) => host === domain || host.endsWith(`.${domain}`)) ??
    null
  );
}

/**
 * The merchant-facing MALICIOUS_SCRIPT finding description for a list entry.
 * No trailing period, like every other finding description.
 */
export function maliciousDescription({ domain, note, advice }: MaliciousDomain): string {
  return advice
    ? `References ${domain} (${note}). ${advice}`
    : `References known-malicious domain ${domain} (${note}), likely injected code. Your theme may be compromised`;
}

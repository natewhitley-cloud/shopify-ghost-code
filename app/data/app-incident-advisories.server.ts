/**
 * Curated list of APPS NAMED IN A PUBLIC SECURITY INCIDENT REPORT. Drives the
 * APP_INCIDENT_ADVISORY detector (detectAppIncidentAdvisories, gc-14x5), which
 * tells a merchant two provable facts and nothing more: this app's code is in
 * your theme, and here is the public report. It never says or implies that the
 * store's checkout was hijacked: GhostCode reads theme files and cannot see
 * what an app loads while a shopper is browsing.
 *
 * Inclusion bar: only add an app with a concrete, citable PUBLIC incident
 * report (ideally the vendor's own statement). A false positive here names a
 * real vendor in front of their customer, so precision matters more than
 * recall. Match keys must be VERIFIED, never guessed from a vendor name or a
 * CDN path:
 *   - `scriptHosts`: seen in the report itself or in real theme code. List the
 *     exact host the app loads from; never a vendor's base domain, because a
 *     vendor's other apps use other subdomains and are not named in the report.
 *   - `embedHandles` (gc-14x5.1): the app's theme app embed block type, seen in
 *     real `config/settings_data.json` files (or a dev-store install).
 *
 * Host matching is exact-or-dot-boundary on the hostname (the same rule as
 * app/data/malicious-domains.server.ts): a listed host covers its own
 * subdomains, and neither a sibling subdomain, the parent domain nor a
 * lookalike matches.
 *
 * Embed matching: an ENABLED app embed block in the published theme's
 * settings_data.json whose `type` is a listed handle followed by one more
 * segment (the block's uuid, which is ignored). A disabled embed does not load
 * anything and never matches.
 *
 * Every entry carries a `reviewBy` date (90 days after the incident). Once it
 * has passed the entry stops firing, and a test fails so a maintainer either
 * renews it (the incident is still open) or removes it.
 *
 * Operating it (turning it on, adding or renewing an entry, the kill switch,
 * and the DELETE that is required before any rollback):
 * docs/runbooks/app-incident-advisory.md
 */
export type AppIncidentAdvisory = {
  /** The app's public name, as the merchant knows it. Merchant-facing. */
  appName: string;
  /**
   * Hosts this app's theme code loads from (lower-case, exact host). A theme
   * URL on one of these, or on a subdomain of one, is a match.
   */
  scriptHosts: readonly string[];
  /**
   * Theme app embed block types of this app, without the trailing uuid:
   * `shopify://apps/<app-handle>/blocks/<block-name>` (lower-case). An enabled
   * embed of one of these types is a match (see matchAdvisoryEmbedType).
   */
  embedHandles: readonly string[];
  /**
   * The date of the incident (or of the first public report when the incident
   * date is not known), `YYYY-MM-DD` (UTC). Merchant-facing.
   */
  incidentDate: string;
  /** The public report. */
  sourceUrl: string;
  /**
   * Merchant-facing clause that completes "an app ...". States what the
   * report says, nothing about this store. No dashes, no trailing period.
   */
  summary: string;
  /**
   * Last day (`YYYY-MM-DD`, UTC, inclusive) this entry fires without a fresh
   * look at the incident. See isAdvisoryActive.
   */
  reviewBy: string;
};

export const APP_INCIDENT_ADVISORIES: ReadonlyArray<AppIncidentAdvisory> = [
  {
    // Source: romanzipp.com/blog/shopify-hit-with-phishing-attack (2026-10-10),
    // a store owner's write-up of shoppers being redirected from the cart to a
    // fake checkout page. What is verified, and what is not:
    //   - The write-up names `productoption.hulkapps.com` as the API host that
    //     served the injected code.
    //   - Older installs load `https://productoption.hulkapps.com/hulkcode.js`
    //     straight from theme.liquid (seen in public theme repos on GitHub,
    //     2026-10-12). That script URL host is the host match key.
    //   - Vendor statement: HulkApps commented on the romanzipp.com write-up
    //     (2026-10-15, also naming Swym Wishlist Plus and Selleasy), and its
    //     merchant statement relayed on r/shopify (2026-10-17) says the
    //     checkout redirect came ONLY from the Hulk Product Options theme app
    //     extension. So current, embed-based installs are the main case.
    //   - TODO(gc-14x5.1): the app's theme app embed handle is NOT verified
    //     (not in this repo's data or tests, not yet seen in a public
    //     settings_data.json). Add it to `embedHandles` only once a dev-store
    //     install or a public settings_data.json shows the real
    //     `shopify://apps/<handle>/blocks/<block>` string. Never guess it.
    // Do NOT add `hulkapps.com` as a base domain: other HulkApps apps use
    // other subdomains (e.g. `master-motivator.hulkapps.com`) and are not named
    // in the report.
    appName: "Hulk Product Options",
    scriptHosts: ["productoption.hulkapps.com"],
    embedHandles: [],
    incidentDate: "2026-10-10",
    sourceUrl: "https://romanzipp.com/blog/shopify-hit-with-phishing-attack",
    summary: "named in a public report of shoppers being sent to a fake checkout page",
    reviewBy: "2027-01-08",
  },
  {
    // Source: the vendor's own statement, getswym.com/resources/security-response
    // (16 October 2026): an unauthorized change to the Swym Wishlist Plus app
    // configuration made a script load on some storefronts on 14 October 2026
    // (active about 10:06 to 11:56 UTC, mitigation fully deployed 16:32 UTC);
    // shoppers who clicked checkout could be sent to a site imitating a
    // checkout page. Read at source 2026-10-19.
    //   - Embed handle only. `swymrelay.com` is NOT a match key: it is shared
    //     by every Swym app, and the old theme snippet only dns-prefetches it
    //     (no script src), so it says nothing about this app loading.
    //   - Handle seen in 6+ public settings_data.json files (2026-10-19):
    //     shopify://apps/wishlist-plus/blocks/wishlist-app-embed/<uuid>.
    //     Other Swym apps have other app handles and do not match.
    appName: "Swym Wishlist Plus",
    scriptHosts: [],
    embedHandles: ["shopify://apps/wishlist-plus/blocks/wishlist-app-embed"],
    incidentDate: "2026-10-14",
    sourceUrl: "https://www.getswym.com/resources/security-response",
    summary:
      "whose developer reported that an unauthorized change to its configuration made a script load on some storefronts that could send shoppers to a fake checkout page",
    reviewBy: "2027-01-12",
  },
  {
    // Source: the vendor's own statement,
    // logbase.io/selleasy/updates/incident-20261013 (updated 16 October 2026):
    // on 13 October 2026 an unauthorized script was injected into some of the
    // stores it serves and redirected shoppers to an external phishing page.
    // Read at source 2026-10-19. The UTC window 07:47 to 15:00 is NOT in the
    // vendor statement: it comes from itnews.com.au and Selleasy's message to
    // merchants relayed on r/shopify (2026-10-17), so it stays out of the
    // merchant copy.
    //   - Host: the EXACT host `upsell-app.logbase.io` (exact-or-subdomain as
    //     for every entry). Never `logbase.io` or `cdn.logbase.io`: Logbase's
    //     other hosts are not named in the statement (the Selleasy signature's
    //     broad logbase.io match is for leftover code, not for this list).
    //   - Handle seen in public settings_data.json files (2026-10-19):
    //     shopify://apps/selleasy/blocks/app-embed/<uuid>.
    appName: "Selleasy",
    scriptHosts: ["upsell-app.logbase.io"],
    embedHandles: ["shopify://apps/selleasy/blocks/app-embed"],
    incidentDate: "2026-10-13",
    sourceUrl: "https://www.logbase.io/selleasy/updates/incident-20261013",
    summary:
      "whose developer reported that an unauthorized script on some stores sent shoppers to a phishing page",
    reviewBy: "2027-01-11",
  },
];

/**
 * True while an entry may fire: through the END of its `reviewBy` day in UTC.
 * From the next UTC day on it emits nothing until a maintainer renews or
 * removes it. ISO `YYYY-MM-DD` dates compare correctly as strings.
 */
export function isAdvisoryActive(advisory: AppIncidentAdvisory, now: Date): boolean {
  return now.toISOString().slice(0, 10) <= advisory.reviewBy;
}

/** The entries of `advisories` that may fire at `now` (see isAdvisoryActive). */
export function activeAdvisories(
  now: Date,
  advisories: ReadonlyArray<AppIncidentAdvisory> = APP_INCIDENT_ADVISORIES,
): AppIncidentAdvisory[] {
  return advisories.filter((advisory) => isAdvisoryActive(advisory, now));
}

/** A hostname's match: the list entry and which of its `scriptHosts` matched. */
export type AdvisoryHostMatch = { advisory: AppIncidentAdvisory; scriptHost: string };

/** An app embed's match: the list entry and which of its `embedHandles` matched. */
export type AdvisoryEmbedMatch = { advisory: AppIncidentAdvisory; embedHandle: string };

/** Either signal: the theme loads a listed host, or has a listed app embed turned on. */
export type AdvisoryMatch = AdvisoryHostMatch | AdvisoryEmbedMatch;

/**
 * The first entry of `advisories` that `hostname` belongs to (a listed script
 * host or a subdomain of one), else null. Case-insensitive. Review dates are
 * NOT applied here: pass only the entries that may fire.
 */
export function matchAdvisoryScriptHost(
  hostname: string,
  advisories: ReadonlyArray<AppIncidentAdvisory> = APP_INCIDENT_ADVISORIES,
): AdvisoryHostMatch | null {
  // Strip a trailing FQDN dot ("productoption.hulkapps.com.") so it cannot slip past.
  const host = hostname.toLowerCase().replace(/\.$/, "");
  for (const advisory of advisories) {
    const scriptHost = advisory.scriptHosts.find((h) => host === h || host.endsWith(`.${h}`));
    if (scriptHost !== undefined) return { advisory, scriptHost };
  }
  return null;
}

/**
 * The first entry of `advisories` that an app embed block `type` from
 * settings_data.json belongs to, else null. A match is a listed handle
 * followed by exactly one more segment (the block's uuid) or by nothing, so
 * `.../blocks/app-embed-v2/<uuid>` or another app's handle never matches.
 * Case-insensitive. Whether the embed is enabled, and review dates, are the
 * caller's job: pass only enabled embeds and the entries that may fire.
 */
export function matchAdvisoryEmbedType(
  type: string,
  advisories: ReadonlyArray<AppIncidentAdvisory> = APP_INCIDENT_ADVISORIES,
): AdvisoryEmbedMatch | null {
  const t = type.toLowerCase();
  for (const advisory of advisories) {
    const embedHandle = advisory.embedHandles.find((h) => {
      if (t === h) return true;
      if (!t.startsWith(`${h}/`)) return false;
      const rest = t.slice(h.length + 1);
      return rest.length > 0 && !rest.includes("/");
    });
    if (embedHandle !== undefined) return { advisory, embedHandle };
  }
  return null;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "2026-10-10" as "10 October 2026" (no locale, no time zone involved). */
export function formatAdvisoryDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

/**
 * The merchant-facing APP_INCIDENT_ADVISORY finding description. Facts only:
 * the theme loads the app's code (host signal) or has the app's embed turned
 * on (embed signal), and a public report names the app. The two signals read
 * differently, so the stored description records which one matched. No
 * trailing period, like every other finding description.
 */
export function advisoryDescription(match: AdvisoryMatch): string {
  const { advisory } = match;
  const report = `an app ${advisory.summary} (${formatAdvisoryDate(advisory.incidentDate)})`;
  if ("embedHandle" in match) {
    return `Has the ${advisory.appName} app embed turned on, ${report}`;
  }
  return `Loads code from ${advisory.appName} (${match.scriptHost}), ${report}`;
}

/** Every description an entry can produce: one per script host, one per embed handle. */
export function advisoryDescriptions(advisory: AppIncidentAdvisory): string[] {
  return [
    ...advisory.scriptHosts.map((scriptHost) => advisoryDescription({ advisory, scriptHost })),
    ...advisory.embedHandles.map((embedHandle) => advisoryDescription({ advisory, embedHandle })),
  ];
}

/**
 * Curated list of APPS NAMED IN A PUBLIC SECURITY INCIDENT REPORT. Drives the
 * APP_INCIDENT_ADVISORY detector (detectAppIncidentAdvisories, gc-14x5), which
 * tells a merchant two provable facts and nothing more: this app's code is in
 * your theme, and here is the public report. It never says or implies that the
 * store's checkout was hijacked: GhostCode reads theme files and cannot see
 * what an app loads while a shopper is browsing.
 *
 * Inclusion bar: only add an app with a concrete, citable PUBLIC incident
 * report. A false positive here names a real vendor in front of their
 * customer, so precision matters more than recall. Match keys (`scriptHosts`)
 * must be VERIFIED (seen in the report itself or in real theme code), never
 * guessed from a vendor name or a CDN path. List the exact host the app loads
 * from; never a vendor's base domain, because a vendor's other apps use other
 * subdomains and are not named in the report.
 *
 * Matching is exact-or-dot-boundary on the hostname (the same rule as
 * app/data/malicious-domains.server.ts): a listed host covers its own
 * subdomains, and neither a sibling subdomain, the parent domain nor a
 * lookalike matches.
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
  /** The date of the incident report, `YYYY-MM-DD` (UTC). Merchant-facing. */
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
    //     2026-10-12). That script URL host is the ONLY match key.
    //   - The app's theme app embed handle is NOT verified and is deliberately
    //     not matched yet. Add it only after a dev-store install shows the real
    //     `shopify://apps/<handle>/` string in settings_data.json.
    //   - The developer has made no public statement we could find, so the
    //     cause and whether it is fixed are unknown.
    // Do NOT add `hulkapps.com` as a base domain: other HulkApps apps use
    // other subdomains (e.g. `master-motivator.hulkapps.com`) and are not named
    // in the report.
    appName: "Hulk Product Options",
    scriptHosts: ["productoption.hulkapps.com"],
    incidentDate: "2026-10-10",
    sourceUrl: "https://romanzipp.com/blog/shopify-hit-with-phishing-attack",
    summary: "named in a public report of shoppers being sent to a fake checkout page",
    reviewBy: "2027-01-08",
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
 * the theme loads the app's code, and a public report names the app. No
 * trailing period, like every other finding description.
 */
export function advisoryDescription({ advisory, scriptHost }: AdvisoryHostMatch): string {
  return `Loads code from ${advisory.appName} (${scriptHost}), an app ${advisory.summary} (${formatAdvisoryDate(advisory.incidentDate)})`;
}

/**
 * Checkout guard on Home (gc-1q1s.6): the views the loader passes to the page
 * and every sentence the incident banners and the status line say. Pure and
 * client-safe: no React, no server imports. Dates are rendered by the page
 * (FormattedDate), so the copy here is the words around them.
 *
 * Copy rules (spike section B): facts only, plain words, no dashes. Never say
 * the checkout is hijacked (Tier 1 reads markup, it does not click checkout).
 * For a listed domain, say Shopify may block shoppers from being sent there
 * but the code still runs on the store.
 */

export type GuardIncidentKind = "KNOWN_MALICIOUS" | "SCRIPT_LOADER" | "NEW_SCRIPT_HOST";

/** One open incident as Home shows it. */
export interface GuardIncidentView {
  id: string;
  kind: GuardIncidentKind;
  /** The host as seen (null for a host-less loader). */
  host: string | null;
  /** KNOWN_MALICIOUS: the listed domain the host matched; else null. */
  domain: string | null;
  /** KNOWN_MALICIOUS: what the list says the domain is; else null. */
  note: string | null;
  pages: "home" | "cart" | "both";
  sourceLabel: string;
  openedAt: string;
  lastSeenAt: string;
  seenCount: number;
}

export type GuardStatusState =
  | "waiting"
  | "ok"
  | "paused_password"
  | "paused_redirect"
  | "unreachable";

/** Home's one status line under the banners (only while the guard is live). */
export interface GuardStatusView {
  state: GuardStatusState;
  cadence: "hourly" | "daily";
  /** ok: the last readable check; unreachable: the last readable check, or null. */
  date: string | null;
  primaryHost: string | null;
  redirectHost: string | null;
}

export interface GuardHomeView {
  incidents: GuardIncidentView[];
  status: GuardStatusView | null;
}

/** The compromised-app checklist guide (public site). */
export const GUARD_GUIDE_URL =
  "https://alpenglowsoftware.com/guides/shopify-app-compromised-checklist/";
export const GUARD_GUIDE_LABEL = "Read the checklist";
export const GUARD_ACKNOWLEDGE = "This is expected";
export const GUARD_PLAN_NOTE = "shown on every plan";
/** The red bar's label for KNOWN_MALICIOUS and SCRIPT_LOADER. */
export const GUARD_RISK_LABEL = "Security risk";

/** "your homepage", "your cart page", "your homepage and cart page". */
export function guardPagesLabel(pages: GuardIncidentView["pages"]): string {
  if (pages === "both") return "your homepage and cart page";
  return pages === "cart" ? "your cart page" : "your homepage";
}

export function guardIncidentTitle(i: GuardIncidentView): string {
  switch (i.kind) {
    case "KNOWN_MALICIOUS":
      return `Your live store loads code from ${i.domain ?? i.host ?? "a domain"}, a domain linked to malicious code`;
    case "SCRIPT_LOADER":
      return i.host
        ? `Code on your live store loads a script from ${i.host} in an unusual way`
        : "Code on your live store builds a script in an unusual way";
    case "NEW_SCRIPT_HOST":
      return `A new script source started loading on your store: ${i.host ?? "unknown"}`;
  }
}

/** The banner's facts: what the guard saw, where, and what it means. */
export function guardIncidentBody(i: GuardIncidentView): string {
  const where = `${guardPagesLabel(i.pages)} (${i.sourceLabel.charAt(0).toLowerCase()}${i.sourceLabel.slice(1)})`;
  switch (i.kind) {
    case "KNOWN_MALICIOUS": {
      const listed =
        i.domain && i.note
          ? ` GhostCode lists ${i.domain} as a source of malicious code (${i.note}).`
          : "";
      const seen = i.host && i.domain && i.host !== i.domain ? ` as ${i.host}` : "";
      return (
        `GhostCode's checkout guard saw it${seen} on ${where}.${listed} ` +
        "Shopify may block shoppers from being sent to a domain it has flagged, but this code still runs on your store. " +
        "Find what adds it as soon as possible."
      );
    }
    case "SCRIPT_LOADER":
      return (
        `GhostCode's checkout guard found code on ${where} that builds or loads a script. ` +
        "Themes, apps and leftover code rarely do this; code injected into menus and checkout buttons often does. Check it now."
      );
    case "NEW_SCRIPT_HOST":
      return (
        `GhostCode's checkout guard saw it on ${where}. ` +
        "If you didn't add an app or change your theme recently, check it. If you did, mark it as expected."
      );
  }
}

/** The "What to check" steps for a security incident (KNOWN_MALICIOUS, SCRIPT_LOADER). */
export const GUARD_CHECK_STEPS: readonly string[] = [
  "Turn off any app embed you don't recognize or added recently (Online Store > Themes > Customize > App embeds).",
  "Look for code in your menu item names and in your checkout button text (Online Store > Navigation, and your theme's cart settings).",
  "Test your checkout in a private browser window and make sure the payment page is on your store's own domain or Shopify's checkout.",
  "If you can't find it, contact Shopify Support and tell them what GhostCode found.",
];

/** "Seen 3 times, last on" (the page renders the date after it), or null for one sighting. */
export function guardSightingsLead(i: GuardIncidentView): string | null {
  return i.seenCount > 1 ? `Seen ${i.seenCount} times, last on` : null;
}

/** The status line, around its date: `{lead}{date}{tail}` (date null = none). */
export function guardStatusWords(s: GuardStatusView): { lead: string; tail: string } {
  const every = s.cadence === "hourly" ? "every hour" : "once a day";
  switch (s.state) {
    case "waiting":
      return {
        lead: `Checkout guard is on. Its first check of your homepage and cart page runs within ${s.cadence === "hourly" ? "the hour" : "a day"}.`,
        tail: "",
      };
    case "ok":
      return {
        lead: "Checkout guard last read your storefront on",
        tail: `. It checks your homepage and cart page ${every}.`,
      };
    case "paused_password":
      return {
        lead: "Checkout guard is paused while your store is password-protected.",
        tail: "",
      };
    case "paused_redirect":
      return {
        lead: `Checkout guard reads ${s.primaryHost ?? "your store"}, but your store sends our US-based check to ${s.redirectHost ?? "another domain"}, so it can't check your storefront.`,
        tail: "",
      };
    case "unreachable":
      return s.date
        ? { lead: "Checkout guard couldn't read your storefront since", tail: ". It keeps trying." }
        : { lead: "Checkout guard couldn't read your storefront yet. It keeps trying.", tail: "" };
  }
}

/**
 * Merge guard incidents with the scan's malicious-code banners by domain
 * (one banner per domain): a KNOWN_MALICIOUS incident whose listed domain
 * already has a scan banner is folded into it (`seenByGuard`, domain ->
 * lastSeenAt), and only the rest render as guard banners.
 */
export function mergeGuardWithScanRisks(
  incidents: readonly GuardIncidentView[],
  scanDomains: ReadonlySet<string>,
): { standalone: GuardIncidentView[]; seenByGuard: Record<string, string> } {
  const standalone: GuardIncidentView[] = [];
  const seenByGuard: Record<string, string> = {};
  for (const i of incidents) {
    if (i.kind === "KNOWN_MALICIOUS" && i.domain && scanDomains.has(i.domain)) {
      const prior = seenByGuard[i.domain];
      if (!prior || prior < i.lastSeenAt) seenByGuard[i.domain] = i.lastSeenAt;
      continue;
    }
    standalone.push(i);
  }
  return { standalone, seenByGuard };
}

/**
 * The incidents to show after "This is expected" clicks (optimistic): every
 * incident not acknowledged on this page, plus the one the server last
 * REFUSED to acknowledge (`answer` is the action's reply once the request
 * settled), so a refused click never leaves an incident hidden (audit fix).
 */
export function guardIncidentsToShow<T extends { id: string }>(
  incidents: readonly T[],
  acknowledgedIds: ReadonlySet<string>,
  answer: { acknowledged?: boolean; incidentId?: string } | null | undefined,
): T[] {
  const refused = answer?.acknowledged === false ? (answer.incidentId ?? null) : null;
  return incidents.filter((i) => i.id === refused || !acknowledgedIds.has(i.id));
}

/** The line added to a scan banner the guard also saw: "{lead} {date}." */
export const GUARD_ALSO_SEEN_LEAD =
  "GhostCode's checkout guard also saw it on your live store, last on";

// Email consent notice (gc-1q1s.7)

export const GUARD_NOTICE_HEADING = "Checkout guard alerts are on";
export const GUARD_NOTICE_TURN_OFF = "Turn off";
export const GUARD_NOTICE_OK = "Got it";

/** The notice's sentence; a generic address when the owner email is unknown. */
export function guardNoticeLead(email: string | null): string {
  const to = email ?? "your store's owner email address";
  return (
    `Checkout guard alerts will be emailed to ${to}. ` +
    "We email only when GhostCode finds known malicious code or a script loader on your live store, never routine updates."
  );
}

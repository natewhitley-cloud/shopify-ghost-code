/**
 * Theme health checklist (gc-i6du): the latest scan as a plain list of what
 * was checked and what each check found, with a concrete cost where the scan
 * has one (extra requests, Liquid errors shoppers can read, records left).
 *
 * Not here: KB and processing time from the speed report. Home must render
 * with no dependency on speed data (tests/integration/speed-report-decoupling,
 * owner decision 2026-10-11), so those numbers stay on the Store speed page.
 *
 * NO score, grade, percentage or "x of y" headline, here or in any consumer:
 * the 0-100 health score was removed on 2026-10-09 (gc-k2ub) because a
 * composite misled merchants. Each row stands on its own.
 *
 * Where the lanes (finding-consequence.ts) answer "what is this costing me",
 * this answers "what did you check, and is it clean". Every FindingType lands
 * in exactly ONE category (HEALTH_CATEGORY_OF is an exhaustive Record, so a
 * new type does not compile until it is placed), plus two rows that are not
 * findings: the theme's own type/version, and the unpublished themes.
 *
 * Plan gating: a row carries COUNTS and fixed copy only, never a file, a line,
 * a snippet or an app name, so Free sees exactly what paid plans see here and
 * nothing is unlocked.
 *
 * Pure and client-safe: no React, no server imports.
 */

import type { FindingType } from "@prisma/client";

import { isStorefrontFinding } from "./finding-classification";
import type { ThemeInfo } from "./theme-info";

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export type HealthCategoryKey =
  | "malicious"
  | "liquid-errors"
  | "shopper-visible"
  | "scripts-styles"
  | "snippets-sections"
  | "seo-ai"
  | "tracking"
  | "store-data"
  | "script-tag-deadline";

/**
 * Fixed display order, label and a one-line "what this checks" for each
 * category. Labels are merchant copy: plain words, no em dashes.
 */
export const HEALTH_CATEGORIES: ReadonlyArray<{
  key: HealthCategoryKey;
  label: string;
  checks: string;
}> = [
  {
    key: "malicious",
    label: "Known malicious code",
    checks: "Code that loads from sources known to steal data or redirect shoppers.",
  },
  {
    // Its OWN row (not folded into the next one): it is checked from the
    // storefront, so its status must never be masked by theme-file checks.
    key: "liquid-errors",
    label: "Liquid errors on your homepage",
    checks:
      "Errors your homepage prints because your theme renders a snippet that no longer exists.",
  },
  {
    key: "shopper-visible",
    label: "Broken links and leftover app text",
    checks:
      "Links to products, collections or pages that no longer exist, and app text or chat widgets left on your pages.",
  },
  {
    key: "scripts-styles",
    label: "Leftover scripts and styles",
    checks: "Scripts, stylesheets, fonts and app calls from apps you removed.",
  },
  {
    key: "snippets-sections",
    label: "Leftover snippets and sections",
    checks: "Snippets, sections, layouts and settings an app left in your theme.",
  },
  {
    key: "seo-ai",
    label: "SEO and AI tags",
    checks: "Tags that tell Google and AI assistants what your store and products are.",
  },
  {
    key: "tracking",
    label: "Tracking still running",
    checks: "Tracking pixels from removed apps, and trackers set up twice.",
  },
  {
    key: "store-data",
    label: "Store data left behind",
    checks: "Product tags, prices, pages, metafields, redirects and translations an app left.",
  },
  {
    key: "script-tag-deadline",
    label: "Script tag deadline",
    checks: "Apps that still load through script tags, which Shopify is retiring.",
  },
];

/**
 * The finding types the checklist covers: every FindingType but an
 * affected-app advisory (gc-14x5). An advisory is a notice about a public
 * report, not something the scan found wrong in the theme, so it is in no
 * row: it never counts under "Leftover scripts and styles", never changes a
 * row's coverage when its flag is flipped, and has no cost line here.
 */
export type HealthFindingType = Exclude<FindingType, "APP_INCIDENT_ADVISORY">;

/**
 * THE MAPPING: every FindingType to the ONE checklist category it counts in.
 * `Record<FindingType, ...>` makes the compiler enforce completeness; a test
 * also asserts it against the runtime enum and that every category is used.
 * No type is excluded: a finding the scan stores always shows up in a row.
 */
export const HEALTH_CATEGORY_OF: Record<HealthFindingType, HealthCategoryKey> = {
  MALICIOUS_SCRIPT: "malicious",

  LIQUID_ERROR_RENDERED: "liquid-errors",

  GHOST_TEXT: "shopper-visible",
  DANGLING_REFERENCE: "shopper-visible",
  OVERLAPPING_CHAT_WIDGET: "shopper-visible",

  GHOST_SCRIPT: "scripts-styles",
  GHOST_STYLE: "scripts-styles",
  GHOST_PRECONNECT: "scripts-styles",
  GHOST_FONT: "scripts-styles",
  GHOST_AJAX: "scripts-styles",
  DUPLICATE_LIBRARY: "scripts-styles",

  GHOST_SNIPPET: "snippets-sections",
  GHOST_SECTION: "snippets-sections",
  ORPHAN_ASSET: "snippets-sections",
  GHOST_LAYOUT: "snippets-sections",
  SETTINGS_DRIFT: "snippets-sections",
  GHOST_APP_EMBED: "snippets-sections",
  // The retired checkout.liquid file: dead code still sitting in the theme.
  CHECKOUT_SUNSET: "snippets-sections",

  GHOST_HREFLANG: "seo-ai",
  DUPLICATE_META: "seo-ai",
  GHOST_JSON_LD: "seo-ai",
  JSON_LD_CONFLICT: "seo-ai",
  JSON_LD_PRICE_CONFLICT: "seo-ai",
  JSON_LD_INVALID: "seo-ai",
  GHOST_ROBOTS: "seo-ai",
  GHOST_CANONICAL: "seo-ai",
  GHOST_TITLE: "seo-ai",
  GHOST_OG: "seo-ai",

  GHOST_PIXEL: "tracking",
  DUPLICATE_TRACKER: "tracking",

  GHOST_TAG: "store-data",
  GHOST_PRICE: "store-data",
  GHOST_PAGE: "store-data",
  GHOST_METAFIELD: "store-data",
  GHOST_REDIRECT: "store-data",
  GHOST_TRANSLATION: "store-data",

  // Both are about the 2027-03-01 move from script tags to app embeds.
  SCRIPT_TAG_SUNSET: "script-tag-deadline",
  APP_EMBED_OFF: "script-tag-deadline",
};

/** The finding types counted in `category`, in enum-map order. */
export function typesForHealthCategory(category: HealthCategoryKey): HealthFindingType[] {
  return (Object.keys(HEALTH_CATEGORY_OF) as HealthFindingType[]).filter(
    (type) => HEALTH_CATEGORY_OF[type] === category,
  );
}

// ---------------------------------------------------------------------------
// Coverage: was each type actually checked by this scan?
// ---------------------------------------------------------------------------

/**
 * Why a type was (or was not) checked by the scan, so a row never says "Clean"
 * about something nobody looked at.
 *   - checked:     the check ran in full.
 *   - capped:      it ran, but a size cap left part unchecked.
 *   - permission:  skipped, its optional permission is not granted.
 *   - unreachable: the public storefront homepage could not be read.
 *   - unpublished: a storefront check, and this scan was not the published theme.
 *   - plan:        the plan does not include the check (Broken links,
 *                  checkout.liquid on Free).
 *   - not_run:     the check is switched on NOW, but this scan did not run it:
 *                  the scan is older than the check (or than its flag), the
 *                  check failed on that scan, or the scan never recorded what
 *                  it ran. A new scan will run it.
 *   - dark:        the check is not switched on for anyone right now
 *                  (soft-launch flag). A dark type is left out of its row
 *                  entirely: the merchant has never been offered it.
 */
export type TypeCoverage =
  | "checked"
  | "capped"
  | "permission"
  | "unreachable"
  | "unpublished"
  | "plan"
  | "not_run"
  | "dark";

/** A reason part of a row was not checked. */
type Gap = Exclude<TypeCoverage, "checked" | "dark">;

/** What a scan recorded about its own coverage (the Scan row's columns). */
export interface HealthCoverageInput {
  skippedCategories: readonly string[];
  cappedCategories: readonly string[];
  unreachableCategories: readonly string[];
  /** Parsed `Scan.liveFindingTypes`; null = a legacy scan that never recorded it. */
  liveTypes: ReadonlySet<string> | null;
  /**
   * The finding types switched on RIGHT NOW (not suppressed by a soft-launch
   * flag). A type absent from here is dark for everyone; a type here that the
   * scan did not run is `not_run`, never "Clean".
   */
  liveNow: ReadonlySet<string>;
  /** Finding types the shop's PLAN does not run (findingTypesWithheldByPlan). */
  planWithheld: readonly string[];
  /** Whether the scanned theme is the published one (null = not known). */
  isPublishedTheme: boolean | null;
}

/** How `type` was covered by a scan. See TypeCoverage for the meanings. */
export function coverageForType(type: FindingType, scan: HealthCoverageInput): TypeCoverage {
  if (scan.planWithheld.includes(type)) return "plan";
  if (scan.unreachableCategories.includes(type)) return "unreachable";
  if (scan.skippedCategories.includes(type)) return "permission";
  // Off for everyone now: nothing to promise, whatever the scan recorded.
  if (!scan.liveNow.has(type)) return "dark";
  if (scan.liveTypes === null || !scan.liveTypes.has(type)) {
    // The check is on now, but this scan did not run it. For a storefront
    // finding on another theme that is by design; otherwise the scan predates
    // the check, the check failed on it, or it recorded nothing (legacy).
    return isStorefrontFinding(type) && scan.isPublishedTheme === false ? "unpublished" : "not_run";
  }
  if (scan.cappedCategories.includes(type)) return "capped";
  return "checked";
}

/** Why part of a row was not checked, most useful to act on first. */
const GAP_ORDER: ReadonlyArray<Gap> = [
  "unreachable",
  "not_run",
  "permission",
  "plan",
  "unpublished",
  "capped",
];

/**
 * Why a row was not (fully) checked. Home states each sentence ONCE, under the
 * names of every check it applies to, so the wording fits one check or several
 * and ends with what to do where there is something to do.
 */
const GAP_COPY: Record<Gap, string> = {
  unreachable:
    "We couldn't read your storefront homepage, for example because it has a password. Run a new scan once the homepage can be read.",
  not_run: "Not checked on your last scan. Run a new scan to try again.",
  permission: "Needs a permission you haven't allowed yet. You can allow it in Settings.",
  plan: "Checked in full on Standard and Professional.",
  unpublished: "Only checked on your published theme.",
  capped: "Your store has more of these than one scan checks, so part wasn't checked.",
};

/** `not_run` when only PART of the row was not run. */
const PARTLY_NOT_RUN = "Partly checked on your last scan. Run a new scan to try again.";

/** What the plan leaves out of a row, named (the two plan-gated checks). */
const PLAN_GAP_COPY: Partial<Record<HealthCategoryKey, string>> = {
  "shopper-visible": "Broken links are checked on Standard and Professional.",
  "snippets-sections": "Old checkout code is checked on Standard and Professional.",
};

/**
 * What a size cap left out of a row, named where "more of these" would name
 * the wrong thing (gc-wnhs): the Liquid error check is capped by the theme's
 * missing snippets, not by Liquid errors.
 */
const CAPPED_GAP_COPY: Partial<Record<HealthCategoryKey, string>> = {
  "liquid-errors":
    "Your theme is missing more snippets than one scan checks, so part wasn't checked.",
};

/** The line explaining a row's gap. `whole` = no check in the row ran. */
function gapLine(reason: Gap, category: HealthCategoryKey, whole: boolean): string {
  if (reason === "plan") return PLAN_GAP_COPY[category] ?? GAP_COPY.plan;
  if (reason === "capped") return CAPPED_GAP_COPY[category] ?? GAP_COPY.capped;
  if (reason === "not_run" && !whole) return PARTLY_NOT_RUN;
  return GAP_COPY[reason];
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * - issues:      something was found (the count is in `statusLabel`).
 * - clean:       every check in the row ran and found nothing.
 * - partial:     nothing found, but part of the row was not checked.
 * - not_checked: no check in the row ran.
 * - info:        a fact, not a pass or a fail (theme version, theme inventory).
 */
export type HealthStatus = "issues" | "clean" | "partial" | "not_checked" | "info";

export interface HealthRow {
  /** A category key, "theme" or "unpublished-themes". */
  key: HealthCategoryKey | "theme" | "unpublished-themes";
  label: string;
  /** One line on what the row covers. Always shown. */
  checks: string;
  status: HealthStatus;
  /** "Clean", "3 issues", "Not checked", "Vintage theme", "2 unpublished"... */
  statusLabel: string;
  /** Findings counted in the row (0 for the two rows that are not findings). */
  count: number;
  /** The concrete cost, or why it was not checked. Null when there is nothing to add. */
  detail: string | null;
  /** Where to look at the findings, or null when there is nothing to open. */
  href: string | null;
}

/** One theme of the store, as the Admin API lists it. */
export interface ThemeInventoryItem {
  id: string;
  name: string;
  role: string;
  /** Findings in this theme's latest successful scan; null = never scanned. */
  lastScanFindingCount: number | null;
}

/** Shopify's theme library limit (stores on Shopify Plus can hold more). */
export const THEME_LIBRARY_LIMIT = 20;
/** At most this many scanned unpublished themes are named in the row. */
export const MAX_NAMED_UNPUBLISHED_THEMES = 3;

type TypeCounts = Partial<Record<FindingType, number>>;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Join cost phrases into one sentence: "A, B and C." */
function sentence(parts: string[]): string {
  if (parts.length === 0) return "";
  const joined =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`;
}

/**
 * The concrete cost of a category's findings, from counts only. Each phrase is
 * a number of things the merchant can picture, never a rating.
 */
export function healthCostLine(
  category: HealthCategoryKey,
  counts: TypeCounts,
  opts: { scriptTagsStopped: boolean },
): string {
  const n = (...types: FindingType[]) => types.reduce((sum, t) => sum + (counts[t] ?? 0), 0);
  const parts: string[] = [];
  switch (category) {
    case "malicious": {
      const k = n("MALICIOUS_SCRIPT");
      return `${plural(k, "piece", "pieces")} of code from a known malicious source ${k === 1 ? "is" : "are"} in your theme. It can steal shopper data or send your customers to other sites.`;
    }
    case "liquid-errors": {
      const k = n("LIQUID_ERROR_RENDERED");
      return `Your homepage prints ${plural(k, "Liquid error", "Liquid errors")} because your theme renders ${k === 1 ? "a snippet" : "snippets"} that no longer ${k === 1 ? "exists" : "exist"}. ${k === 1 ? "It" : "They"} can be inside a menu or a hidden section.`;
    }
    case "shopper-visible": {
      const links = n("DANGLING_REFERENCE");
      const text = n("GHOST_TEXT");
      const chat = n("OVERLAPPING_CHAT_WIDGET");
      if (links > 0) parts.push(plural(links, "broken link", "broken links"));
      if (text > 0) {
        parts.push(plural(text, "piece of leftover app text", "pieces of leftover app text"));
      }
      if (chat > 0) parts.push("more than one chat widget loading at once");
      return sentence(parts);
    }
    case "scripts-styles": {
      const requests = n("GHOST_SCRIPT", "GHOST_STYLE", "GHOST_FONT", "GHOST_AJAX");
      const hints = n("GHOST_PRECONNECT");
      const duplicates = n("DUPLICATE_LIBRARY");
      if (requests > 0) {
        parts.push(
          `${plural(requests, "extra request", "extra requests")} to apps you removed, on every page that loads ${requests === 1 ? "it" : "them"}`,
        );
      }
      if (hints > 0) parts.push(plural(hints, "wasted connection hint", "wasted connection hints"));
      if (duplicates > 0) {
        parts.push(
          plural(duplicates, "library loaded more than once", "libraries loaded more than once"),
        );
      }
      return sentence(parts);
    }
    case "snippets-sections": {
      const code = n("GHOST_SNIPPET", "GHOST_SECTION", "GHOST_LAYOUT", "ORPHAN_ASSET");
      const settings = n("SETTINGS_DRIFT", "GHOST_APP_EMBED");
      if (code > 0) {
        parts.push(
          `${plural(code, "leftover snippet, section or file", "leftover snippets, sections and files")} in your theme code`,
        );
      }
      if (settings > 0)
        parts.push(plural(settings, "leftover theme setting", "leftover theme settings"));
      if (n("CHECKOUT_SUNSET") > 0) parts.push("a checkout.liquid file Shopify no longer runs");
      return sentence(parts);
    }
    case "seo-ai": {
      const k = n(...typesForHealthCategory("seo-ai"));
      return `${plural(k, "tag gives", "tags give")} Google and AI assistants wrong or conflicting information about your store.`;
    }
    case "tracking": {
      const pixels = n("GHOST_PIXEL");
      const twice = n("DUPLICATE_TRACKER");
      if (pixels > 0) {
        parts.push(
          `${plural(pixels, "tracking pixel", "tracking pixels")} that may still send shopper data to apps you removed`,
        );
      }
      if (twice > 0) parts.push(plural(twice, "tracker set up twice", "trackers set up twice"));
      return sentence(parts);
    }
    case "store-data": {
      const k = n(...typesForHealthCategory("store-data"));
      return `${plural(k, "leftover record", "leftover records")} in your products, pages, redirects and translations.`;
    }
    case "script-tag-deadline": {
      const tags = n("SCRIPT_TAG_SUNSET");
      const embeds = n("APP_EMBED_OFF");
      if (tags > 0)
        parts.push(`${plural(tags, "app still loads", "apps still load")} through script tags`);
      if (embeds > 0) parts.push(`${plural(embeds, "app embed is", "app embeds are")} turned off`);
      const deadline = opts.scriptTagsStopped
        ? "Shopify stopped running script tags on March 1, 2027."
        : "Shopify stops running script tags on March 1, 2027.";
      return `${sentence(parts)} ${deadline}`;
    }
  }
}

function issuesLabel(count: number): string {
  return plural(count, "issue", "issues");
}

/**
 * Where a row's findings open on the scan page: filtered to the type when the
 * plan shows the full list and the row's findings are all ONE type (the page
 * filters by a single type), else the scan page itself.
 */
function findingsHref(
  scanId: string,
  category: HealthCategoryKey,
  counts: TypeCounts,
  fullList: boolean,
): string {
  const present = typesForHealthCategory(category).filter((t) => (counts[t] ?? 0) > 0);
  // Malicious findings live in the security alert on the unfiltered page.
  if (fullList && present.length === 1 && present[0] !== "MALICIOUS_SCRIPT") {
    return `/app/scans/${scanId}?type=${encodeURIComponent(present[0])}`;
  }
  return `/app/scans/${scanId}`;
}

/** "Dawn 15.2.0 by Shopify", from whatever the theme lists about itself. */
export function themeTitle(info: ThemeInfo, fallbackName: string): string {
  const name = info.name ?? fallbackName;
  return `${name}${info.version ? ` ${info.version}` : ""}${info.author ? ` by ${info.author}` : ""}`;
}

const THEME_ROW_CHECKS =
  "Your theme's name and version, and whether it is an Online Store 2.0 theme.";

function themeRow(info: ThemeInfo | null, scanThemeName: string): HealthRow {
  const base = { key: "theme" as const, label: "Theme type and version", checks: THEME_ROW_CHECKS };
  const none = { count: 0, href: null };
  if (info === null) {
    return {
      ...base,
      ...none,
      status: "not_checked",
      statusLabel: "Not checked",
      detail: "Run a new scan to see your theme's name, version and type.",
    };
  }
  const title = themeTitle(info, scanThemeName);
  if (info.architecture === "vintage") {
    return {
      ...base,
      ...none,
      status: "issues",
      statusLabel: "Vintage theme",
      // Accurate to Shopify: a vintage theme CAN use app embed blocks (they
      // load through the layout), but not app blocks, which need JSON
      // templates (sections on every page).
      detail: `${title} is a vintage theme, not Online Store 2.0. It can't use app blocks, so an app that adds something to a page has to write its code into your theme files, and that code stays there when you remove the app. App embeds still work on it.`,
    };
  }
  if (info.architecture === "os2") {
    return { ...base, ...none, status: "clean", statusLabel: "Online Store 2.0", detail: title };
  }
  return { ...base, ...none, status: "info", statusLabel: "Type not detected", detail: title };
}

const UNPUBLISHED_CHECKS = "Themes in your library that shoppers don't see.";

/**
 * The store's theme library (development themes are not part of it). Null when
 * the list was not available: the row is left out rather than guessed.
 */
function unpublishedThemesRow(themes: readonly ThemeInventoryItem[] | null): HealthRow | null {
  if (themes === null) return null;
  const library = themes.filter((t) => t.role !== "DEVELOPMENT");
  if (library.length === 0) return null;
  const unpublished = library.filter((t) => t.role !== "MAIN");
  const limit = `Your store has ${plural(library.length, "theme", "themes")}. Shopify allows ${THEME_LIBRARY_LIMIT} (more on Plus).`;
  const scanned = unpublished
    .filter(
      (t): t is ThemeInventoryItem & { lastScanFindingCount: number } =>
        t.lastScanFindingCount !== null,
    )
    .sort((a, b) => b.lastScanFindingCount - a.lastScanFindingCount);
  const named = scanned
    .slice(0, MAX_NAMED_UNPUBLISHED_THEMES)
    .map((t) => `${t.name}: ${plural(t.lastScanFindingCount, "finding", "findings")}`);
  const more = scanned.length - named.length;
  const leftovers =
    named.length === 0
      ? ""
      : ` In their last scans: ${named.join("; ")}${more > 0 ? `; and ${more} more` : ""}.`;
  return {
    key: "unpublished-themes",
    label: "Unpublished themes",
    checks: UNPUBLISHED_CHECKS,
    status: "info",
    statusLabel: unpublished.length === 0 ? "None" : `${unpublished.length} unpublished`,
    count: 0,
    detail: `${limit}${leftovers}`,
    href: null,
  };
}

/**
 * Home's critical "known malicious code" line: the malicious category's row for
 * a scan in which `count` MALICIOUS_SCRIPT findings were found, or null when
 * there are none. `count` is what the scan FOUND, ignored findings included
 * (the same rule as the scan page's security alert): ignoring a malicious
 * finding does not take the code out of the theme. Built on its own, from the
 * count alone, so Home can show it even when the checklist rows are missing.
 * The same row buildThemeHealthChecklist emits for that count, on every plan.
 */
export function maliciousHealthRow(scanId: string, count: number): HealthRow | null {
  if (count <= 0) return null;
  const category = HEALTH_CATEGORIES.find((c) => c.key === "malicious")!;
  const counts: TypeCounts = { MALICIOUS_SCRIPT: count };
  return {
    key: category.key,
    label: category.label,
    checks: category.checks,
    status: "issues",
    statusLabel: issuesLabel(count),
    count,
    detail: healthCostLine(category.key, counts, { scriptTagsStopped: false }),
    href: findingsHref(scanId, category.key, counts, false),
  };
}

export interface ThemeHealthInput {
  scanId: string;
  /**
   * The scan's (ignore-filtered) finding counts per type. MALICIOUS_SCRIPT is
   * the exception: callers pass what the scan found, ignored findings included.
   */
  typeCounts: TypeCounts;
  coverage: HealthCoverageInput;
  /** True when the plan shows the full finding list (Standard, Professional). */
  fullList: boolean;
  /** Parsed `Scan.themeInfo`; null = legacy scan. */
  themeInfo: ThemeInfo | null;
  /** The scanned theme's name as the merchant named it (fallback title). */
  scanThemeName: string;
  /** The store's themes; null = the list was not available. */
  themes: readonly ThemeInventoryItem[] | null;
  /** Whether Shopify has already stopped running script tags (2027-03-01). */
  scriptTagsStopped: boolean;
}

/**
 * The checklist's rows, in display order: the nine finding categories, then
 * the theme's type and version, then the unpublished themes.
 *
 * A category whose every type is dark (not switched on for anyone right now)
 * and that has no findings is left out: nothing was promised there. A check
 * that IS on now but that this scan did not run reads "Not checked" (or "None
 * found" when only part of the row was not run), never "Clean".
 */
export function buildThemeHealthChecklist(input: ThemeHealthInput): HealthRow[] {
  const rows: HealthRow[] = [];

  for (const category of HEALTH_CATEGORIES) {
    const types = typesForHealthCategory(category.key);
    const count = types.reduce((sum, t) => sum + (input.typeCounts[t] ?? 0), 0);
    const covered = types
      .map((t) => coverageForType(t, input.coverage))
      .filter((c): c is Exclude<TypeCoverage, "dark"> => c !== "dark");
    const base = { key: category.key, label: category.label, checks: category.checks };

    if (count > 0) {
      rows.push({
        ...base,
        status: "issues",
        statusLabel: issuesLabel(count),
        count,
        detail: healthCostLine(category.key, input.typeCounts, {
          scriptTagsStopped: input.scriptTagsStopped,
        }),
        href: findingsHref(input.scanId, category.key, input.typeCounts, input.fullList),
      });
      continue;
    }
    if (covered.length === 0) continue;

    const gaps = covered.filter((c): c is Gap => c !== "checked");
    const reason = GAP_ORDER.find((g) => gaps.includes(g));
    const none = { count: 0, href: null };
    if (!reason) {
      rows.push({ ...base, ...none, status: "clean", statusLabel: "Clean", detail: null });
    } else if (gaps.filter((g) => g !== "capped").length === covered.length) {
      // A capped check RAN (a size cap left part unchecked), so it never makes
      // the row "Not checked": a row with only capped checks is partial.
      rows.push({
        ...base,
        ...none,
        status: "not_checked",
        statusLabel: "Not checked",
        detail: gapLine(reason, category.key, true),
      });
    } else {
      rows.push({
        ...base,
        ...none,
        status: "partial",
        statusLabel: "None found",
        detail: gapLine(reason, category.key, false),
      });
    }
  }

  rows.push(themeRow(input.themeInfo, input.scanThemeName));
  const unpublished = unpublishedThemesRow(input.themes);
  if (unpublished) rows.push(unpublished);
  return rows;
}

const CATEGORY_KEYS: ReadonlySet<string> = new Set(HEALTH_CATEGORIES.map((c) => c.key));

/** The checklist's rows as Home groups them. See groupHealthRows. */
export interface HealthRowGroups {
  /** The theme's type and version row, or null when it is absent. */
  theme: HealthRow | null;
  /** The unpublished themes row, or null when it is absent. */
  unpublished: HealthRow | null;
  /** Finding categories whose status is exactly "clean", in their order. */
  clean: HealthRow[];
  /** Finding categories that were not checked or only partly checked. */
  gaps: HealthRow[];
  /**
   * True when a finding category other than malicious code found something
   * (status "issues"). Those rows are in no group (the lanes show them), but
   * the verdict's dot must not be green over them. The theme row's "issues"
   * (a vintage theme) does not count: it is a theme fact, not a finding.
   */
  hasIssues: boolean;
  /**
   * The malicious-code row, ONLY when it has findings (status "issues"); null
   * otherwise. Security findings are never hidden: Home has no other place
   * that names known malicious code on its own. The row passed to
   * groupHealthRows wins over the one in `rows`.
   */
  malicious: HealthRow | null;
}

/**
 * Group the checklist for Home, which shows only what the consequence lanes
 * cannot: the theme facts, the checks that came back clean, and the checks
 * that did not (fully) run. Each group keeps the rows' existing order.
 *
 * A finding category with status "issues" is in NO group: the lanes above the
 * section already show those findings. The one exception is malicious code
 * with findings, which is `malicious` (the lanes only count it among other
 * findings, and a security finding is never hidden). A category is in `clean` ONLY when its
 * status is exactly "clean"; "partial" and "not_checked" go to `gaps`, never
 * to `clean`. The theme and unpublished-themes rows are facts, not checks, so
 * they are never in `clean` or `gaps` whatever their status.
 *
 * `malicious` is the scan's malicious row built independently of `rows` (see
 * maliciousHealthRow). When given it IS the malicious group, even with no rows
 * at all, and known malicious code is then never named under `clean`.
 */
export function groupHealthRows(
  rows: readonly HealthRow[],
  malicious: HealthRow | null = null,
): HealthRowGroups {
  const groups: HealthRowGroups = {
    theme: null,
    unpublished: null,
    clean: [],
    gaps: [],
    hasIssues: false,
    malicious,
  };
  for (const row of rows) {
    if (row.key === "theme") groups.theme = row;
    else if (row.key === "unpublished-themes") groups.unpublished = row;
    else if (!CATEGORY_KEYS.has(row.key)) continue;
    else if (row.status === "clean") groups.clean.push(row);
    else if (row.status === "partial" || row.status === "not_checked") groups.gaps.push(row);
    else if (row.status !== "issues") continue;
    else if (row.key === "malicious") groups.malicious ??= row;
    else groups.hasIssues = true;
  }
  if (groups.malicious) groups.clean = groups.clean.filter((row) => row.key !== "malicious");
  return groups;
}

// ---------------------------------------------------------------------------
// Home's verdict line and action box
// ---------------------------------------------------------------------------

/**
 * The verdict dot's colour. With no known malicious code found:
 *   - "ok" (green):     every check ran in full and no check found anything.
 *   - "neutral" (grey): every check ran in full, but another check found
 *                       something (those findings are in Home's lanes).
 *   - "warn" (amber):   a check did not (fully) run. Also the tone when the
 *                       malicious check itself did not run in full.
 */
export type HealthVerdictTone = "ok" | "neutral" | "warn";

export interface HealthVerdict {
  tone: HealthVerdictTone;
  /** One short sentence. Never a digit, a count, a score or "x of y". */
  text: string;
}

const VERDICT_CLEAN = "No known malicious code found.";
const VERDICT_MALICIOUS_UNCHECKED =
  "Some checks couldn't run, including the check for malicious code.";
const VERDICT_GAPS = "No known malicious code found. Some checks couldn't run.";
const VERDICT_PARTIAL_GAPS = "No known malicious code found. Some checks only partly ran.";

/**
 * The one-sentence verdict at the top of Home's theme health section, or null
 * when the critical malicious line is showing (that line IS the verdict).
 *
 * "No known malicious code found" is said ONLY when the malicious row's status
 * is exactly "clean" (it is in `groups.clean`, which groupHealthRows also
 * empties of malicious whenever the critical line shows). "Known" because the
 * check matches a list of known malicious sources: it cannot rule out code
 * nobody has listed yet. A malicious row that was not checked, only partly
 * checked, or is missing altogether (a legacy scan) gets the sentence that
 * names the malicious check as one that could not run.
 *
 * With no gap the sentence is the same whether or not other checks found
 * something; only the dot differs (see HealthVerdictTone), so a green dot
 * never sits under lanes that list findings.
 */
export function themeHealthVerdict(groups: HealthRowGroups): HealthVerdict | null {
  if (groups.malicious) return null;
  const maliciousClean = groups.clean.some(
    (row) => row.key === "malicious" && row.status === "clean",
  );
  if (!maliciousClean) return { tone: "warn", text: VERDICT_MALICIOUS_UNCHECKED };
  if (groups.gaps.length === 0) {
    return { tone: groups.hasIssues ? "neutral" : "ok", text: VERDICT_CLEAN };
  }
  const allPartial = groups.gaps.every((row) => row.status === "partial");
  return { tone: "warn", text: allPartial ? VERDICT_PARTIAL_GAPS : VERDICT_GAPS };
}

/** The checks that share one reason for not (fully) running. */
export interface GapReasonGroup {
  /** The reason sentence (a gap row's `detail`); null when the rows carry none. */
  reason: string | null;
  /** The labels of the checks it applies to, in row order. */
  labels: string[];
}

/**
 * Gap rows grouped by their reason, so a reason shared by several checks is
 * stated once. Groups are in the order each reason first appears.
 */
export function groupGapsByReason(gaps: readonly HealthRow[]): GapReasonGroup[] {
  const groups: GapReasonGroup[] = [];
  for (const row of gaps) {
    const existing = groups.find((group) => group.reason === row.detail);
    if (existing) existing.labels.push(row.label);
    else groups.push({ reason: row.detail, labels: [row.label] });
  }
  return groups;
}

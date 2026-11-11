/**
 * Clean copy view model (gc-tib slice 5).
 *
 * Pure and client-safe (no .server imports): the selection and status routes
 * render only what this module returns, so every merchant-facing rule and
 * every line of copy lives here. Machine codes (reason codes, statuses) never
 * reach the page; each one maps to plain copy with a generic fallback.
 *
 * Copy rules (guide/style-guide.md): short plain sentences, no em dashes, the
 * code is "leftover code", never "ghost code".
 */

import { themeIdToNumeric } from "./theme-editor-url";

/**
 * The access scope a clean copy needs. Mirrors WRITE_THEMES_SCOPE in
 * clean-copy.server.ts, which this client-safe module cannot import.
 */
export const CLEAN_COPY_SCOPE = "write_themes";

// ---------------------------------------------------------------------------
// Candidates (the selection page)
// ---------------------------------------------------------------------------

export const CANDIDATE_BLOCK_REASONS = [
  "APP_HAS_LIVE_EMBED",
  "APP_UNKNOWN",
  "NO_SPAN",
  "IGNORED",
  "PATH_NOT_ALLOWED",
  /** The live file no longer matches the scan. */
  "FILE_CHANGED",
] as const;

export type CandidateBlockReason = (typeof CANDIDATE_BLOCK_REASONS)[number];

export type CleanCopyCandidate = {
  findingId: string;
  findingType: string;
  filename: string;
  lineNumber: number;
  appName: string | null;
  /** The exact code that will be removed, read live from the main theme. Null when blocked. */
  spanText: string | null;
  blocked: CandidateBlockReason | null;
};

const CANDIDATE_BLOCK_COPY: Record<CandidateBlockReason, string> = {
  APP_HAS_LIVE_EMBED:
    "This app still has an app embed turned on in your theme. Turn it off in the theme editor, then run a new scan.",
  APP_UNKNOWN:
    "We can't tell which app this code came from, so we can't confirm it's safe to remove.",
  NO_SPAN:
    "We can't remove this one automatically. It may be commented out, or its start and end aren't clear.",
  IGNORED: "You ignored this finding. Un-ignore it to include it in a clean copy.",
  PATH_NOT_ALLOWED: "This file is one we don't edit in a clean copy.",
  FILE_CHANGED: "This file changed after your scan. Run a new scan to include it.",
};

const GENERIC_BLOCK_COPY = "This code can't be removed in a clean copy.";

export function candidateBlockCopy(reason: CandidateBlockReason): string {
  return CANDIDATE_BLOCK_COPY[reason] ?? GENERIC_BLOCK_COPY;
}

/**
 * Copy for a finding the service refused when the merchant submitted (a
 * FindingRefusal). Block reasons reuse the candidate copy.
 */
export function findingRefusalCopy(reason: string): string {
  switch (reason) {
    case "APP_NOT_CONFIRMED":
      return "Confirm you've uninstalled this app first.";
    case "NOT_IN_SCAN":
      return "This finding isn't part of this scan.";
    case "NOT_FIXABLE_TYPE":
      return "We can't remove this kind of finding automatically.";
    case "MANIFEST_MD5_MISSING":
      return "We can't check this file against your scan, so it can't be removed.";
    default:
      return (CANDIDATE_BLOCK_REASONS as readonly string[]).includes(reason)
        ? candidateBlockCopy(reason as CandidateBlockReason)
        : GENERIC_BLOCK_COPY;
  }
}

export type CandidateGroup = {
  appName: string | null;
  selectable: CleanCopyCandidate[];
  blocked: CleanCopyCandidate[];
};

function compareCandidates(a: CleanCopyCandidate, b: CleanCopyCandidate): number {
  if (a.filename !== b.filename) return a.filename < b.filename ? -1 : 1;
  return a.lineNumber - b.lineNumber;
}

/**
 * Group by app: apps sorted by name, the unknown app (null) last; inside a
 * group by filename then line, split into selectable and blocked. One candidate
 * with a live app embed blocks the whole app (the embed is still running).
 */
export function groupCandidatesByApp(cands: readonly CleanCopyCandidate[]): CandidateGroup[] {
  const byApp = new Map<string | null, CleanCopyCandidate[]>();
  for (const c of cands) {
    const list = byApp.get(c.appName);
    if (list) list.push(c);
    else byApp.set(c.appName, [c]);
  }
  const groups: CandidateGroup[] = [];
  for (const [appName, list] of byApp) {
    const embedLive = list.some((c) => c.blocked === "APP_HAS_LIVE_EMBED");
    const resolved = list.map((c) =>
      embedLive ? { ...c, spanText: null, blocked: "APP_HAS_LIVE_EMBED" as const } : c,
    );
    resolved.sort(compareCandidates);
    groups.push({
      appName,
      selectable: resolved.filter((c) => c.blocked === null),
      blocked: resolved.filter((c) => c.blocked !== null),
    });
  }
  groups.sort((a, b) => {
    if (a.appName === b.appName) return 0;
    if (a.appName === null) return 1;
    if (b.appName === null) return -1;
    return a.appName < b.appName ? -1 : 1;
  });
  return groups;
}

// ---------------------------------------------------------------------------
// Run refusals and failures
// ---------------------------------------------------------------------------

/**
 * Every RunRefusal of the service, plus RUN_ACTIVE and DISPATCH_FAILED, plus
 * the worker failure reasons that need their own explanation.
 */
export const RUN_REFUSAL_REASONS = [
  "FLAG_OFF",
  "EMPTY_SELECTION",
  "SHOP_NOT_FOUND",
  "NOT_PROFESSIONAL",
  "SCOPE_MISSING",
  "SCAN_NOT_FOUND",
  "SCAN_STALE",
  "NO_MAIN_THEME",
  "ACCESS_DENIED",
  "ADMIN_UNAVAILABLE",
  "MANIFEST_MISSING",
  "EMBED_STATUS_UNKNOWN",
  "TOO_MANY_FILES",
  "TOO_MANY_FINDINGS",
  "FINDINGS_REFUSED",
  "RUN_ACTIVE",
  "DISPATCH_FAILED",
  "CANVAS_THEME",
  "NOTHING_REMOVED",
  "INCOMPLETE",
  "INTERNAL_ERROR",
  "DUPLICATE_FAILED",
  "COPY_PUBLISHED_DURING_WRITE",
] as const;

export type RunRefusalReason = (typeof RUN_REFUSAL_REASONS)[number];

const COPY_NOT_SAFE =
  "We stopped because the copy didn't look safe to change. Nothing was changed in your live theme.";

/** Reasons the worker writes onto a run after it started (FixRun.failureReason). */
const WORKER_FAILURE_COPY: Record<string, string> = {
  DUPLICATE_PROCESSING_FAILED:
    "Shopify couldn't finish copying your theme. Try again in a few minutes.",
  DUPLICATE_TIMEOUT:
    "Shopify took too long to copy your theme. Try again later, and delete any unfinished copy from Online Store > Themes.",
  COPY_IS_SOURCE: COPY_NOT_SAFE,
  COPY_MISSING: COPY_NOT_SAFE,
  COPY_NOT_UNPUBLISHED: COPY_NOT_SAFE,
  NO_COPY: COPY_NOT_SAFE,
  WRITE_REFUSED: COPY_NOT_SAFE,
  STALE: "This clean copy took too long and was stopped. Try again.",
};

const RUN_REFUSAL_COPY: Record<RunRefusalReason, string> = {
  FLAG_OFF: "Clean copy isn't available for your store yet.",
  EMPTY_SELECTION: "Select at least one piece of leftover code to remove.",
  SHOP_NOT_FOUND: "We couldn't find your store. Reload the app and try again.",
  NOT_PROFESSIONAL: "Clean copy is part of the Professional plan.",
  SCOPE_MISSING:
    "GhostCode needs your permission to change themes. Allow theme changes, then try again.",
  SCAN_NOT_FOUND: "We couldn't find that scan. Go back to your scans and try again.",
  SCAN_STALE:
    "Your theme changed after this scan, so the results may be out of date. Run a new scan, then make a clean copy from the new results.",
  NO_MAIN_THEME: "We couldn't find your live theme. Check Online Store > Themes and try again.",
  ACCESS_DENIED:
    "Shopify didn't allow GhostCode to change themes for this store. Contact support if this keeps happening.",
  ADMIN_UNAVAILABLE: "We couldn't reach Shopify just now. Try again in a few minutes.",
  MANIFEST_MISSING:
    "This scan is missing the file details we need to make a safe copy. Run a new scan and try again.",
  EMBED_STATUS_UNKNOWN:
    "We couldn't check which apps still have an app embed turned on. Run a new scan and try again.",
  TOO_MANY_FILES:
    "Your selection touches too many files for one copy. Select less leftover code and try again.",
  TOO_MANY_FINDINGS: "You selected too much leftover code at once. Select less and try again.",
  FINDINGS_REFUSED:
    "Some of the code you selected can't be removed. See the notes below, then try again.",
  RUN_ACTIVE:
    "A clean copy is already being made for your store. Wait for it to finish, then try again.",
  DISPATCH_FAILED: "We couldn't start your clean copy. Try again in a few minutes.",
  CANVAS_THEME: "Clean copy doesn't support Canvas themes yet.",
  NOTHING_REMOVED:
    "We couldn't remove any of the code you selected. If those files changed after your scan, run a new scan and try again.",
  INCOMPLETE: "Your clean copy stopped before it finished. Try again.",
  INTERNAL_ERROR: "Something went wrong while making your clean copy. Try again in a few minutes.",
  DUPLICATE_FAILED:
    "Shopify couldn't copy your theme. Your store may be at its theme limit. Delete themes you don't use from Online Store > Themes, then try again.",
  COPY_PUBLISHED_DURING_WRITE:
    "The copy was published while we were still removing code from it, so we stopped.",
};

const GENERIC_RUN_COPY = "We couldn't make your clean copy. Try again in a few minutes.";

/** Plain copy for a refusal or a run's failureReason. Unknown codes get generic copy. */
export function runRefusalCopy(reason: string | null | undefined): string {
  if (!reason) return GENERIC_RUN_COPY;
  if (Object.prototype.hasOwnProperty.call(RUN_REFUSAL_COPY, reason)) {
    return RUN_REFUSAL_COPY[reason as RunRefusalReason];
  }
  if (Object.prototype.hasOwnProperty.call(WORKER_FAILURE_COPY, reason)) {
    return WORKER_FAILURE_COPY[reason];
  }
  return GENERIC_RUN_COPY;
}

// ---------------------------------------------------------------------------
// Per-item results
// ---------------------------------------------------------------------------

const VALIDATION_FAILED_PREFIX = "VALIDATION_FAILED:";

const VALIDATION_COPY: Record<string, string> = {
  OVERLAPPING_SPANS: "Skipped. This code overlaps another piece you selected.",
  IN_NON_CODE_REGION: "Skipped. This code sits inside a comment or a block we don't edit.",
  UNBALANCED_LIQUID: "Skipped. Removing it would break the Liquid code around it.",
};

const VALIDATION_GENERIC = "Skipped. We couldn't confirm that removing this code was safe.";

const ITEM_REASON_COPY: Record<string, string> = {
  FILE_CHANGED: "Skipped. This file changed after your scan, so we left it alone.",
  CHECKSUM_UNVERIFIABLE: "Skipped. We couldn't confirm this file matched your scan.",
  SPAN_MISMATCH: "Skipped. The code in this file no longer matches what the scan found.",
  UPSERT_FAILED: "Not removed. Shopify didn't accept the change to this file.",
  JOB_TIMEOUT:
    "Not removed. Shopify took too long to save this file. Check the copy before you publish it.",
  POST_WRITE_MISMATCH: "Not removed. We couldn't confirm the change was saved correctly.",
  NOT_FIXABLE_TYPE: "Skipped. We can't remove this kind of finding automatically.",
  INCOMPLETE: "Not removed. The run ended before we got to this one.",
  COPY_PUBLISHED_DURING_WRITE:
    "Not confirmed. The copy was published before we could check this change.",
};

const ITEM_GENERIC = "Not removed. Something went wrong with this one.";

/**
 * Copy for one FixItem's reasonCode; null means the item was removed. Run-level
 * reasons copied onto items (SCAN_STALE, ...) reuse the run copy.
 */
export function fixItemReasonCopy(code: string | null | undefined): string {
  if (code === null || code === undefined) return "Removed.";
  if (code.startsWith(VALIDATION_FAILED_PREFIX)) {
    const reason = code.slice(VALIDATION_FAILED_PREFIX.length);
    return Object.prototype.hasOwnProperty.call(VALIDATION_COPY, reason)
      ? VALIDATION_COPY[reason]
      : VALIDATION_GENERIC;
  }
  if (Object.prototype.hasOwnProperty.call(ITEM_REASON_COPY, code)) return ITEM_REASON_COPY[code];
  const runCopy = runRefusalCopy(code);
  return runCopy === GENERIC_RUN_COPY ? ITEM_GENERIC : `Not removed. ${runCopy}`;
}

// ---------------------------------------------------------------------------
// Run summary (the status page banner)
// ---------------------------------------------------------------------------

export type SummaryTone = "info" | "success" | "warning" | "critical";

export type RunSummary = {
  tone: SummaryTone;
  heading: string;
  body: string;
  showPreview: boolean;
  /** True while the run can still change (the page polls). */
  active: boolean;
};

export type RunSummaryInput = {
  status: string;
  doNotPublish: boolean;
  failureReason: string | null;
  items: ReadonlyArray<{ status: string }>;
  /** The run made a copy theme (it stays in the store until the merchant deletes it). */
  hasCopy?: boolean;
};

const ACTIVE_HEADINGS: Record<string, string> = {
  pending: "Starting your clean copy",
  duplicating: "Copying your theme",
  writing: "Removing leftover code from the copy",
};

const LIVE_THEME_UNCHANGED = "Your live theme was not changed.";
const DELETE_LEFTOVER_COPY =
  "We made a copy of your theme before this stopped. Delete it from Online Store > Themes before you try again.";
const PUBLISH_YOURSELF =
  "Preview the copy, then publish it from Online Store > Themes when you're happy with it.";

function pieces(n: number): string {
  return n === 1 ? "1 piece" : `${n} pieces`;
}

export function runSummary(input: RunSummaryInput): RunSummary {
  const active = Object.prototype.hasOwnProperty.call(ACTIVE_HEADINGS, input.status);
  const removed = input.items.filter((i) => i.status === "removed").length;
  const total = input.items.length;

  // The merchant published the copy mid-write: it IS the live theme now, so
  // "your live theme was not changed" would be false.
  if (input.failureReason === "COPY_PUBLISHED_DURING_WRITE") {
    return {
      tone: "critical",
      heading: "The copy was published before we finished",
      body: `${runRefusalCopy(input.failureReason)} It's now your live theme, and we can't confirm every change in it. Publish your previous theme again from Online Store > Themes, then make a new clean copy.`,
      showPreview: false,
      active: false,
    };
  }
  if (input.doNotPublish) {
    return {
      tone: "critical",
      heading: "Don't publish this copy",
      body: `We couldn't confirm that every change in this copy was saved correctly, so don't publish it. ${LIVE_THEME_UNCHANGED} Delete the copy from Online Store > Themes, then try again or contact support.`,
      showPreview: false,
      active,
    };
  }
  if (active) {
    return {
      tone: "info",
      heading: ACTIVE_HEADINGS[input.status],
      body: "We're making an unpublished copy of your theme and removing the code you selected from it. Don't publish the copy until this finishes. This page updates on its own. It usually takes a minute or two.",
      showPreview: false,
      active,
    };
  }
  if (input.status === "completed") {
    return {
      tone: "success",
      heading: "Your clean copy is ready",
      body: `We removed ${pieces(removed)} of leftover code from a copy of your theme. ${LIVE_THEME_UNCHANGED} ${PUBLISH_YOURSELF}`,
      showPreview: true,
      active,
    };
  }
  if (input.status === "partial") {
    return {
      tone: "warning",
      heading: "Your clean copy is ready, with some code left in",
      body: `We removed ${removed} of ${total} pieces of leftover code from a copy of your theme. The rest are listed below with the reason. ${LIVE_THEME_UNCHANGED} ${removed > 0 ? PUBLISH_YOURSELF : ""}`.trim(),
      showPreview: removed > 0,
      active,
    };
  }
  if (input.status === "failed") {
    return {
      tone: "critical",
      heading: "We couldn't make your clean copy",
      body: [
        runRefusalCopy(input.failureReason),
        LIVE_THEME_UNCHANGED,
        input.hasCopy ? DELETE_LEFTOVER_COPY : "",
      ]
        .filter(Boolean)
        .join(" "),
      showPreview: false,
      active,
    };
  }
  // A status this page does not know: say so plainly, never show a preview.
  return {
    tone: "warning",
    heading: "We're not sure how this clean copy went",
    body: `Reload this page in a minute. ${LIVE_THEME_UNCHANGED}`,
    showPreview: false,
    active: false,
  };
}

// ---------------------------------------------------------------------------
// Live theme after the copy (spike §3 stale-copy warning, audit H2)
// ---------------------------------------------------------------------------

/**
 * What happened to the live theme since the copy was made:
 *   unchanged       MAIN is still the source theme and not edited since
 *   changed         another theme was published, or MAIN was edited after the
 *                   copy was made: publishing the copy would lose those edits
 *   published_copy  the merchant already published this clean copy
 */
export type LiveThemeState = "unchanged" | "changed" | "published_copy";

export function liveThemeState(input: {
  mainId: string;
  mainUpdatedAt: Date | null;
  sourceThemeId: string;
  copyThemeId: string;
  copyCreatedAt: Date | null;
}): LiveThemeState {
  if (input.mainId === input.copyThemeId) return "published_copy";
  if (input.mainId !== input.sourceThemeId) return "changed";
  if (input.mainUpdatedAt && input.copyCreatedAt && input.mainUpdatedAt > input.copyCreatedAt) {
    return "changed";
  }
  return "unchanged";
}

export type LiveThemeNotice = { tone: SummaryTone; text: string } | null;

export const LIVE_THEME_CHANGED_COPY =
  "Your live theme changed after this clean copy was made. Make a new copy so you don't lose those changes.";
export const PUBLISHED_COPY_COPY = "You published this clean copy.";

export function liveThemeNotice(state: LiveThemeState | null): LiveThemeNotice {
  if (state === "changed") return { tone: "warning", text: LIVE_THEME_CHANGED_COPY };
  if (state === "published_copy") return { tone: "info", text: PUBLISHED_COPY_COPY };
  return null;
}

// ---------------------------------------------------------------------------
// Preview link
// ---------------------------------------------------------------------------

const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

/**
 * The storefront preview link for the unpublished copy. Null without a usable
 * theme id or when the domain is not a plain `*.myshopify.com` host.
 */
export function previewUrl(
  shopDomain: string,
  copyThemeGid: string | null | undefined,
): string | null {
  if (!SHOP_DOMAIN.test(shopDomain)) return null;
  const numeric = themeIdToNumeric(copyThemeGid);
  if (!numeric) return null;
  return `https://${shopDomain}/?preview_theme_id=${numeric}`;
}

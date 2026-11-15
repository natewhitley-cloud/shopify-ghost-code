/**
 * Value-action card model (gc-np1d.2). Rule: ~/.claude/rules/merchant-ux.md;
 * page map: docs/ux/page-map.md (approved mockup v3, Nathan 2026-11-14).
 *
 * One card per page, chosen by plan and state, so Home and the scan page lead
 * with the same thing to do:
 *   - Professional: remove it for you (trial-capped; a new scan first when the
 *     scan is too old to remove from). Falls back to "fix it yourself" while
 *     Clean copy is off for the shop or can't remove any of it.
 *   - Standard: fix it yourself first, upgrade to have it removed second (4B).
 *   - Free: what was found, and the upgrade.
 *   - Nothing found: all clear, with the reason to scan again (if any).
 *
 * Pure: routes compute the inputs and render what this returns.
 */
import { PLANS } from "./plans";

export type ValueActionPlan = "free" | "standard" | "professional";

export type ValueActionApp = { name: string; count: number };

export type ValueActionInput = {
  plan: ValueActionPlan;
  /** Clean copy is on for this shop (global flag or allowlist). */
  cleanCopyOn: boolean;
  /** The theme has a finished scan; before that the onboarding card owns the page. */
  hasCompletedScan: boolean;
  themeName: string;
  /**
   * Everything the scan found (every finding type, ignores left out), by app.
   * "All clear" only when this is zero (audit r1 HIGH: counting the removable
   * kinds only showed All clear over a list of findings).
   */
  leftovers: { total: number; apps: ValueActionApp[] };
  /**
   * Professional only: what Clean copy can do with this scan. `ready` with the
   * count the select page would offer and those findings by app; `stale` when a
   * new scan of the live theme is needed first; `none` when it can't remove any
   * of it. Null on other plans.
   */
  cleanCopy: { state: "ready" | "stale" | "none"; count: number; apps?: ValueActionApp[] } | null;
  /** Professional free trial: removals left and the day the rest unlock. */
  trial: { remaining: number; unlocksOn: string } | null;
  lastScanDaysAgo: number;
  themeChangedSinceScan: boolean;
};

export type ValueActionKind = "clean_copy" | "scan_first" | "diy" | "upsell" | "clear";

/** What a button does; the route maps each to a link or a submit. */
export type ValueActionVerb = "clean_copy" | "scan" | "diy" | "upgrade" | "plans";

export type ValueActionButton = { label: string; action: ValueActionVerb };

export type ValueActionCard = {
  kind: ValueActionKind;
  heading: string;
  body: string;
  /** One short line next to the primary button. */
  note: string | null;
  apps: ValueActionApp[];
  primary: ValueActionButton | null;
  secondary: ValueActionButton | null;
  /** Funnel key for the card's shown + primary click (nudge-stage). */
  telemetryKey: "clean_copy_action" | "clean_copy_diy" | "clean_copy_upsell" | null;
  /** Funnel key for a secondary upgrade action, when the card has one. */
  upsellKey: "clean_copy_upsell" | null;
};

/** Where the stale-scan reason and the all-clear age nudge start. */
export const RESCAN_AFTER_DAYS = 30;

const pieces = (n: number) => `${n} ${n === 1 ? "piece" : "pieces"}`;
const appsYouUninstalled = (n: number) =>
  n === 0
    ? "Apps you uninstalled"
    : n === 1
      ? "An app you uninstalled"
      : `${n} apps you uninstalled`;
const unlock = (n: number) => (n === 1 ? "unlocks" : "unlock");
const WHY = "It slows your pages and confuses Google and AI assistants.";
const WHY_PLURAL = "They slow your pages and confuse Google and AI assistants.";
const SAFE =
  "We remove it in a copy of your theme. You preview the copy and publish it when you're ready. Your live theme isn't changed.";

const SCAN_NOW: ValueActionButton = { label: "Scan now", action: "scan" };
const CLEAN_COPY: ValueActionButton = { label: "Make a clean copy", action: "clean_copy" };
const DIY: ValueActionButton = { label: "See how to fix them", action: "diy" };

function card(
  fields: Partial<ValueActionCard> & Pick<ValueActionCard, "kind" | "heading" | "body">,
): ValueActionCard {
  return {
    note: null,
    apps: [],
    primary: null,
    secondary: null,
    telemetryKey: null,
    upsellKey: null,
    ...fields,
  };
}

function clearCard(input: ValueActionInput): ValueActionCard {
  const heading = `All clear: no leftover code in ${input.themeName}`;
  if (input.themeChangedSinceScan) {
    return card({
      kind: "clear",
      heading,
      body: "Your theme changed after your last scan. Scan again to check it.",
      primary: SCAN_NOW,
    });
  }
  if (input.lastScanDaysAgo >= RESCAN_AFTER_DAYS) {
    return card({
      kind: "clear",
      heading,
      body: `Your last scan was ${input.lastScanDaysAgo} days ago. Scan again to check for anything new.`,
      primary: SCAN_NOW,
    });
  }
  return card({
    kind: "clear",
    heading,
    body: "We'll keep checking. Scan again any time you add or remove an app.",
  });
}

function diyCard(
  input: ValueActionInput,
  withUpsell: boolean,
  telemetryKey: "clean_copy_diy" | null = "clean_copy_diy",
): ValueActionCard {
  const { total, apps } = input.leftovers;
  return card({
    kind: "diy",
    heading: `Fix ${pieces(total)} of leftover code`,
    body: `${appsYouUninstalled(apps.length)} left code in your theme. ${WHY} Each finding shows where it is and how to remove it.`,
    apps,
    primary: DIY,
    secondary: withUpsell
      ? { label: "Upgrade to Professional to remove them for you", action: "upgrade" }
      : null,
    telemetryKey,
    upsellKey: withUpsell ? "clean_copy_upsell" : null,
  });
}

function professionalCard(input: ValueActionInput): ValueActionCard {
  const cc = input.cleanCopy;
  // Professional's fallback: no do-it-yourself stamp (that funnel is Standard's).
  if (!input.cleanCopyOn || cc === null || cc.state === "none") return diyCard(input, false, null);
  if (cc.state === "stale") {
    const { apps } = input.leftovers;
    return card({
      kind: "scan_first",
      heading: `Scan again to remove ${pieces(input.leftovers.total)} of leftover code`,
      body: "Your theme changed after your last scan, so we need a fresh scan before we can remove anything. It takes about a minute.",
      apps,
      primary: SCAN_NOW,
    });
  }
  // The card is about what the copy removes, so its apps are the offered ones.
  const apps = cc.apps ?? input.leftovers.apps;
  const trial = input.trial;
  if (trial !== null && trial.remaining < cc.count) {
    if (trial.remaining <= 0) {
      return card({
        kind: "clean_copy",
        heading: `${pieces(cc.count)} of leftover code ${unlock(cc.count)} on ${trial.unlocksOn}`,
        body: "You've used the removals in your free trial. The rest unlock when your plan starts.",
        apps,
      });
    }
    return card({
      kind: "clean_copy",
      heading: `Remove up to ${pieces(trial.remaining)} of leftover code now`,
      body: `${appsYouUninstalled(apps.length)} left ${pieces(cc.count)} of code in your theme. During your free trial you can remove ${trial.remaining}. The other ${cc.count - trial.remaining} ${unlock(cc.count - trial.remaining)} on ${trial.unlocksOn}, when your plan starts. Your live theme isn't changed.`,
      apps,
      primary: CLEAN_COPY,
      telemetryKey: "clean_copy_action",
    });
  }
  return card({
    kind: "clean_copy",
    heading: `Remove ${pieces(cc.count)} of leftover code for you`,
    body: `${appsYouUninstalled(apps.length)} left code in your theme. ${WHY} ${SAFE}`,
    note: "Saves paying a developer or editing theme code yourself.",
    apps,
    primary: CLEAN_COPY,
    telemetryKey: "clean_copy_action",
  });
}

export function valueActionCard(input: ValueActionInput): ValueActionCard | null {
  if (!input.hasCompletedScan) return null;
  if (input.leftovers.total === 0) return clearCard(input);
  switch (input.plan) {
    case "professional":
      return professionalCard(input);
    case "standard":
      return diyCard(input, input.cleanCopyOn);
    case "free": {
      if (!input.cleanCopyOn) return null;
      const { total, apps } = input.leftovers;
      return card({
        kind: "upsell",
        heading:
          apps.length === 0
            ? `We found ${pieces(total)} of leftover code`
            : `We found ${pieces(total)} of leftover code from ${apps.length} ${apps.length === 1 ? "app" : "apps"}`,
        body: `${total === 1 ? WHY : WHY_PLURAL} On Professional, GhostCode removes them for you in a copy of your theme that you preview and publish yourself.`,
        apps,
        primary: { label: "Upgrade to Professional", action: "upgrade" },
        secondary: { label: "Compare plans", action: "plans" },
        telemetryKey: "clean_copy_upsell",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Click ping (client)
// ---------------------------------------------------------------------------

/** Value actions whose click is recorded by POST /app/value-action-click. */
export const VALUE_ACTION_PING_KEYS = [
  "clean_copy_action",
  "clean_copy_diy",
  "clean_copy_preview",
] as const;

export type ValueActionPingKey = (typeof VALUE_ACTION_PING_KEYS)[number];

export function isValueActionPingKey(value: unknown): value is ValueActionPingKey {
  return typeof value === "string" && (VALUE_ACTION_PING_KEYS as readonly string[]).includes(value);
}

/**
 * Best-effort `clicked` ping. Never blocks or prevents the click's own
 * navigation; any error is swallowed. keepalive lets it outlive a navigation.
 */
export function recordValueActionClick(src: ValueActionPingKey): void {
  try {
    fetch("/app/value-action-click", {
      method: "POST",
      keepalive: true,
      body: new URLSearchParams({ src }),
    }).catch(() => {});
  } catch {
    // Telemetry must never break the click.
  }
}

// ---------------------------------------------------------------------------
// Shared page bits
// ---------------------------------------------------------------------------

/** The scan page's findings list, where "See how to fix them" lands. */
export const SCAN_FINDINGS_ANCHOR = "scan-findings";

/** The scan page header's action when Clean copy isn't the page's action. */
export const SCAN_AGAIN_LABEL = "Scan again";

/** Home's header action. */
export const SCAN_NOW_LABEL = "Scan now";

/** Shop.plan ("Free" | "Standard" | "Professional") to the card's plan. */
export function valueActionPlan(plan: string): ValueActionPlan {
  if (plan === PLANS.PROFESSIONAL) return "professional";
  if (plan === PLANS.STANDARD) return "standard";
  return "free";
}

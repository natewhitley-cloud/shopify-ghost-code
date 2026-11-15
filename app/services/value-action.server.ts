/**
 * Inputs for the value-action card (gc-np1d.2), shared by Home and the scan page
 * so both offer the same thing with the same count. See app/lib/value-action.ts.
 *
 * cleanCopyOfferFor moved here from the scan page loader (gc-tib.10 / gc-tib.21):
 * the count is what the select page would offer (the service's own freshness
 * check, block rule and file cap, and a scan-time md5 for the file). It reads
 * Admin only on Professional with the flag on and known embed status, and it
 * never throws: a failed read offers nothing.
 */
import type { FindingType } from "@prisma/client";

import { parseLiveAppHooks } from "./app-removal.server";
import type { CleanCopyAdmin } from "./clean-copy-admin.server";
import {
  checkCleanCopyFreshness,
  cleanCopyTrial,
  offerableCleanCopyFiles,
  TRIAL_CLEAN_COPY_LIMIT,
} from "./clean-copy.server";
import { isFindingIgnored } from "./finding-aggregation.server";
import { recordNudgeStageOnce } from "./nudge-stage.server";
import { isCleanCopyEnabled } from "./soft-launch-flags.server";
import { MAX_SELECTED_FINDINGS, trialUnlockDate } from "../lib/clean-copy-view";
import { isNeverPaywalledFindingType } from "../lib/finding-classification";
import { CONSEQUENCE_MAP, laneForType } from "../lib/finding-consequence";
import { logger } from "../lib/logger.server";
import { PLANS } from "../lib/plans";
import { FIXABLE_FINDING_TYPES } from "../lib/removal-span";
import {
  valueActionCard,
  valueActionPlan,
  type ValueActionApp,
  type ValueActionCard,
  type ValueActionInput,
} from "../lib/value-action";
import { countFindingsByApp, getFindingsForScan } from "../models/finding.server";
import { countTrialRemovals } from "../models/fix-run.server";
import type { ShopIgnores } from "../models/ignored-finding.server";
import { getScanManifest } from "../models/scan-manifest.server";

type OfferFinding = Parameters<typeof offerableCleanCopyFiles>[0][number] & { id: string };

type LeftoverFinding = { findingType: string; appName: string | null };

export type Leftovers = ValueActionInput["leftovers"];

const FIXABLE: ReadonlySet<string> = new Set(FIXABLE_FINDING_TYPES);

/**
 * "Leftover code" on the card = what Home's "N leftover items" line counts: a
 * finding with a consequence lane. Security findings (known malicious code, app
 * advisories, code in a menu) are never leftover code and never sold as an
 * upgrade (audit r2 H1); they only keep the card from saying All clear.
 */
function isLeftoverType(findingType: string): boolean {
  return (
    !isNeverPaywalledFindingType(findingType) &&
    findingType in CONSEQUENCE_MAP &&
    laneForType(findingType as FindingType) !== null
  );
}

/** Leftovers by app (most first), how many are removable, and whether any security finding is present. */
function summarizeLeftovers(
  rows: Iterable<{ appName: string | null; findingType: string; count: number }>,
): Leftovers {
  const leftover: { appName: string | null; count: number }[] = [];
  let removable = 0;
  let securityFound = false;
  for (const r of rows) {
    if (isNeverPaywalledFindingType(r.findingType)) securityFound = true;
    if (!isLeftoverType(r.findingType)) continue;
    leftover.push(r);
    if (FIXABLE.has(r.findingType)) removable += r.count;
  }
  return { ...summarize(leftover), removable, securityFound };
}

/** Sort named apps most first, then by name; total includes the unknown app. */
function summarize(rows: Iterable<{ appName: string | null; count: number }>): {
  total: number;
  apps: ValueActionApp[];
} {
  const byApp = new Map<string, number>();
  let total = 0;
  for (const { appName, count } of rows) {
    total += count;
    if (appName) byApp.set(appName, (byApp.get(appName) ?? 0) + count);
  }
  const apps = [...byApp]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { total, apps };
}

/**
 * Leftover code by named app (most first). `ignores` null: the findings are
 * already ignore-filtered (the scan page's kept findings), so nothing is
 * fingerprinted again.
 */
export function leftoversByApp(
  findings: readonly (LeftoverFinding & Partial<OfferFinding>)[],
  ignores: ShopIgnores | null,
): Leftovers {
  return summarizeLeftovers(
    findings
      .filter((f) => ignores === null || !isFindingIgnored(f as OfferFinding, ignores))
      .map((f) => ({ appName: f.appName, findingType: f.findingType, count: 1 })),
  );
}

/**
 * The same counts for a shop with no ignores, from one groupBy (never the full
 * findings list). Never throws: a failed read counts nothing (no card), and
 * the page still loads.
 */
export async function leftoversByAppForScan(scanId: string): Promise<Leftovers> {
  try {
    return summarizeLeftovers(await countFindingsByApp(scanId));
  } catch (error) {
    logger.warn("value-action leftover count failed", {
      scanId,
      message: error instanceof Error ? error.message : String(error),
    });
    // Unknown: count nothing, and never claim All clear on a failed read.
    return { total: 0, apps: [], removable: 0, securityFound: true };
  }
}

/** The card's Clean copy input, plus which findings it covers (for the list's label). */
export type CleanCopyOffer = NonNullable<ValueActionInput["cleanCopy"]> & {
  findingIds: string[];
};

const NONE: CleanCopyOffer = { state: "none", count: 0, apps: [], findingIds: [] };

export async function cleanCopyOfferFor(input: {
  shop: { id: string; domain: string; plan: string; lastThemePublishAt: Date | null };
  scan: {
    id: string;
    themeId: string;
    status: string;
    completedAt: Date | null;
    liveAppHooks: unknown;
  };
  /** Read only after the freshness check passes (a stale scan costs no findings read). */
  loadFindings: () => Promise<readonly OfferFinding[]>;
  ignores: ShopIgnores;
  admin: CleanCopyAdmin;
}): Promise<CleanCopyOffer> {
  const { shop, scan } = input;
  if (!isCleanCopyEnabled(shop.domain) || shop.plan !== PLANS.PROFESSIONAL) return NONE;
  const embedApps = parseLiveAppHooks(scan.liveAppHooks)?.embed ?? null;
  if (embedApps === null) return NONE;
  try {
    const fresh = await checkCleanCopyFreshness({
      shopId: shop.id,
      lastThemePublishAt: shop.lastThemePublishAt,
      scan: {
        id: scan.id,
        themeId: scan.themeId,
        status: scan.status,
        completedAt: scan.completedAt,
      },
      admin: input.admin,
    });
    if (!fresh.ok) {
      // Only a real theme change asks for a new scan; a draft theme's or an
      // older scan falls back to do-it-yourself (audit r1 M3).
      return fresh.reason === "SCAN_STALE" && fresh.detail === "CHANGED"
        ? { state: "stale", count: 0, apps: [], findingIds: [] }
        : NONE;
    }
    const [findings, manifest] = await Promise.all([
      input.loadFindings(),
      getScanManifest(scan.id),
    ]);
    const offer = offerableCleanCopyFiles(findings, input.ignores, embedApps);
    const shownFiles = new Set(offer.shownFiles);
    const withMd5 = new Set(
      (manifest?.entries ?? []).filter((e) => Boolean(e[1])).map((e) => e[0]),
    );
    const offered = offer.drafts.filter(
      (d) =>
        d.blocked === null && shownFiles.has(d.finding.filename) && withMd5.has(d.finding.filename),
    );
    if (offered.length === 0) return NONE;
    const { apps } = summarize(offered.map((d) => ({ appName: d.finding.appName, count: 1 })));
    return {
      state: "ready",
      count: offered.length,
      apps,
      findingIds: offered.map((d) => d.finding.id),
    };
  } catch (error) {
    logger.warn("clean-copy entry check failed", {
      shopId: shop.id,
      scanId: scan.id,
      message: error instanceof Error ? error.message : String(error),
    });
    return NONE;
  }
}

/**
 * The free trial's removals left and unlock day, or null on a paid
 * subscription. Null too when the subscription can't be read: the card then
 * reads as paid, and the select page (which fails closed) still enforces the
 * limit.
 */
export async function cleanCopyTrialFor(
  admin: CleanCopyAdmin,
  shopId: string,
): Promise<ValueActionInput["trial"]> {
  try {
    const res = await cleanCopyTrial(admin);
    if (!res.ok || res.trial === null) return null;
    const used = await countTrialRemovals(shopId);
    return {
      remaining: Math.max(0, TRIAL_CLEAN_COPY_LIMIT - used),
      unlocksOn: trialUnlockDate(res.trial.endsAt.toISOString()),
    };
  } catch (error) {
    logger.warn("clean-copy trial read failed", {
      shopId,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * The page's value-action card for a successful scan, shared by Home and the
 * scan page (gc-np1d.2/.3/.4), plus the findings its clean copy would remove
 * (the scan page labels them). Records the card's `shown` once per merchant.
 *
 * Query budget (scan page audit 1 #7): reuses the kept findings when the shop
 * has ignores, else one groupBy. Only Professional with Clean copy on reads the
 * full findings list, and only after the freshness check passes. Never throws.
 */
export async function loadValueAction(input: {
  shop: {
    id: string;
    domain: string;
    plan: string;
    lastThemePublishAt: Date | null;
  };
  scan: {
    id: string;
    themeId: string;
    themeName: string;
    status: string;
    completedAt: Date | null;
    createdAt: Date;
    liveAppHooks: unknown;
  };
  keptFindings: readonly (LeftoverFinding & Partial<OfferFinding>)[] | null;
  ignores: ShopIgnores;
  admin: CleanCopyAdmin;
  /** session.shop, unchanged (the telemetry rows are purged by it on redact). */
  shopDomain: string;
  now?: Date;
}): Promise<{ card: ValueActionCard | null; cleanCopyFindingIds: string[] }> {
  const { shop, scan } = input;
  const now = input.now ?? new Date();
  let leftovers =
    input.keptFindings !== null
      ? leftoversByApp(input.keptFindings, null)
      : await leftoversByAppForScan(scan.id);
  // Kept findings leave out ignored ones, but known malicious code shows on the
  // page whether or not it was ignored (audit r2 H2). Before All clear, check
  // the scan's unfiltered counts (one groupBy, only on this path).
  if (input.keptFindings !== null && leftovers.total === 0 && !leftovers.securityFound) {
    const all = await leftoversByAppForScan(scan.id);
    leftovers = { ...leftovers, securityFound: all.securityFound };
  }
  const isPro = shop.plan === PLANS.PROFESSIONAL;
  const cleanCopyOn = isCleanCopyEnabled(shop.domain);
  const offer: CleanCopyOffer | null = !isPro
    ? null
    : leftovers.total > 0 && cleanCopyOn
      ? await cleanCopyOfferFor({
          shop,
          scan,
          loadFindings: () => getFindingsForScan(scan.id),
          ignores: input.ignores,
          admin: input.admin,
        })
      : NONE;
  const trial = offer?.state === "ready" ? await cleanCopyTrialFor(input.admin, shop.id) : null;
  const completedAt = scan.completedAt ?? scan.createdAt;
  const card = valueActionCard({
    plan: valueActionPlan(shop.plan),
    cleanCopyOn,
    hasCompletedScan: true,
    themeName: scan.themeName,
    leftovers,
    cleanCopy: offer,
    trial,
    lastScanDaysAgo: Math.max(0, Math.floor((now.getTime() - completedAt.getTime()) / DAY_MS)),
    themeChangedSinceScan:
      shop.lastThemePublishAt !== null && shop.lastThemePublishAt > completedAt,
  });
  if (card?.telemetryKey) {
    await recordNudgeStageOnce(card.telemetryKey, "shown", input.shopDomain);
  }
  if (card?.upsellKey) {
    await recordNudgeStageOnce(card.upsellKey, "shown", input.shopDomain);
  }
  return {
    card,
    cleanCopyFindingIds:
      // During a capped trial the select page picks only some of them, so no
      // finding is labelled "Included" (audit r1 M4).
      card?.primary?.action === "clean_copy" &&
      offer?.state === "ready" &&
      (trial === null || trial.remaining >= offer.count) &&
      offer.count <= MAX_SELECTED_FINDINGS
        ? offer.findingIds
        : [],
  };
}

const DAY_MS = 86_400_000;

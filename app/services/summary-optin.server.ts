/**
 * Home's one-time summary-email opt-in prompt (gc-xorg), server side.
 *
 * Who is asked is decided by isSummaryOptInEligible (app/lib/summary-optin)
 * inside the cross-prompt cap (PromptKey `summary_optin`). This module builds
 * what Home renders once the cap picked it, and handles the two answers:
 *   - "Turn on": the Settings opt-in path (setSummaryEmailsEnabled with sending
 *     live), which sets alertsEnabled and stamps summaryOptedInAt, the consent
 *     stamp summaryShopSkipReason reads. Never duplicated here.
 *   - "No thanks": stamps summaryOptInDeclinedAt once; nothing else changes.
 * The first render stamps summaryOptInFirstShownAt (gc-rxq0); the prompt is
 * retired SUMMARY_OPTIN_OFFER_MS (14 days) later (isSummaryOptInEligible).
 *
 * Telemetry: structured logger.info events (summary_optin_shown / _accepted /
 * _declined) carrying the shop DOMAIN only, never the email. The nudge funnel
 * (recordNudgeStageOnce) would need a per-stage Shop stamp for `shown` (and
 * `converted`), i.e. more columns than the one this feature adds.
 */
import { summaryOptInFacts } from "./prompt-cap.server";
import { refreshShopAlertEmail } from "./shop-alert-email.server";
import { getPlanFeatures } from "../lib/billing.server";
import { logger } from "../lib/logger.server";
import type { SummaryCadence } from "../lib/summary-email-copy";
import { isSummaryOptInEligible } from "../lib/summary-optin";
import {
  claimSummaryOptInFirstShown,
  declineSummaryOptIn,
  setSummaryEmailsEnabled,
} from "../models/merchant-alert.server";
import type { ShopMetadata } from "../models/shop.server";
import type { AdminApiContext } from "../types/shopify";

/** What Home's opt-in banner names: the recipient and the plan's cadence. */
export type SummaryOptInPrompt = { email: string | null; cadence: SummaryCadence };

/**
 * The opt-in banner's data, for a load where the cap picked `summary_optin`.
 *
 * `opensWindow`: this load opened (claimed) a new 24h prompt window, i.e. the
 * merchant is seeing it for the first time in this window. Only then is
 * `shown` logged and, when the owner email was never cached, read from Admin
 * (refreshShopAlertEmail never throws and caches it). Re-renders inside the
 * window (reloads, the 3s scan poll) issue no Admin call and log nothing.
 *
 * The first render of all (summaryOptInFirstShownAt still null on the row this
 * load read) stamps summaryOptInFirstShownAt once (gc-rxq0), starting the
 * 14-day offer. Gated on any render, not only a window-opening one, so a shop
 * already inside a window when this shipped is stamped too. The pre-check
 * skips the write on every later load; the conditional write never moves an
 * existing stamp. A failed stamp is logged and never breaks Home (the offer
 * then starts on a later render).
 */
export async function summaryOptInForHome(
  shop: Pick<ShopMetadata, "domain" | "plan" | "alertEmail" | "summaryOptInFirstShownAt">,
  admin: AdminApiContext | null,
  opensWindow: boolean,
): Promise<SummaryOptInPrompt | null> {
  const cadence = getPlanFeatures(shop.plan).alertCadence;
  // Unreachable while the cap picked it (eligibility requires a cadence); narrows the type.
  if (cadence === "none") return null;
  if (opensWindow) logger.info("summary_optin_shown", { shop: shop.domain });
  if (shop.summaryOptInFirstShownAt === null) {
    try {
      await claimSummaryOptInFirstShown(shop.domain);
    } catch (err) {
      logger.error("summary_optin_first_shown_stamp_failed", {
        shop: shop.domain,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const email =
    shop.alertEmail ??
    (opensWindow && admin ? await refreshShopAlertEmail(shop.domain, admin) : null);
  return { email, cadence };
}

/**
 * "Turn on". `shop` must be the SESSION shop's freshly read row.
 *
 * Idempotent: a shop already on with consent returns true with no write (its
 * first consent time is kept). Otherwise the shop must be FULLY eligible for
 * the prompt right now (isSummaryOptInEligible on this row plus the live plan
 * and sending facts): a stale tab must never undo an unsubscribe or a "No
 * thanks", and a direct POST must never record consent for a shop that was
 * never offered the prompt. Ineligible returns false, writing nothing; the
 * Settings toggle stays the way to re-enable. That includes an offer retired
 * since the tab loaded (14 days after it was first shown, gc-rxq0).
 */
export async function acceptSummaryOptIn(
  shop: Pick<
    ShopMetadata,
    | "id"
    | "domain"
    | "plan"
    | "alertsEnabled"
    | "uninstalledAt"
    | "summaryNoticePendingAt"
    | "summaryNoticeShownAt"
    | "summaryOptedInAt"
    | "summaryOptInDeclinedAt"
    | "summaryOptInFirstShownAt"
  >,
  now: Date,
): Promise<boolean> {
  if (shop.alertsEnabled && shop.summaryOptedInAt !== null) return true;
  if (!isSummaryOptInEligible({ ...shop, ...summaryOptInFacts(shop.plan) }, now)) return false;
  await setSummaryEmailsEnabled(shop.id, true, {
    sendingLive: true,
    noticeShown: shop.summaryNoticeShownAt !== null,
  });
  logger.info("summary_optin_accepted", { shop: shop.domain });
  return true;
}

/** "No thanks": stamps the decline once; logs only the call that stamped it. */
export async function declineSummaryOptInForHome(domain: string): Promise<void> {
  if (await declineSummaryOptIn(domain)) {
    logger.info("summary_optin_declined", { shop: domain });
  }
}

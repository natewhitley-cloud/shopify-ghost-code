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
 *
 * Telemetry: structured logger.info events (summary_optin_shown / _accepted /
 * _declined) carrying the shop DOMAIN only, never the email. The nudge funnel
 * (recordNudgeStageOnce) would need a per-stage Shop stamp for `shown` (and
 * `converted`), i.e. more columns than the one this feature adds.
 */
import { getMerchantAlertConfigStatus } from "./merchant-alert.server";
import { refreshShopAlertEmail } from "./shop-alert-email.server";
import { getPlanFeatures } from "../lib/billing.server";
import { logger } from "../lib/logger.server";
import { canReceiveAlerts } from "../lib/plan-gating.server";
import type { SummaryCadence } from "../lib/summary-email-copy";
import { declineSummaryOptIn, setSummaryEmailsEnabled } from "../models/merchant-alert.server";
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
 */
export async function summaryOptInForHome(
  shop: Pick<ShopMetadata, "domain" | "plan" | "alertEmail">,
  admin: AdminApiContext | null,
  opensWindow: boolean,
): Promise<SummaryOptInPrompt | null> {
  const cadence = getPlanFeatures(shop.plan).alertCadence;
  // Unreachable while the cap picked it (eligibility requires a cadence); narrows the type.
  if (cadence === "none") return null;
  if (opensWindow) logger.info("summary_optin_shown", { shop: shop.domain });
  const email =
    shop.alertEmail ??
    (opensWindow && admin ? await refreshShopAlertEmail(shop.domain, admin) : null);
  return { email, cadence };
}

/**
 * "Turn on". `shop` must be the SESSION shop's freshly read row. Re-checks what
 * makes consent meaningful: a plan with summaries and sending configured (so
 * the opt-in is the live-card consent, never the dark "we'll tell you first"
 * case). Returns false, writing nothing, when that fails. Idempotent: a shop
 * already on with consent is left as is (its first consent time is kept).
 */
export async function acceptSummaryOptIn(
  shop: Pick<
    ShopMetadata,
    "id" | "domain" | "plan" | "alertsEnabled" | "summaryNoticeShownAt" | "summaryOptedInAt"
  >,
): Promise<boolean> {
  if (!canReceiveAlerts(shop.plan) || !getMerchantAlertConfigStatus().configured) return false;
  if (shop.alertsEnabled && shop.summaryOptedInAt !== null) return true;
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

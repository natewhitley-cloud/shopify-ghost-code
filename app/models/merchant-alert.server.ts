import { randomBytes } from "node:crypto";

import type { MerchantAlert, Prisma } from "@prisma/client";

import { claimShopStamp } from "./shop.server";
import db from "../db.server";

/**
 * Data access for merchant summary emails (gc-syz.1, gc-ol95): the
 * MerchantAlert ledger plus the per-shop preferences stored on Shop
 * (alertsEnabled, alertEmail, alertUnsubscribeToken, and the consent stamps
 * summaryNoticePendingAt / summaryNoticeShownAt / summaryOptedInAt).
 *
 * GDPR: alertEmail and MerchantAlert.recipient are personal data. Both go with
 * the Shop row on shop/redact (deleteShopData also deletes the ledger rows
 * explicitly), as does the cached Shop.storeName.
 */

/** 32 random bytes = 256 bits, base64url (URL-safe, no padding) = 43 chars. */
const UNSUBSCRIBE_TOKEN_BYTES = 32;
/** Upper bound on an accepted unsubscribe token (public input), far above 43. */
const MAX_TOKEN_LENGTH = 128;

export type RecordMerchantAlertInput = {
  shopId: string;
  scanId: string;
  findingSetHash: string;
  newCount: number;
  fixedCount: number;
  inactiveAppCount: number;
  cleanedAppCount: number;
  recipient: string;
};

/** Generate a crypto-random, URL-safe unsubscribe token (>= 128 bits). */
export function generateUnsubscribeToken(): string {
  return randomBytes(UNSUBSCRIBE_TOKEN_BYTES).toString("base64url");
}

/** The most recent summary sent to a shop, or null: baseline/idempotency/throttle source. */
export function getLatestMerchantAlert(shopId: string): Promise<MerchantAlert | null> {
  return db.merchantAlert.findFirst({ where: { shopId }, orderBy: { sentAt: "desc" } });
}

/** Append one sent-summary row to the ledger ((shopId, scanId) is unique). */
export function recordMerchantAlert(input: RecordMerchantAlertInput): Promise<MerchantAlert> {
  return db.merchantAlert.create({ data: input });
}

/** Cache (or clear, with null) the shop-owner email used as the alert recipient. */
export async function setShopAlertEmail(shopId: string, email: string | null): Promise<void> {
  await db.shop.update({ where: { id: shopId }, data: { alertEmail: email } });
}

/**
 * The Settings summary-email toggle (gc-ol95). Turning it OFF clears nothing
 * else. Turning it ON depends on whether sending is live:
 *   - live (`sendingLive`): the merchant read the live card ("We email ...
 *     only when something changed"), so this is consent: summaryOptedInAt.
 *   - dark: the card promised "We'll let you know before any are sent", so it
 *     is NOT consent on its own (Nathan Q9=9A). Only the toggle is turned on,
 *     and, unless Home's notice was already shown (`noticeShown`), the notice
 *     is marked pending: the merchant becomes eligible only once it is shown.
 */
export async function setSummaryEmailsEnabled(
  shopId: string,
  enabled: boolean,
  opts: { sendingLive: boolean; noticeShown: boolean },
): Promise<void> {
  if (!enabled) {
    await db.shop.update({ where: { id: shopId }, data: { alertsEnabled: false } });
    return;
  }
  const now = new Date();
  await db.shop.update({
    where: { id: shopId },
    data: {
      alertsEnabled: true,
      ...(opts.sendingLive
        ? { summaryOptedInAt: now }
        : opts.noticeShown
          ? {}
          : { summaryNoticePendingAt: now }),
    },
  });
}

/**
 * Mark Home's "Summary emails are on" notice as owed (gc-ol95), called when a
 * shop moves Free -> paid. A once claim that also requires the merchant to
 * have neither seen the notice nor opted in already (they know). Returns true
 * IFF this call set it.
 */
export function markSummaryNoticePending(domain: string): Promise<boolean> {
  return claimShopStamp(domain, "summaryNoticePendingAt", {
    summaryNoticeShownAt: null,
    summaryOptedInAt: null,
  });
}

/**
 * Claim the render of Home's summary notice (gc-ol95): stamps
 * summaryNoticeShownAt once, only while the notice is pending. Of concurrent
 * loads exactly one wins; only the winner renders the banner. Returns true
 * IFF this call stamped it.
 */
export function claimSummaryNoticeShown(domain: string): Promise<boolean> {
  return claimShopStamp(domain, "summaryNoticeShownAt", {
    summaryNoticePendingAt: { not: null },
  });
}

/** Home notice "Dismiss" (gc-ol95): the notice is no longer owed. Idempotent. */
export async function dismissSummaryNotice(shopId: string): Promise<void> {
  await db.shop.updateMany({ where: { id: shopId }, data: { summaryNoticePendingAt: null } });
}

/**
 * Return the shop's unsubscribe token, minting one on first use. The mint is a
 * conditional write (only while the column is NULL), so two concurrent callers
 * converge on ONE token: the loser's write matches no row and it re-reads the
 * winner's. Returns null only if the shop does not exist.
 */
export async function ensureUnsubscribeToken(shopId: string): Promise<string | null> {
  const existing = await db.shop.findUnique({
    where: { id: shopId },
    select: { alertUnsubscribeToken: true },
  });
  if (!existing) return null;
  if (existing.alertUnsubscribeToken) return existing.alertUnsubscribeToken;

  await db.shop.updateMany({
    where: { id: shopId, alertUnsubscribeToken: null },
    data: { alertUnsubscribeToken: generateUnsubscribeToken() },
  });
  const minted = await db.shop.findUnique({
    where: { id: shopId },
    select: { alertUnsubscribeToken: true },
  });
  return minted?.alertUnsubscribeToken ?? null;
}

/**
 * Public one-click unsubscribe: turn alerts off for the shop holding `token`
 * and ROTATE (null out) the token, so a second use reports invalid. Returns
 * true only if a shop matched. An empty, non-string or oversized token
 * never touches the database (a NULL column must never match "no token").
 */
export async function disableAlertsByToken(token: string): Promise<boolean> {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return false;
  }
  const result = await db.shop.updateMany({
    where: { alertUnsubscribeToken: token },
    // Rotate: the token may already sit in an access log (the RFC 8058 header
    // URL carries it in the path), so a used token must be dead. The next send's
    // ensureUnsubscribeToken mints a fresh one; re-enabling in Settings needs none.
    data: { alertsEnabled: false, alertUnsubscribeToken: null },
  });
  return result.count > 0;
}

/**
 * Cache the owner email and the store name by shop domain (the scan job knows
 * the domain, not the id). Only non-null values are written (a failed read
 * never clears a cached value), and there is no write when every stored value
 * already matches; the explicit null branches are needed because SQL
 * `<> 'x'` excludes NULL rows.
 */
export async function setShopContactByDomain(
  domain: string,
  contact: { email: string | null; storeName: string | null },
): Promise<void> {
  const data: { alertEmail?: string; storeName?: string } = {};
  const differs: Prisma.ShopWhereInput[] = [];
  if (contact.email) {
    data.alertEmail = contact.email;
    differs.push({ alertEmail: null }, { alertEmail: { not: contact.email } });
  }
  if (contact.storeName) {
    data.storeName = contact.storeName;
    differs.push({ storeName: null }, { storeName: { not: contact.storeName } });
  }
  if (differs.length === 0) return;
  await db.shop.updateMany({ where: { domain, OR: differs }, data });
}

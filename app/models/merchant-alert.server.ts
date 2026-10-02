import { randomBytes } from "node:crypto";

import type { MerchantAlert } from "@prisma/client";

import db from "../db.server";

/**
 * Data access for merchant monitoring alerts (gc-syz.1): the MerchantAlert
 * ledger plus the per-shop alert preferences stored on Shop (alertsEnabled,
 * alertEmail, alertUnsubscribeToken).
 *
 * GDPR: alertEmail and MerchantAlert.recipient are personal data. Both go with
 * the Shop row on shop/redact (deleteShopData also deletes the ledger rows
 * explicitly).
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
  recipient: string;
};

/** Generate a crypto-random, URL-safe unsubscribe token (>= 128 bits). */
export function generateUnsubscribeToken(): string {
  return randomBytes(UNSUBSCRIBE_TOKEN_BYTES).toString("base64url");
}

/** The most recent alert sent to a shop, or null if none. Dedup/throttle source. */
export function getLatestMerchantAlert(shopId: string): Promise<MerchantAlert | null> {
  return db.merchantAlert.findFirst({ where: { shopId }, orderBy: { sentAt: "desc" } });
}

/** Append one sent-alert row to the ledger. */
export function recordMerchantAlert(input: RecordMerchantAlertInput): Promise<MerchantAlert> {
  return db.merchantAlert.create({ data: input });
}

/** Cache (or clear, with null) the shop-owner email used as the alert recipient. */
export async function setShopAlertEmail(shopId: string, email: string | null): Promise<void> {
  await db.shop.update({ where: { id: shopId }, data: { alertEmail: email } });
}

/** Per-shop opt-in/out for merchant alerts (Settings toggle). */
export async function setShopAlertsEnabled(shopId: string, enabled: boolean): Promise<void> {
  await db.shop.update({ where: { id: shopId }, data: { alertsEnabled: enabled } });
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
 * Public one-click unsubscribe: turn alerts off for the shop holding `token`.
 * Returns true only if a shop matched. An empty, non-string or oversized token
 * never touches the database (a NULL column must never match "no token").
 */
export async function disableAlertsByToken(token: string): Promise<boolean> {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return false;
  }
  const result = await db.shop.updateMany({
    where: { alertUnsubscribeToken: token },
    data: { alertsEnabled: false },
  });
  return result.count > 0;
}

/**
 * Cache the owner email by shop domain (the scan job knows the domain, not the
 * id). A no-op, with no write, when the stored value already equals `email`;
 * the explicit null branch is needed because SQL `<> 'x'` excludes NULL rows.
 */
export async function setShopAlertEmailByDomain(domain: string, email: string): Promise<void> {
  await db.shop.updateMany({
    where: { domain, OR: [{ alertEmail: null }, { alertEmail: { not: email } }] },
    data: { alertEmail: email },
  });
}

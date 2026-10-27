import { randomBytes } from "node:crypto";

import type { MerchantAlert, Prisma } from "@prisma/client";

import { claimShopStamp } from "./shop.server";
import db from "../db.server";
import { chunks } from "../lib/chunk";

/**
 * Data access for merchant summary emails (gc-syz.1, gc-ol95): the
 * MerchantAlert ledger plus the per-shop preferences stored on Shop
 * (alertsEnabled, alertEmail, alertUnsubscribeToken, the consent stamps
 * summaryNoticePendingAt / summaryNoticeShownAt / summaryOptedInAt, and
 * summaryOptInDeclinedAt: the answer to Home's opt-in prompt, gc-xorg).
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
  /** Which email the row records (default "summary"; "checkout_guard", gc-1q1s.7). */
  kind?: string;
};

/** MerchantAlert.kind of a checkout guard incident email (gc-1q1s.7). */
export const GUARD_ALERT_KIND = "checkout_guard";

/**
 * MerchantAlert.kind of one incident EPISODE a checkout guard email reported
 * (wave 3 B5). The batch row (GUARD_ALERT_KIND) is what the throttle counts;
 * these rows say which episodes were emailed, so an episode is never emailed
 * again when the next batch is a different set. Never counted, never a summary.
 */
export const GUARD_INCIDENT_LEDGER_KIND = "checkout_guard_incident";

/** The ledger key (MerchantAlert.scanId) of one emailed incident episode. */
export function guardIncidentLedgerKey(incident: { id: string; openedAt: Date }): string {
  return `guard-incident:${incident.id}:${incident.openedAt.toISOString()}`;
}

/** The keys among `keys` already in the ledger as emailed episodes. */
export async function emailedGuardIncidentKeys(
  shopId: string,
  keys: readonly string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  // Chunked (wave 4 H1): one IN list past the bind limit fails the query.
  for (const part of chunks(keys)) {
    const rows = await db.merchantAlert.findMany({
      where: { shopId, kind: GUARD_INCIDENT_LEDGER_KIND, scanId: { in: part } },
      select: { scanId: true },
    });
    for (const r of rows) out.add(r.scanId);
  }
  return out;
}

/** Record emailed episodes (one row each; an existing row is kept). */
export async function recordGuardIncidentsEmailed(
  shopId: string,
  keys: readonly string[],
  recipient: string,
): Promise<void> {
  // Chunked (wave 4 M2): one createMany past the bind limit fails whole.
  for (const part of chunks(keys)) {
    await db.merchantAlert.createMany({
      data: part.map((key) => ({
        shopId,
        scanId: key,
        findingSetHash: key,
        newCount: 1,
        recipient,
        kind: GUARD_INCIDENT_LEDGER_KIND,
      })),
      skipDuplicates: true,
    });
  }
}

/**
 * Per-episode ledger rows are kept this long (wave 4 M2: they were never
 * deleted). Far past the 30-day incident retention and the 24 h email
 * window; an episode's own emailedOpenedAt stamp still stops a resend.
 */
export const GUARD_INCIDENT_LEDGER_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Delete every shop's per-episode ledger rows older than the retention. Returns the count. */
export async function pruneGuardIncidentLedger(now: Date): Promise<number> {
  const { count } = await db.merchantAlert.deleteMany({
    where: {
      kind: GUARD_INCIDENT_LEDGER_KIND,
      sentAt: { lt: new Date(now.getTime() - GUARD_INCIDENT_LEDGER_RETENTION_MS) },
    },
  });
  return count;
}

/** Generate a crypto-random, URL-safe unsubscribe token (>= 128 bits). */
export function generateUnsubscribeToken(): string {
  return randomBytes(UNSUBSCRIBE_TOKEN_BYTES).toString("base64url");
}

/**
 * The most recent summary sent to a shop, or null: baseline/idempotency/throttle
 * source. Checkout guard incident emails (gc-1q1s.7) share the ledger but are
 * not summaries: they must never throttle or re-baseline the next summary.
 */
export function getLatestMerchantAlert(shopId: string): Promise<MerchantAlert | null> {
  return db.merchantAlert.findFirst({
    where: { shopId, kind: { notIn: [GUARD_ALERT_KIND, GUARD_INCIDENT_LEDGER_KIND] } },
    orderBy: { sentAt: "desc" },
  });
}

/** Checkout guard emails sent to a shop since `since` (the 3-per-24h throttle). */
export function countGuardAlertsSince(shopId: string, since: Date): Promise<number> {
  return db.merchantAlert.count({
    where: { shopId, kind: GUARD_ALERT_KIND, sentAt: { gte: since } },
  });
}

/**
 * Claim the render of Home's checkout guard email notice (gc-1q1s.7): stamps
 * guardEmailNoticeShownAt once, only while the merchant has not turned guard
 * email off, together with `consentHash` (the hashed address the notice
 * names). Also claimable over a legacy stamp with no hash (gc-1q1s.12: that
 * is no consent, so the notice is shown again). Of concurrent loads exactly
 * one wins. Returns true IFF this call stamped it (that stamp is the consent).
 */
export async function claimGuardEmailNoticeShown(
  domain: string,
  consentHash: string,
): Promise<boolean> {
  const { count } = await db.shop.updateMany({
    where: {
      domain,
      guardEmailOffAt: null,
      OR: [{ guardEmailNoticeShownAt: null }, { guardEmailConsentHash: null }],
    },
    data: { guardEmailNoticeShownAt: new Date(), guardEmailConsentHash: consentHash },
  });
  return count === 1;
}

/**
 * The owner email changed since the notice named it (audit fix): clear the
 * consent so Home shows the notice again with the new address. No guard email
 * goes out until then. A turned-off shop is left alone.
 */
export async function resetGuardEmailNotice(shopId: string): Promise<void> {
  await db.shop.updateMany({
    where: { id: shopId, guardEmailOffAt: null },
    data: { guardEmailNoticeShownAt: null, guardEmailConsentHash: null },
  });
}

/** Whether the ledger already holds this guard email (shopId + ledger key). */
export async function hasGuardAlert(shopId: string, key: string): Promise<boolean> {
  const row = await db.merchantAlert.findUnique({
    where: { shopId_scanId: { shopId, scanId: key } },
    select: { id: true },
  });
  return row !== null;
}

/** The notice's "Turn off": no checkout guard email while set. Idempotent. */
export async function turnOffGuardEmail(shopId: string): Promise<void> {
  await db.shop.updateMany({
    where: { id: shopId, guardEmailOffAt: null },
    data: { guardEmailOffAt: new Date() },
  });
}

/**
 * Settings' checkout guard email toggle turned ON (gc-njwa #5): the merchant
 * read the address on the card, so this is consent, stamped like the notice:
 * guardEmailNoticeShownAt now, with `consentHash` (the hashed address shown),
 * and any "Turn off" cleared (a legacy stamp with no hash counts as off,
 * gc-1q1s.12). A shop
 * already on keeps its first consent time, but its consent hash is re-stamped
 * to the address shown (wave 3 U5: a stale hash from an old owner email would
 * otherwise keep every email blocked while the card says "on"). Returns true
 * IFF this call turned it on.
 */
export async function enableGuardEmail(shopId: string, consentHash: string): Promise<boolean> {
  const { count } = await db.shop.updateMany({
    where: {
      id: shopId,
      OR: [
        { guardEmailOffAt: { not: null } },
        { guardEmailNoticeShownAt: null },
        { guardEmailConsentHash: null },
      ],
    },
    data: {
      guardEmailOffAt: null,
      guardEmailNoticeShownAt: new Date(),
      guardEmailConsentHash: consentHash,
    },
  });
  if (count === 1) return true;
  await db.shop.updateMany({
    where: { id: shopId, guardEmailOffAt: null, guardEmailNoticeShownAt: { not: null } },
    data: { guardEmailConsentHash: consentHash },
  });
  return false;
}

/** The stored guard email consent fields (Settings reads its real state back), or null. */
export async function getGuardEmailConsent(shopId: string) {
  return db.shop.findUnique({
    where: { id: shopId },
    select: {
      alertsEnabled: true,
      guardEmailNoticeShownAt: true,
      guardEmailOffAt: true,
      guardEmailConsentHash: true,
    },
  });
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
 * The Settings summary-email toggle (gc-ol95). Turning it OFF also withdraws
 * checkout guard email consent (guardEmailOffAt, wave 3 U1); turning it back
 * on leaves guard email off. Turning it ON depends on whether sending is live:
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
    // Mail off also withdraws guard email consent (wave 3 U1), so turning
    // summaries back on never turns guard email back on with them; only the
    // guard toggle can. An existing turn-off time is kept (wave 4): it records
    // when the merchant first said no. One transaction, so mail is never off
    // with the consent still standing.
    await db.$transaction([
      db.shop.update({ where: { id: shopId }, data: { alertsEnabled: false } }),
      db.shop.updateMany({
        where: { id: shopId, guardEmailOffAt: null },
        data: { guardEmailOffAt: new Date() },
      }),
    ]);
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
 * have neither seen the notice nor opted in already (they know), nor answered
 * Home's opt-in prompt with "No thanks" (gc-xorg: a shop that declined, dropped
 * to Free and upgraded again is not told summaries are on; Settings remains
 * the way in). Returns true IFF this call set it.
 */
export function markSummaryNoticePending(domain: string): Promise<boolean> {
  return claimShopStamp(domain, "summaryNoticePendingAt", {
    summaryNoticeShownAt: null,
    summaryOptedInAt: null,
    summaryOptInDeclinedAt: null,
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

/**
 * Home's summary-email opt-in prompt "No thanks" (gc-xorg): stamps
 * summaryOptInDeclinedAt once (conditional write, so repeats and concurrent
 * clicks never move the first answer). Nothing else changes: alertsEnabled is
 * untouched and the Settings toggle still works. Returns true IFF this call
 * stamped it. ("Turn on" has no model of its own: it is setSummaryEmailsEnabled.)
 */
export function declineSummaryOptIn(domain: string): Promise<boolean> {
  return claimShopStamp(domain, "summaryOptInDeclinedAt");
}

/**
 * Home's summary-email opt-in prompt rendered (gc-rxq0): stamps
 * summaryOptInFirstShownAt once (conditional write, so later renders and
 * concurrent loads never move it). Its 14-day offer window counts from this
 * stamp (SUMMARY_OPTIN_OFFER_MS). Returns true IFF this call stamped it.
 */
export function claimSummaryOptInFirstShown(domain: string): Promise<boolean> {
  return claimShopStamp(domain, "summaryOptInFirstShownAt");
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
  // An unsubscribe also withdraws checkout guard email consent (wave 3 U1):
  // re-enabling summaries later must not silently resume guard email. An
  // existing turn-off time is kept (first "no" wins, as in
  // setSummaryEmailsEnabled), so that write is conditional and runs first,
  // while the token still finds the row. One transaction, so mail is never
  // off with the consent still standing.
  const [, result] = await db.$transaction([
    db.shop.updateMany({
      where: { alertUnsubscribeToken: token, guardEmailOffAt: null },
      data: { guardEmailOffAt: new Date() },
    }),
    db.shop.updateMany({
      where: { alertUnsubscribeToken: token },
      // Rotate: the token may already sit in an access log (the RFC 8058 header
      // URL carries it in the path), so a used token must be dead. The next send's
      // ensureUnsubscribeToken mints a fresh one; re-enabling in Settings needs none.
      data: { alertsEnabled: false, alertUnsubscribeToken: null },
    }),
  ]);
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

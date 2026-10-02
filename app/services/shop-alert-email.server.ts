/**
 * Shop-owner email for merchant alerts (gc-syz.2).
 *
 * Admin GraphQL `shop { email }` is the shop OWNER's address (not customer
 * data), readable without any access scope, so no scope change is needed. It is
 * cached on Shop.alertEmail so the Settings UI and the alert sender have an
 * address without a live fetch.
 *
 * Both functions NEVER throw: an email problem must never fail or retry a scan.
 */

import { logger } from "../lib/logger.server";
import { safeErrorFields } from "../lib/safe-error";
import { setShopAlertEmailByDomain } from "../models/merchant-alert.server";
import type { AdminApiContext } from "../types/shopify";

const SHOP_EMAIL_QUERY = `#graphql
  query ShopOwnerEmail {
    shop {
      email
    }
  }
`;

type ShopEmailResponse = {
  data?: { shop?: { email?: string | null } | null } | null;
  errors?: Array<{ message?: string }>;
};

/** RFC 5321 maximum address length. */
const MAX_EMAIL_LENGTH = 254;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/;

/**
 * Fetch the shop owner's email. Returns the trimmed address, or null on a
 * GraphQL/transport error, a missing/blank email, or a malformed value.
 */
export async function fetchShopOwnerEmail(admin: AdminApiContext): Promise<string | null> {
  try {
    const response = await admin.graphql(SHOP_EMAIL_QUERY);
    const json = (await response.json()) as ShopEmailResponse;

    if (json.errors && json.errors.length > 0) {
      logger.warn("shop-owner-email-graphql-error", { error: json.errors[0]?.message });
      return null;
    }

    const email = json.data?.shop?.email;
    if (typeof email !== "string") return null;
    const trimmed = email.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_EMAIL_LENGTH || !EMAIL_SHAPE.test(trimmed)) {
      return null;
    }
    return trimmed;
  } catch (err) {
    logger.warn("shop-owner-email-fetch-failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Fetch the owner email and cache it on Shop.alertEmail (written only when it
 * changed). Returns the fetched email, or null when the fetch yielded nothing
 * (the previously cached value is left untouched, never cleared on a failure).
 * A cache-write failure is logged and the fetched email is still returned.
 * For slice B to call from the scan job.
 */
export async function refreshShopAlertEmail(
  shopDomain: string,
  admin: AdminApiContext,
): Promise<string | null> {
  const email = await fetchShopOwnerEmail(admin);
  if (!email) return null;
  try {
    await setShopAlertEmailByDomain(shopDomain, email);
  } catch (err) {
    logger.warn("shop-alert-email-cache-failed", {
      shop: shopDomain,
      ...safeErrorFields(err),
    });
  }
  return email;
}

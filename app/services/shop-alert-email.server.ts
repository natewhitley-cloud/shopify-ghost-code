/**
 * Shop-owner email and store name for merchant summary emails (gc-syz.2,
 * gc-ol95).
 *
 * Admin GraphQL `shop { email name }`: the shop OWNER's address (not customer
 * data) and the store's display name, both readable without any access scope,
 * so no scope change is needed. They are cached on Shop.alertEmail and
 * Shop.storeName so the Settings UI and the summary sender have them without a
 * live fetch.
 *
 * Every function NEVER throws: an email problem must never fail or retry a scan.
 */

import { logger } from "../lib/logger.server";
import { safeErrorFields } from "../lib/safe-error";
import { setShopContactByDomain } from "../models/merchant-alert.server";
import type { AdminApiContext } from "../types/shopify";

const SHOP_CONTACT_QUERY = `#graphql
  query ShopOwnerContact {
    shop {
      email
      name
    }
  }
`;

type ShopContactResponse = {
  data?: { shop?: { email?: unknown; name?: unknown } | null } | null;
  errors?: Array<{ message?: string }>;
};

/** What one read returns; each field is null when missing or invalid. */
export type ShopContact = { email: string | null; storeName: string | null };

const NO_CONTACT: ShopContact = { email: null, storeName: null };

/** RFC 5321 maximum address length. */
const MAX_EMAIL_LENGTH = 254;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/;
/** Upper bound on a cached store name (the email shows at most 80 chars). */
const MAX_STORE_NAME_LENGTH = 255;

function validEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_EMAIL_LENGTH || !EMAIL_SHAPE.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function validStoreName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, MAX_STORE_NAME_LENGTH);
}

/**
 * Read the owner email and store name in one query. Each field is null when
 * missing, blank or malformed; both are null on a GraphQL/transport error.
 */
export async function fetchShopContact(admin: AdminApiContext): Promise<ShopContact> {
  try {
    const response = await admin.graphql(SHOP_CONTACT_QUERY);
    const json = (await response.json()) as ShopContactResponse;

    if (json.errors && json.errors.length > 0) {
      logger.warn("shop-owner-email-graphql-error", { error: json.errors[0]?.message });
      return NO_CONTACT;
    }
    const shop = json.data?.shop;
    return { email: validEmail(shop?.email), storeName: validStoreName(shop?.name) };
  } catch (err) {
    logger.warn("shop-owner-email-fetch-failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NO_CONTACT;
  }
}

/**
 * Read the owner email and store name and cache whatever was read on the Shop
 * row (a field that came back null leaves its cached value untouched; nothing
 * is written when nothing changed). A cache-write failure is logged and the
 * fetched values are still returned.
 */
export async function refreshShopContact(
  shopDomain: string,
  admin: AdminApiContext,
): Promise<ShopContact> {
  const contact = await fetchShopContact(admin);
  if (!contact.email && !contact.storeName) return contact;
  try {
    await setShopContactByDomain(shopDomain, contact);
  } catch (err) {
    logger.warn("shop-alert-email-cache-failed", {
      shop: shopDomain,
      ...safeErrorFields(err),
    });
  }
  return contact;
}

/**
 * refreshShopContact for callers that only need the owner email (the store
 * name is still refreshed and cached). Null when no email was read.
 */
export async function refreshShopAlertEmail(
  shopDomain: string,
  admin: AdminApiContext,
): Promise<string | null> {
  return (await refreshShopContact(shopDomain, admin)).email;
}

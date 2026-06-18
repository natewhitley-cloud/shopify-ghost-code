/**
 * Translation data fetcher service.
 *
 * Queries the Shopify Translations API to detect orphaned translations
 * left by uninstalled translation apps. Uses `read_translations` scope.
 *
 * Detection strategy:
 *   1. Fetch shopLocales to see which locales are enabled
 *   2. For each non-primary locale, sample translatableResources to check
 *      for existing translations
 *   3. Cross-reference with installed apps to detect orphaned translations
 */

import { type GraphQLConnection, paginateConnection } from "../lib/graphql-pagination.server";
import { checkRateLimit } from "../lib/rate-limit-monitor.server";
import { probeScope } from "../lib/scope-check.server";
import type { AdminApiContext } from "../types/shopify";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ShopLocale = {
  locale: string;
  name: string;
  primary: boolean;
  published: boolean;
};

export type TranslationSummary = {
  locale: string;
  localeName: string;
  resourceType: string;
  translatedCount: number;
  outdatedCount: number;
  sampleTranslations: Array<{
    resourceId: string;
    key: string;
    value: string;
    outdated: boolean;
  }>;
};

export type TranslationAuditResult = {
  locales: ShopLocale[];
  summaries: TranslationSummary[];
  totalTranslations: number;
  totalOutdated: number;
};

// ---------------------------------------------------------------------------
// GraphQL queries
// ---------------------------------------------------------------------------

const SHOP_LOCALES_QUERY = `
  {
    shopLocales {
      locale
      name
      primary
      published
    }
  }
`;

const TRANSLATABLE_RESOURCES_QUERY = `
  query TranslatableResources($resourceType: TranslatableResourceType!, $locale: String!, $first: Int!, $after: String) {
    translatableResources(resourceType: $resourceType, first: $first, after: $after) {
      nodes {
        resourceId
        translations(locale: $locale) {
          key
          value
          outdated
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

/** Resource types to check for translations. Covers common cases without excessive API cost. */
const RESOURCE_TYPES = ["PRODUCT", "COLLECTION", "PAGE", "ARTICLE", "ONLINE_STORE_THEME"] as const;

// ---------------------------------------------------------------------------
// Scope detection
// ---------------------------------------------------------------------------

/**
 * Detect if the read_translations scope is available by attempting a
 * lightweight query.
 *
 * Returns false ONLY on a genuine ACCESS_DENIED (scope not granted). Transient
 * failures (THROTTLED, network, 5xx, timeout) throw a TransientScopeCheckError
 * so the caller retries instead of silently treating the scope as missing.
 * See app/lib/scope-check.server.ts (LOG-9).
 */
export async function hasTranslationScope(admin: AdminApiContext): Promise<boolean> {
  return probeScope(admin, `{ shopLocales { locale } }`, "read_translations");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch all shop locales.
 */
export async function fetchShopLocales(admin: AdminApiContext): Promise<ShopLocale[]> {
  const response = await admin.graphql(SHOP_LOCALES_QUERY);
  const json = (await response.json()) as {
    errors?: Array<{ message: string }>;
    data?: { shopLocales?: Array<Record<string, unknown>> };
    extensions?: unknown;
  };

  if (json.errors?.length) {
    throw new Error(
      `[translation-fetcher] Failed to fetch shop locales: ${json.errors[0]?.message ?? "unknown error"}`,
    );
  }

  await checkRateLimit(json.extensions);

  const rawLocales = json.data?.shopLocales ?? [];
  return rawLocales.map((l) => ({
    locale: l.locale as string,
    name: l.name as string,
    primary: l.primary as boolean,
    published: l.published as boolean,
  }));
}

/**
 * Fetch translations for a given locale and resource type.
 *
 * Only fetches up to `sampleSize` resources (default 50) to keep API cost
 * manageable. Counts translations and outdated translations.
 */
export async function fetchTranslationSummary(
  admin: AdminApiContext,
  locale: string,
  localeName: string,
  resourceType: string,
  sampleSize: number = 50,
): Promise<TranslationSummary> {
  type TranslatableResourceNode = {
    resourceId: string;
    translations: Array<{ key: string; value: string; outdated: boolean }>;
  };
  type FlatTranslation = TranslationSummary["sampleTranslations"][number];

  // Pagination caps by the number of resources (nodes) examined, matching the
  // original `sampleSize` semantics. The helper flattens each resource's
  // translations into individual entries; counts are derived afterward.
  const translations = await paginateConnection<TranslatableResourceNode, FlatTranslation>({
    admin,
    query: TRANSLATABLE_RESOURCES_QUERY,
    variables: { resourceType, locale },
    pageSize: 50,
    maxNodes: sampleSize,
    errorContext: `[translation-fetcher] Failed to fetch translations for ${resourceType}/${locale}`,
    getConnection: (data) =>
      (
        data as
          | { translatableResources?: GraphQLConnection<TranslatableResourceNode> }
          | null
          | undefined
      )?.translatableResources,
    mapNode: (node) =>
      node.translations.map((t) => ({
        resourceId: node.resourceId,
        key: t.key,
        value: t.value,
        outdated: t.outdated,
      })),
  });

  return {
    locale,
    localeName,
    resourceType,
    translatedCount: translations.length,
    outdatedCount: translations.filter((t) => t.outdated).length,
    // Keep a small sample for code snippets, preserving encounter order.
    sampleTranslations: translations.slice(0, 10),
  };
}

/**
 * Main entry point for translation auditing.
 *
 * Fetches locales, then for each non-primary locale, queries a selection
 * of resource types. Returns aggregated summary.
 */
export async function auditTranslations(admin: AdminApiContext): Promise<TranslationAuditResult> {
  const locales = await fetchShopLocales(admin);
  const nonPrimaryLocales = locales.filter((l) => !l.primary);

  if (nonPrimaryLocales.length === 0) {
    return {
      locales,
      summaries: [],
      totalTranslations: 0,
      totalOutdated: 0,
    };
  }

  const summaries: TranslationSummary[] = [];
  let totalTranslations = 0;
  let totalOutdated = 0;

  for (const locale of nonPrimaryLocales) {
    for (const resourceType of RESOURCE_TYPES) {
      const summary = await fetchTranslationSummary(
        admin,
        locale.locale,
        locale.name,
        resourceType,
      );
      if (summary.translatedCount > 0) {
        summaries.push(summary);
        totalTranslations += summary.translatedCount;
        totalOutdated += summary.outdatedCount;
      }
    }
  }

  return { locales, summaries, totalTranslations, totalOutdated };
}

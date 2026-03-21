/**
 * App enrichment lookup from the market-research SQLite database.
 *
 * Enriches Shopify app handles with metadata (category, rating, pricing, etc.)
 * sourced from our scraped App Store data. The database lives outside this
 * project and its path is configured via the MARKET_RESEARCH_DB_PATH env var.
 *
 * All lookups are read-only and synchronous (better-sqlite3). The DB connection
 * is opened per-call rather than held open, since enrichment happens during
 * background scans — not in hot request paths.
 */

import Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AppEnrichment {
  categorySlug: string | null;
  categoryName: string | null;
  rating: number | null;
  reviewCount: number | null;
  pricingModel: string | null;
  appStoreUrl: string | null;
}

/** Raw row shape returned by the SQLite query. */
interface EnrichmentRow {
  category_slug: string | null;
  category_name: string | null;
  rating: number | null;
  review_count: number | null;
  pricing_model: string | null;
  url: string | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the path to the market-research SQLite database.
 * Throws if the env var is not set.
 */
function getDbPath(): string {
  const dbPath = process.env.MARKET_RESEARCH_DB_PATH;
  if (!dbPath) {
    throw new Error(
      "MARKET_RESEARCH_DB_PATH environment variable is not set. " +
        "Point it to the shopify_apps.db file from market-research.",
    );
  }
  return dbPath;
}

/**
 * Open a read-only connection to the market-research database.
 * The caller is responsible for closing the connection.
 */
function openDb(): Database.Database {
  return new Database(getDbPath(), { readonly: true });
}

/**
 * Map a raw SQLite row to the public AppEnrichment type.
 */
function rowToEnrichment(row: EnrichmentRow): AppEnrichment {
  return {
    categorySlug: row.category_slug,
    categoryName: row.category_name,
    rating: row.rating,
    reviewCount: row.review_count,
    pricingModel: row.pricing_model,
    appStoreUrl: row.url,
  };
}

// ---------------------------------------------------------------------------
// Prepared statement SQL
// ---------------------------------------------------------------------------

const ENRICHMENT_SQL = `
  SELECT
    a.category_slug,
    c.name AS category_name,
    a.rating,
    a.review_count,
    a.pricing_model,
    a.url
  FROM apps a
  LEFT JOIN categories c ON a.category_slug = c.slug
  WHERE a.slug = ?
`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Look up enrichment data for a single app by its Shopify app handle (slug).
 *
 * Returns null if the app is not found in the market-research database.
 */
export function enrichApp(appHandle: string): AppEnrichment | null {
  const db = openDb();
  try {
    const row = db.prepare(ENRICHMENT_SQL).get(appHandle) as EnrichmentRow | undefined;
    return row ? rowToEnrichment(row) : null;
  } finally {
    db.close();
  }
}

/**
 * Look up enrichment data for multiple apps in a single DB connection.
 *
 * Returns a Map keyed by app handle. Handles that are not found in the
 * database are simply omitted from the result (no null entries).
 */
export function enrichApps(appHandles: string[]): Map<string, AppEnrichment> {
  const result = new Map<string, AppEnrichment>();

  if (appHandles.length === 0) {
    return result;
  }

  const db = openDb();
  try {
    const stmt = db.prepare(ENRICHMENT_SQL);
    for (const handle of appHandles) {
      const row = stmt.get(handle) as EnrichmentRow | undefined;
      if (row) {
        result.set(handle, rowToEnrichment(row));
      }
    }
    return result;
  } finally {
    db.close();
  }
}

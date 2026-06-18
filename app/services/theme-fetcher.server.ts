/**
 * Theme file fetching service.
 *
 * Wraps the Shopify Admin GraphQL API for listing themes and downloading
 * their file contents.  All calls are made through the admin context
 * supplied by the caller — this service itself is stateless.
 *
 * Rate-limit strategy: the shared pagination helper checks throttleStatus
 * after every page and backs off proportionally when headroom drops below 100
 * points (see app/lib/rate-limit-monitor.server.ts).
 */

import { type GraphQLConnection, paginateConnection } from "../lib/graphql-pagination.server";
import type { AdminApiContext } from "../types/shopify";

/** A single theme file with its text content. */
export type ThemeFile = {
  filename: string;
  content: string;
};

// ---------------------------------------------------------------------------
// GraphQL queries
// ---------------------------------------------------------------------------

const MAIN_THEME_QUERY = `
  {
    themes(first: 1, roles: MAIN) {
      nodes {
        id
        name
        updatedAt
      }
    }
  }
`;

const ALL_THEMES_QUERY = `
  query GetAllThemes($first: Int!, $after: String) {
    themes(first: $first, after: $after) {
      nodes {
        id
        name
        role
        updatedAt
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const THEME_FILES_QUERY = `
  query ThemeFiles($themeId: ID!, $first: Int!, $after: String) {
    theme(id: $themeId) {
      files(first: $first, after: $after) {
        nodes {
          filename
          body {
            ... on OnlineStoreThemeFileBodyText {
              content
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Shape returned by the fetchMainTheme query. */
export type MainTheme = {
  id: string;
  name: string;
  updatedAt: Date;
};

/**
 * Fetch the shop's MAIN (published) theme.
 *
 * Returns the theme's GID, display name, and last-updated timestamp.
 * Returns null if no MAIN theme is found (e.g. no published theme set).
 *
 * Both the dashboard loader/action and the daily poll cron use this function
 * to avoid duplicating the GraphQL query.  The dashboard callers may ignore
 * `updatedAt`; the cron uses it to detect whether a re-scan is needed.
 */
export async function fetchMainTheme(admin: AdminApiContext): Promise<MainTheme | null> {
  const response = await admin.graphql(MAIN_THEME_QUERY);
  const json = (await response.json()) as {
    errors?: Array<{ message: string }>;
    data?: { themes?: { nodes?: Array<Record<string, unknown>> } };
  };

  if (json.errors?.length) {
    throw new Error(
      `[theme-fetcher] Failed to fetch main theme: ${json.errors[0]?.message ?? "unknown error"}`,
    );
  }

  const node = json.data?.themes?.nodes?.[0];
  if (!node) return null;

  return {
    id: node.id as string,
    name: node.name as string,
    updatedAt: new Date(node.updatedAt as string),
  };
}

/** A theme listing entry returned by fetchAllThemes. */
export type ThemeSummary = {
  id: string;
  name: string;
  role: string;
  updatedAt: string;
};

/**
 * Fetch all themes for a shop, handling cursor-based pagination.
 *
 * Returns themes sorted with MAIN first, then alphabetically by name.
 * Most stores have fewer than 20 themes so this will typically complete
 * in a single page, but pagination is handled for correctness.
 *
 * @param admin  Shopify admin API context (from authenticate.admin or offline token).
 */
export async function fetchAllThemes(admin: AdminApiContext): Promise<ThemeSummary[]> {
  // Most stores have fewer than 20 themes; 50 per page is sufficient while keeping GraphQL cost low.
  const PAGE_SIZE = 50;

  type ThemeNode = { id: string; name: string; role: string; updatedAt: string };

  const themes = await paginateConnection<ThemeNode, ThemeSummary>({
    admin,
    query: ALL_THEMES_QUERY,
    pageSize: PAGE_SIZE,
    errorContext: "[theme-fetcher] Failed to fetch themes",
    getConnection: (data) =>
      (data as { themes?: GraphQLConnection<ThemeNode> } | null | undefined)?.themes,
    mapNode: (node) => [
      { id: node.id, name: node.name, role: node.role, updatedAt: node.updatedAt },
    ],
  });

  // Sort: MAIN role first, then alphabetically by name.
  themes.sort((a, b) => {
    if (a.role === "MAIN" && b.role !== "MAIN") return -1;
    if (a.role !== "MAIN" && b.role === "MAIN") return 1;
    return a.name.localeCompare(b.name);
  });

  return themes;
}

/**
 * Fetch every text file in a theme, handling cursor-based pagination.
 *
 * - Uses `first: 250` per page (maximum allowed).
 * - Skips files whose body has no text content (binary assets, etc.).
 * - Backs off automatically when the rate-limit headroom falls below 100 pts.
 *
 * @param admin    Shopify admin API context (from authenticate.admin or offline token).
 * @param themeId  Theme GID, e.g. `gid://shopify/Theme/123456789`.
 */
export async function fetchThemeFiles(
  admin: AdminApiContext,
  themeId: string,
  shopDomain?: string,
): Promise<ThemeFile[]> {
  const PAGE_SIZE = 250;

  type ThemeFileNode = { filename: string; body?: { content?: string } };

  return paginateConnection<ThemeFileNode, ThemeFile>({
    admin,
    query: THEME_FILES_QUERY,
    variables: { themeId },
    pageSize: PAGE_SIZE,
    errorContext: `[theme-fetcher] Failed to fetch files for theme ${themeId}`,
    shopDomain,
    getConnection: (data) => {
      const theme = (
        data as { theme?: { files?: GraphQLConnection<ThemeFileNode> } | null } | null | undefined
      )?.theme;
      if (!theme) {
        // Theme data is null/undefined without a top-level errors array — the
        // theme was deleted, access was denied, or the response was malformed.
        // Returning the files accumulated so far (usually an empty array on the
        // first page) would let the caller complete the scan as "clean" and wipe
        // every prior finding, making a transient soft-failure indistinguishable
        // from a genuinely clean theme (LOG-5). Throw instead so Inngest retries
        // and ultimately marks the scan FAILED rather than falsely COMPLETED.
        // Throwing mid-pagination is deliberate: a retry is safer than persisting
        // a partial file list.
        throw new Error(
          `[theme-fetcher] No theme data returned for theme ${themeId} ` +
            `(deleted, access denied, or malformed response). Aborting fetch to avoid a false-clean scan.`,
        );
      }
      // The connection lives on theme.files; theme itself is the parent object.
      return theme.files;
    },
    // body is a union type; only OnlineStoreThemeFileBodyText has content.
    mapNode: (node) =>
      typeof node.body?.content === "string"
        ? [{ filename: node.filename, content: node.body.content }]
        : [],
  });
}

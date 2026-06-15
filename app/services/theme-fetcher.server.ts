/**
 * Theme file fetching service.
 *
 * Wraps the Shopify Admin GraphQL API for listing themes and downloading
 * their file contents.  All calls are made through the admin context
 * supplied by the caller — this service itself is stateless.
 *
 * Rate-limit strategy: check throttleStatus after every paginated page and
 * back off proportionally when headroom drops below 100 points.
 */

import { checkThrottleStatusFromExtensions } from "../lib/rate-limit-monitor.server";
import type { AdminApiContext } from "../types/shopify";

/** A single theme file with its text content. */
export type ThemeFile = {
  filename: string;
  content: string;
};

// ---------------------------------------------------------------------------
// Rate-limit helper
// ---------------------------------------------------------------------------

const RATE_LIMIT_THRESHOLD = 100;

/**
 * Inspect throttleStatus and sleep if headroom is low.
 *
 * @param extensions  Raw extensions object from a GraphQL response.
 * @returns           Currently available query-cost points (after any sleep).
 */
export async function checkRateLimit(extensions: unknown): Promise<number> {
  const ext = extensions as Record<string, unknown> | undefined;
  const cost = ext?.cost as Record<string, unknown> | undefined;
  const throttle = cost?.throttleStatus as
    | { currentlyAvailable?: number; restoreRate?: number }
    | undefined;

  if (!throttle) return Infinity;

  const currentlyAvailable: number = throttle.currentlyAvailable ?? 0;
  const restoreRate: number = throttle.restoreRate ?? 50;

  if (currentlyAvailable < RATE_LIMIT_THRESHOLD) {
    const pointsNeeded = RATE_LIMIT_THRESHOLD - currentlyAvailable;
    const sleepMs = Math.ceil((pointsNeeded / restoreRate) * 1000);
    console.log(
      `[theme-fetcher] Rate limit headroom low (${currentlyAvailable} pts). ` +
        `Sleeping ${sleepMs}ms to restore capacity.`,
    );
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
    return RATE_LIMIT_THRESHOLD; // optimistic — we just waited for it
  }

  return currentlyAvailable;
}

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
  const themes: ThemeSummary[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;
  // Most stores have fewer than 20 themes; 50 per page is sufficient while keeping GraphQL cost low.
  const PAGE_SIZE = 50;

  while (hasNextPage) {
    const response = await admin.graphql(ALL_THEMES_QUERY, {
      variables: {
        first: PAGE_SIZE,
        ...(cursor !== null ? { after: cursor } : {}),
      },
    });

    const json = (await response.json()) as {
      errors?: Array<{ message: string }>;
      data?: {
        themes?: {
          nodes?: Array<{ id: string; name: string; role: string; updatedAt: string }>;
          pageInfo?: { hasNextPage?: boolean; endCursor?: string };
        };
      };
      extensions?: unknown;
    };

    if (json.errors?.length) {
      throw new Error(
        `[theme-fetcher] Failed to fetch themes: ${json.errors[0]?.message ?? "unknown error"}`,
      );
    }

    const nodes = json.data?.themes?.nodes ?? [];
    const pageInfo = json.data?.themes?.pageInfo ?? {};

    for (const node of nodes) {
      themes.push({
        id: node.id,
        name: node.name,
        role: node.role,
        updatedAt: node.updatedAt,
      });
    }

    hasNextPage = Boolean(pageInfo.hasNextPage);
    cursor = pageInfo.endCursor ?? null;

    await checkRateLimit(json.extensions);
  }

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
  const files: ThemeFile[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;
  const PAGE_SIZE = 250;

  while (hasNextPage) {
    const response = await admin.graphql(THEME_FILES_QUERY, {
      variables: {
        themeId,
        first: PAGE_SIZE,
        ...(cursor !== null ? { after: cursor } : {}),
      },
    });

    const json = (await response.json()) as {
      errors?: Array<{ message: string }>;
      data?: {
        theme?: {
          files?: {
            nodes?: Array<{ filename: string; body?: { content?: string } }>;
            pageInfo?: { hasNextPage?: boolean; endCursor?: string };
          };
        };
      };
      extensions?: unknown;
    };

    if (json.errors?.length) {
      throw new Error(
        `[theme-fetcher] Failed to fetch files for theme ${themeId}: ` +
          (json.errors[0]?.message ?? "unknown error"),
      );
    }

    const themeData = json.data?.theme;
    if (!themeData) {
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

    const nodes = themeData.files?.nodes ?? [];
    const pageInfo = themeData.files?.pageInfo ?? {};

    for (const node of nodes) {
      // body is a union type; only OnlineStoreThemeFileBodyText has content.
      const content: string | undefined = node.body?.content;
      if (typeof content === "string") {
        files.push({ filename: node.filename, content });
      }
    }

    hasNextPage = Boolean(pageInfo.hasNextPage);
    cursor = pageInfo.endCursor ?? null;

    // Check rate limits after each page; sleep if needed before continuing.
    await checkRateLimit(json.extensions);

    // Log a structured warning/error if the shop is approaching its rate limit.
    // Non-blocking — does not change pagination or error handling behavior.
    if (shopDomain) {
      checkThrottleStatusFromExtensions(shopDomain, json.extensions);
    }
  }

  return files;
}

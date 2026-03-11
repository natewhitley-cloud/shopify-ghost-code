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

/** A single theme file with its text content. */
export type ThemeFile = {
  filename: string;
  content: string;
};

/** Minimal slice of the Shopify admin context we use in this service. */
type AdminApiContext = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<{ json: () => Promise<unknown> }>;
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
  const throttle = (extensions as any)?.cost?.throttleStatus;

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
  const json = (await response.json()) as any;

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

    const json = (await response.json()) as any;

    if (json.errors?.length) {
      throw new Error(
        `[theme-fetcher] Failed to fetch files for theme ${themeId}: ` +
          (json.errors[0]?.message ?? "unknown error"),
      );
    }

    const themeData = json.data?.theme;
    if (!themeData) {
      // Theme not found or access denied — return what we have so far.
      console.log(
        `[theme-fetcher] No theme data returned for themeId ${themeId}. Stopping pagination.`,
      );
      break;
    }

    const nodes: any[] = themeData.files?.nodes ?? [];
    const pageInfo = themeData.files?.pageInfo ?? {};

    for (const node of nodes) {
      // body is a union type; only OnlineStoreThemeFileBodyText has content.
      const content: string | undefined = node.body?.content;
      if (typeof content === "string") {
        files.push({ filename: node.filename as string, content });
      }
    }

    hasNextPage = Boolean(pageInfo.hasNextPage);
    cursor = pageInfo.endCursor ?? null;

    // Check rate limits after each page; sleep if needed before continuing.
    await checkRateLimit(json.extensions);
  }

  return files;
}

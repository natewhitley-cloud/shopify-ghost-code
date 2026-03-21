/**
 * Permission fetcher service.
 *
 * Fetches installed apps and their granted OAuth scopes from the Shopify
 * GraphQL Admin API. Supports two paths:
 *
 *   - Path A (read_apps scope approved): Uses `appInstallations` to fetch ALL
 *     installed apps on the shop.
 *   - Path B (fallback): Uses `currentAppInstallation` which only returns
 *     Ghost Code itself (no special scope required).
 *
 * Rate-limit strategy mirrors theme-fetcher: check throttleStatus after every
 * paginated page and back off when headroom drops below 100 points.
 */

import { checkRateLimit } from "./theme-fetcher.server";
import {
  upsertInstalledApp,
  markAppsRemovedByIds,
  getInstalledApps,
} from "../models/installed-app.server";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape returned from GraphQL for a single installed app. */
export type FetchedApp = {
  id: string;
  title: string;
  handle: string;
  description: string | null;
  publicCategory: string | null;
  accessScopes: Array<{ handle: string; description: string | null }>;
  hasActiveSubscription: boolean;
};

/** Minimal slice of the Shopify admin context we use in this service. */
type AdminApiContext = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<{ json: () => Promise<unknown> }>;
};

// ---------------------------------------------------------------------------
// GraphQL queries
// ---------------------------------------------------------------------------

const APP_INSTALLATIONS_QUERY = `
  query AppInstallations($first: Int!, $after: String) {
    appInstallations(first: $first, after: $after) {
      nodes {
        app {
          id
          title
          handle
          description
          publicCategory
        }
        accessScopes {
          handle
          description
        }
        activeSubscriptions {
          id
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const CURRENT_APP_INSTALLATION_QUERY = `
  {
    currentAppInstallation {
      app {
        id
        title
        handle
        description
        publicCategory
      }
      accessScopes {
        handle
        description
      }
      activeSubscriptions {
        id
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Detect whether a GraphQL error indicates a missing scope / permission issue.
 * Shopify returns "ACCESS_DENIED" or scope-related error messages when the
 * app lacks the required scope.
 */
function isScopeError(errors: Array<{ message: string }>): boolean {
  return errors.some(
    (e) =>
      e.message.includes("ACCESS_DENIED") ||
      e.message.includes("access denied") ||
      e.message.includes("missing required scope") ||
      e.message.includes("does not have the required permissions") ||
      /\bread_apps\b/.test(e.message),
  );
}

/** Map a raw GraphQL app installation node to our FetchedApp shape. */
function nodeToFetchedApp(node: {
  app: {
    id: string;
    title: string;
    handle: string;
    description: string | null;
    publicCategory: string | null;
  };
  accessScopes: Array<{ handle: string; description: string | null }>;
  activeSubscriptions: Array<{ id: string }>;
}): FetchedApp {
  return {
    id: node.app.id,
    title: node.app.title,
    handle: node.app.handle,
    description: node.app.description,
    publicCategory: node.app.publicCategory,
    accessScopes: node.accessScopes,
    hasActiveSubscription: node.activeSubscriptions.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch all installed apps on a shop using the `appInstallations` query.
 *
 * Requires the `read_apps` scope. If the query fails with a scope/permission
 * error, logs a warning and returns an empty array (graceful fallback — the
 * caller can then use `fetchCurrentAppInstallation` instead).
 */
export async function fetchAllInstalledApps(admin: AdminApiContext): Promise<FetchedApp[]> {
  const apps: FetchedApp[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;
  const PAGE_SIZE = 50;

  while (hasNextPage) {
    let response;
    try {
      response = await admin.graphql(APP_INSTALLATIONS_QUERY, {
        variables: {
          first: PAGE_SIZE,
          ...(cursor !== null ? { after: cursor } : {}),
        },
      });
    } catch (err) {
      console.log(
        `[permission-fetcher] Network error fetching app installations: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return apps;
    }

    const json = (await response.json()) as {
      errors?: Array<{ message: string }>;
      data?: {
        appInstallations?: {
          nodes?: Array<{
            app: {
              id: string;
              title: string;
              handle: string;
              description: string | null;
              publicCategory: string | null;
            };
            accessScopes: Array<{
              handle: string;
              description: string | null;
            }>;
            activeSubscriptions: Array<{ id: string }>;
          }>;
          pageInfo?: { hasNextPage?: boolean; endCursor?: string };
        };
      };
      extensions?: unknown;
    };

    if (json.errors?.length) {
      if (isScopeError(json.errors)) {
        console.log(
          `[permission-fetcher] appInstallations query returned scope error: ` +
            `${json.errors[0]?.message ?? "unknown"}. Returning empty array.`,
        );
        return [];
      }
      throw new Error(
        `[permission-fetcher] Failed to fetch app installations: ` +
          (json.errors[0]?.message ?? "unknown error"),
      );
    }

    const installationsData = json.data?.appInstallations;
    if (!installationsData) {
      console.log(`[permission-fetcher] No appInstallations data returned. Stopping pagination.`);
      break;
    }

    const nodes = installationsData.nodes ?? [];
    for (const node of nodes) {
      apps.push(nodeToFetchedApp(node));
    }

    const pageInfo = installationsData.pageInfo ?? {};
    hasNextPage = Boolean(pageInfo.hasNextPage);
    cursor = pageInfo.endCursor ?? null;

    await checkRateLimit(json.extensions);
  }

  return apps;
}

/**
 * Fetch Ghost Code's own app installation using `currentAppInstallation`.
 *
 * This always works — no special scope required. Useful as a fallback when
 * `read_apps` is not yet approved, or as a self-check.
 */
export async function fetchCurrentAppInstallation(admin: AdminApiContext): Promise<FetchedApp> {
  const response = await admin.graphql(CURRENT_APP_INSTALLATION_QUERY);
  const json = (await response.json()) as {
    errors?: Array<{ message: string }>;
    data?: {
      currentAppInstallation?: {
        app: {
          id: string;
          title: string;
          handle: string;
          description: string | null;
          publicCategory: string | null;
        };
        accessScopes: Array<{
          handle: string;
          description: string | null;
        }>;
        activeSubscriptions: Array<{ id: string }>;
      };
    };
    extensions?: unknown;
  };

  if (json.errors?.length) {
    throw new Error(
      `[permission-fetcher] Failed to fetch current app installation: ` +
        (json.errors[0]?.message ?? "unknown error"),
    );
  }

  const installation = json.data?.currentAppInstallation;
  if (!installation) {
    throw new Error(`[permission-fetcher] No currentAppInstallation data returned.`);
  }

  return nodeToFetchedApp(installation);
}

/**
 * Sync fetched app data into the InstalledApp model.
 *
 * - Upserts each FetchedApp (keyed on shopId + shopifyAppId).
 * - Marks apps that are in the DB but NOT in fetchedApps as REMOVED.
 * - Updates lastSeenAt for apps that are still present.
 */
export async function syncInstalledApps(shopId: string, fetchedApps: FetchedApp[]): Promise<void> {
  const fetchedAppIds = new Set(fetchedApps.map((a) => a.id));

  // Upsert each fetched app via model layer
  for (const app of fetchedApps) {
    const scopeHandles = app.accessScopes.map((s) => s.handle);

    await upsertInstalledApp(shopId, {
      shopifyAppId: app.id,
      appHandle: app.handle,
      appName: app.title,
      appDescription: app.description ?? undefined,
      publicCategory: app.publicCategory ?? undefined,
      grantedScopes: JSON.stringify(scopeHandles),
      grantedScopeCount: scopeHandles.length,
      hasActiveSubscription: app.hasActiveSubscription,
    });
  }

  // Mark apps not in the fetched set as REMOVED
  const existingApps = await getInstalledApps(shopId);
  const removedIds = existingApps
    .filter((a) => !fetchedAppIds.has(a.shopifyAppId))
    .map((a) => a.id);

  await markAppsRemovedByIds(removedIds);
}

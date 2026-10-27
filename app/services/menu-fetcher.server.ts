/**
 * Navigation menu fetcher (gc-7gjj.1, spike §2.2).
 *
 * Reads every menu item's title and URL through the Admin `menus` query so the
 * menu-label injection detector (menu-injection-detector.server.ts) can check
 * them. Requires `read_online_store_navigation`, the SAME optional scope as the
 * redirect audit, so the scope check reuses hasNavigationScope (no new probe).
 *
 * The query was validated against the Admin schema (Shopify's validator,
 * 2026-10-26; required scope reported: read_online_store_navigation). Menu
 * items nest three levels (a top-level item plus two levels of drop-downs), and
 * `items` is a plain list, not a connection, so one menu comes back whole.
 *
 * Cost: Shopify does not document it, and a menu can hold up to 10,000 items.
 * Measured on a real store (gc-7gjj.5, 2026-10-27): at first=50 the query
 * costs requested 30 / actual 5 (bucket 2000), so MENU_PAGE_SIZE is 50
 * (gc-7gjj.9; was 5). The walk still stops at MENU_CAP menus and
 * MENU_ITEM_CAP items.
 * Hitting either cap marks the category capped (cappedCategories), so the
 * differ never resolves a finding past the cap.
 */
import type { MenuItemData } from "./menu-injection-detector.server";
import {
  type GraphQLConnection,
  type PaginateStats,
  paginateConnection,
} from "../lib/graphql-pagination.server";
import type { AdminApiContext } from "../types/shopify";

/** Menus requested per page (measured: requested cost 30 / actual 5 at 50, gc-7gjj.9). */
export const MENU_PAGE_SIZE = 50;
/** Max menus read per scan (Shopify allows 1,000; real stores have 2-10). */
export const MENU_CAP = 250;
/** Max menu items read per scan, across every menu and level. */
export const MENU_ITEM_CAP = 5_000;

// `sortKey: ID` is the API default, spelled out so a capped walk always covers
// the same (lowest-id) menus.
export const MENUS_QUERY = `
  query MenuLabels($first: Int!, $after: String) {
    menus(first: $first, after: $after, sortKey: ID) {
      nodes {
        id
        title
        items {
          id
          title
          url
          items {
            id
            title
            url
            items {
              id
              title
              url
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

type MenuItemNode = {
  id: string;
  title?: string | null;
  url?: string | null;
  items?: MenuItemNode[] | null;
};

type MenuNode = { id: string; title?: string | null; items?: MenuItemNode[] | null };

/** The numeric id at the end of a GID (`gid://shopify/Menu/123` -> `123`), else the input. */
export function numericGidTail(gid: string): string {
  const match = /\/(\d+)$/.exec(gid);
  return match ? match[1] : gid;
}

/** Every item of one menu, depth first, each with its parents' titles. */
export function flattenMenu(menu: MenuNode): MenuItemData[] {
  const out: MenuItemData[] = [];
  const menuId = numericGidTail(menu.id);
  const menuTitle = menu.title ?? "";
  const walk = (items: MenuItemNode[] | null | undefined, parents: string[]): void => {
    for (const item of items ?? []) {
      const title = item.title ?? "";
      out.push({
        menuId,
        menuTitle,
        itemId: numericGidTail(item.id),
        parents,
        title,
        url: item.url ?? null,
      });
      walk(item.items, [...parents, title]);
    }
  };
  walk(menu.items, []);
  return out;
}

export interface MenuFetchResult {
  items: MenuItemData[];
  /** True when a cap (menus or items) left part of the store's menus unread. */
  capped: boolean;
}

/**
 * Every menu item of the store, up to the caps. Throws on a GraphQL error
 * (paginateConnection) or a response without `menus`, so the Inngest step retries rather than reading a
 * failed fetch as "no menus".
 */
export async function fetchMenuItems(
  admin: AdminApiContext,
  stats: PaginateStats = { pageCount: 0, nodeCount: 0, truncated: false, throttleSleepMs: 0 },
): Promise<MenuFetchResult> {
  let kept = 0;
  let itemsCapped = false;
  const items = await paginateConnection<MenuNode, MenuItemData>({
    admin,
    query: MENUS_QUERY,
    pageSize: MENU_PAGE_SIZE,
    maxNodes: MENU_CAP,
    errorContext: "[menu-fetcher] Failed to fetch menus",
    // A response with no `menus` connection is a failed read, never "no
    // menus": throw so the step records the audit as not run and no prior
    // finding resolves (audit fix).
    getConnection: (data) => {
      const menus = (data as { menus?: GraphQLConnection<MenuNode> | null } | null | undefined)
        ?.menus;
      if (!menus) throw new Error("[menu-fetcher] Failed to fetch menus: no menus connection");
      return menus;
    },
    // Items past the cap are dropped as they arrive, so what is KEPT stays
    // bounded by MENU_ITEM_CAP. One response can still carry up to 50 menus'
    // full item lists (Shopify allows 10,000 items per menu); the measured
    // cost (gc-7gjj.9) came from a small store, so a huge store's payload size
    // is unmeasured.
    mapNode: (menu) => {
      const flat = flattenMenu(menu);
      const room = MENU_ITEM_CAP - kept;
      if (flat.length > room) itemsCapped = true;
      const keep = flat.length > room ? flat.slice(0, Math.max(0, room)) : flat;
      kept += keep.length;
      return keep;
    },
    // Once MENU_ITEM_CAP items are kept, request no further page: every item
    // on it would be dropped (deferred LOW, gc-7gjj.1). Stopping with menus
    // left marks the walk truncated, so it reads as capped.
    stopWhen: () => kept >= MENU_ITEM_CAP,
    stats,
  });
  return { items, capped: stats.truncated || itemsCapped };
}

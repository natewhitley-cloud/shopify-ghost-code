/**
 * Navigation menu fetcher (gc-7gjj.1): the Admin `menus` walk, flattened to
 * one row per item (three levels, with parents), with the MENU_CAP /
 * MENU_ITEM_CAP bounds reported as `capped`. GraphQL is mocked; no network.
 */
import { describe, it, expect, vi } from "vitest";

import {
  fetchMenuItems,
  flattenMenu,
  MENU_CAP,
  MENU_ITEM_CAP,
  MENU_PAGE_SIZE,
  MENUS_QUERY,
  numericGidTail,
} from "../../app/services/menu-fetcher.server";

function mockAdmin(responses: unknown[]) {
  let callIndex = 0;
  return {
    graphql: vi.fn(async () => {
      const response = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;
      return { json: async () => response };
    }),
  };
}

const page = (nodes: unknown[], hasNextPage = false, endCursor: string | null = null) => ({
  data: { menus: { nodes, pageInfo: { hasNextPage, endCursor } } },
});

const MAIN_MENU = {
  id: "gid://shopify/Menu/11",
  title: "Main menu",
  items: [
    {
      id: "gid://shopify/MenuItem/1",
      title: "Shop",
      url: "/collections/all",
      items: [
        {
          id: "gid://shopify/MenuItem/2",
          title: "Sale",
          url: "/collections/sale",
          items: [{ id: "gid://shopify/MenuItem/3", title: "Shoes", url: null }],
        },
      ],
    },
    { id: "gid://shopify/MenuItem/4", title: "About", url: "/pages/about", items: [] },
  ],
};

describe("numericGidTail", () => {
  it("takes the numeric id from a GID, else returns the input", () => {
    expect(numericGidTail("gid://shopify/Menu/123")).toBe("123");
    expect(numericGidTail("gid://shopify/MenuItem/9")).toBe("9");
    expect(numericGidTail("weird")).toBe("weird");
  });
});

describe("flattenMenu", () => {
  it("lists every item depth first, three levels, each with its parents' titles", () => {
    expect(flattenMenu(MAIN_MENU)).toEqual([
      {
        menuId: "11",
        menuTitle: "Main menu",
        itemId: "1",
        parents: [],
        title: "Shop",
        url: "/collections/all",
      },
      {
        menuId: "11",
        menuTitle: "Main menu",
        itemId: "2",
        parents: ["Shop"],
        title: "Sale",
        url: "/collections/sale",
      },
      {
        menuId: "11",
        menuTitle: "Main menu",
        itemId: "3",
        parents: ["Shop", "Sale"],
        title: "Shoes",
        url: null,
      },
      {
        menuId: "11",
        menuTitle: "Main menu",
        itemId: "4",
        parents: [],
        title: "About",
        url: "/pages/about",
      },
    ]);
  });

  it("an empty menu or missing fields yield no items and empty strings", () => {
    expect(flattenMenu({ id: "gid://shopify/Menu/1", title: null, items: null })).toEqual([]);
    expect(
      flattenMenu({ id: "gid://shopify/Menu/1", items: [{ id: "gid://shopify/MenuItem/5" }] }),
    ).toEqual([{ menuId: "1", menuTitle: "", itemId: "5", parents: [], title: "", url: null }]);
  });
});

describe("fetchMenuItems", () => {
  it("asks for menus, item titles and URLs three levels deep, sorted by id", () => {
    expect(MENUS_QUERY).toContain("menus(first: $first, after: $after, sortKey: ID)");
    expect(MENUS_QUERY.match(/items \{/g)).toHaveLength(3);
    expect(MENUS_QUERY.match(/\burl\b/g)).toHaveLength(3);
  });

  it("walks every page and returns the flattened items, not capped", async () => {
    const admin = mockAdmin([
      page([MAIN_MENU], true, "c1"),
      page([
        {
          id: "gid://shopify/Menu/12",
          title: "Footer",
          items: [{ id: "gid://shopify/MenuItem/9", title: "FAQ", url: "/pages/faq" }],
        },
      ]),
    ]);
    const result = await fetchMenuItems(admin as never);
    expect(result.capped).toBe(false);
    expect(result.items.map((i) => `${i.menuId}/${i.itemId}`)).toEqual([
      "11/1",
      "11/2",
      "11/3",
      "11/4",
      "12/9",
    ]);
    expect(admin.graphql).toHaveBeenCalledTimes(2);
    const [, firstOpts] = admin.graphql.mock.calls[0] as unknown as [
      string,
      { variables: { first: number } },
    ];
    expect(firstOpts.variables.first).toBe(MENU_PAGE_SIZE);
  });

  it("reads 50 menus per page (measured cost: requested 30 / actual 5, gc-7gjj.9)", async () => {
    const admin = mockAdmin([page([])]);
    await fetchMenuItems(admin as never);
    const [, opts] = admin.graphql.mock.calls[0] as unknown as [
      string,
      { variables: { first: number } },
    ];
    expect(opts.variables.first).toBe(50);
    // The caps are unchanged, and a capped walk is a whole number of pages.
    expect(MENU_CAP).toBe(250);
    expect(MENU_ITEM_CAP).toBe(5_000);
    expect(MENU_CAP % MENU_PAGE_SIZE).toBe(0);
  });

  it("a store with no menus returns nothing", async () => {
    const result = await fetchMenuItems(mockAdmin([page([])]) as never);
    expect(result).toEqual({ items: [], capped: false });
  });

  it("stops at MENU_ITEM_CAP items and reports capped", async () => {
    const bigItems = Array.from({ length: MENU_ITEM_CAP + 10 }, (_, i) => ({
      id: `gid://shopify/MenuItem/${i}`,
      title: `Item ${i}`,
      url: "/x",
    }));
    const admin = mockAdmin([
      page([{ id: "gid://shopify/Menu/1", title: "Huge", items: bigItems }], true, "c1"),
      page([MAIN_MENU]),
    ]);
    const result = await fetchMenuItems(admin as never);
    expect(result.items).toHaveLength(MENU_ITEM_CAP);
    expect(result.capped).toBe(true);
  });

  // Deferred LOW (gc-7gjj.1): once MENU_ITEM_CAP items are kept, no further
  // page is requested (it used to keep paging up to MENU_CAP menus).
  it("requests no further page once MENU_ITEM_CAP items are kept", async () => {
    const items = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `gid://shopify/MenuItem/${i}`,
        title: `Item ${i}`,
        url: "/x",
      }));
    const admin = mockAdmin([
      page(
        [{ id: "gid://shopify/Menu/1", title: "Huge", items: items(MENU_ITEM_CAP) }],
        true,
        "c1",
      ),
      page([MAIN_MENU], true, "c2"),
      page([MAIN_MENU]),
    ]);
    const result = await fetchMenuItems(admin as never);
    expect(admin.graphql).toHaveBeenCalledTimes(1);
    expect(result.items).toHaveLength(MENU_ITEM_CAP);
    // Exactly at the cap with menus left unread: still capped.
    expect(result.capped).toBe(true);
  });

  it("at exactly MENU_ITEM_CAP items with no more menus, is not capped", async () => {
    const items = Array.from({ length: MENU_ITEM_CAP }, (_, i) => ({
      id: `gid://shopify/MenuItem/${i}`,
      title: `Item ${i}`,
      url: "/x",
    }));
    const admin = mockAdmin([page([{ id: "gid://shopify/Menu/1", title: "Huge", items }])]);
    const result = await fetchMenuItems(admin as never);
    expect(result.items).toHaveLength(MENU_ITEM_CAP);
    expect(result.capped).toBe(false);
  });

  it("stops at MENU_CAP menus and reports capped", async () => {
    const menus = (from: number) =>
      Array.from({ length: MENU_PAGE_SIZE }, (_, i) => ({
        id: `gid://shopify/Menu/${from + i}`,
        title: "M",
        items: [],
      }));
    let n = 0;
    const admin = {
      graphql: vi.fn(async () => {
        const nodes = menus(n * MENU_PAGE_SIZE);
        n += 1;
        return { json: async () => page(nodes, true, `c${n}`) };
      }),
    };
    const result = await fetchMenuItems(admin as never);
    expect(result.capped).toBe(true);
    expect(admin.graphql).toHaveBeenCalledTimes(MENU_CAP / MENU_PAGE_SIZE);
  });

  it("throws on a GraphQL error (the step retries; never read as no menus)", async () => {
    const admin = mockAdmin([{ errors: [{ message: "Internal error" }] }]);
    await expect(fetchMenuItems(admin as never)).rejects.toThrow(/Failed to fetch menus/);
  });

  // Audit fix: a response without the connection is a failed read, so the
  // step records the audit as not run and never resolves prior findings.
  it.each([
    ["null menus", { data: { menus: null } }],
    ["missing menus", { data: {} }],
    ["null data", { data: null }],
  ])("throws when the response has %s (never read as no menus)", async (_label, response) => {
    const admin = mockAdmin([response]);
    await expect(fetchMenuItems(admin as never)).rejects.toThrow(/Failed to fetch menus/);
  });
});

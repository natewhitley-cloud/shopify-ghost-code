import { describe, it, expect, vi } from "vitest";

import {
  fetchShopLocales,
  fetchTranslationSummary,
  auditTranslations,
  hasTranslationScope,
} from "../../app/services/translation-fetcher.server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AdminApiContext = Parameters<typeof fetchShopLocales>[0];

function makeAdmin(graphqlMock: ReturnType<typeof vi.fn>): AdminApiContext {
  return { graphql: graphqlMock } as unknown as AdminApiContext;
}

function makeLocalesResponse(locales: Array<Record<string, unknown>>) {
  return {
    json: vi.fn().mockResolvedValue({
      data: { shopLocales: locales },
      extensions: {
        cost: {
          throttleStatus: {
            maximumAvailable: 2000,
            currentlyAvailable: 1800,
            restoreRate: 100,
          },
        },
      },
    }),
  };
}

function makeTranslatableResourcesResponse(
  nodes: Array<{
    resourceId: string;
    translations: Array<{ key: string; value: string; outdated: boolean }>;
  }>,
  pageInfo: { hasNextPage: boolean; endCursor: string | null } = {
    hasNextPage: false,
    endCursor: null,
  },
) {
  return {
    json: vi.fn().mockResolvedValue({
      data: {
        translatableResources: { nodes, pageInfo },
      },
      extensions: {
        cost: {
          throttleStatus: {
            maximumAvailable: 2000,
            currentlyAvailable: 1800,
            restoreRate: 100,
          },
        },
      },
    }),
  };
}

function makeErrorResponse(message: string) {
  return {
    json: vi.fn().mockResolvedValue({
      errors: [{ message }],
      data: null,
    }),
  };
}

// ---------------------------------------------------------------------------
// hasTranslationScope
// ---------------------------------------------------------------------------

describe("hasTranslationScope", () => {
  it("returns true when query succeeds", async () => {
    const graphql = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        data: { shopLocales: [{ locale: "en" }] },
      }),
    });
    const admin = makeAdmin(graphql);

    expect(await hasTranslationScope(admin)).toBe(true);
  });

  it("returns false when ACCESS_DENIED error", async () => {
    const graphql = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        errors: [{ message: "Access denied" }],
        data: null,
      }),
    });
    const admin = makeAdmin(graphql);

    expect(await hasTranslationScope(admin)).toBe(false);
  });

  it("returns false on network error", async () => {
    const graphql = vi.fn().mockRejectedValue(new Error("Network error"));
    const admin = makeAdmin(graphql);

    expect(await hasTranslationScope(admin)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fetchShopLocales
// ---------------------------------------------------------------------------

describe("fetchShopLocales", () => {
  it("returns parsed locales from GraphQL response", async () => {
    const graphql = vi.fn().mockResolvedValue(
      makeLocalesResponse([
        { locale: "en", name: "English", primary: true, published: true },
        { locale: "fr", name: "French", primary: false, published: true },
      ]),
    );
    const admin = makeAdmin(graphql);

    const locales = await fetchShopLocales(admin);

    expect(locales).toEqual([
      { locale: "en", name: "English", primary: true, published: true },
      { locale: "fr", name: "French", primary: false, published: true },
    ]);
  });

  it("handles empty locales list", async () => {
    const graphql = vi.fn().mockResolvedValue(makeLocalesResponse([]));
    const admin = makeAdmin(graphql);

    const locales = await fetchShopLocales(admin);

    expect(locales).toEqual([]);
  });

  it("throws on API errors", async () => {
    const graphql = vi.fn().mockResolvedValue(makeErrorResponse("Something went wrong"));
    const admin = makeAdmin(graphql);

    await expect(fetchShopLocales(admin)).rejects.toThrow("Failed to fetch shop locales");
  });
});

// ---------------------------------------------------------------------------
// fetchTranslationSummary
// ---------------------------------------------------------------------------

describe("fetchTranslationSummary", () => {
  it("counts translations and outdated translations", async () => {
    const graphql = vi.fn().mockResolvedValue(
      makeTranslatableResourcesResponse([
        {
          resourceId: "gid://shopify/Product/1",
          translations: [
            { key: "title", value: "Titre", outdated: false },
            { key: "body_html", value: "Description", outdated: true },
          ],
        },
        {
          resourceId: "gid://shopify/Product/2",
          translations: [{ key: "title", value: "Autre", outdated: false }],
        },
      ]),
    );
    const admin = makeAdmin(graphql);

    const summary = await fetchTranslationSummary(admin, "fr", "French", "PRODUCT");

    expect(summary.translatedCount).toBe(3);
    expect(summary.outdatedCount).toBe(1);
    expect(summary.locale).toBe("fr");
    expect(summary.localeName).toBe("French");
    expect(summary.resourceType).toBe("PRODUCT");
  });

  it("collects sample translations (up to 10)", async () => {
    const translations = Array.from({ length: 15 }, (_, i) => ({
      key: `key_${i}`,
      value: `value_${i}`,
      outdated: false,
    }));
    const graphql = vi
      .fn()
      .mockResolvedValue(
        makeTranslatableResourcesResponse([
          { resourceId: "gid://shopify/Product/1", translations },
        ]),
      );
    const admin = makeAdmin(graphql);

    const summary = await fetchTranslationSummary(admin, "fr", "French", "PRODUCT");

    expect(summary.sampleTranslations).toHaveLength(10);
  });

  it("handles empty translations", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue(
        makeTranslatableResourcesResponse([
          { resourceId: "gid://shopify/Product/1", translations: [] },
        ]),
      );
    const admin = makeAdmin(graphql);

    const summary = await fetchTranslationSummary(admin, "fr", "French", "PRODUCT");

    expect(summary.translatedCount).toBe(0);
    expect(summary.outdatedCount).toBe(0);
    expect(summary.sampleTranslations).toEqual([]);
  });

  it("throws on API errors", async () => {
    const graphql = vi.fn().mockResolvedValue(makeErrorResponse("Access denied"));
    const admin = makeAdmin(graphql);

    await expect(fetchTranslationSummary(admin, "fr", "French", "PRODUCT")).rejects.toThrow(
      "Failed to fetch translations for PRODUCT/fr",
    );
  });
});

// ---------------------------------------------------------------------------
// auditTranslations
// ---------------------------------------------------------------------------

describe("auditTranslations", () => {
  it("skips primary locale", async () => {
    const graphql = vi
      .fn()
      // First call: shopLocales (only primary locale)
      .mockResolvedValueOnce(
        makeLocalesResponse([{ locale: "en", name: "English", primary: true, published: true }]),
      );
    const admin = makeAdmin(graphql);

    const result = await auditTranslations(admin);

    expect(result.summaries).toEqual([]);
    expect(result.totalTranslations).toBe(0);
    // Should only have called graphql once (for locales)
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it("aggregates counts across resource types", async () => {
    const graphql = vi
      .fn()
      // First call: shopLocales
      .mockResolvedValueOnce(
        makeLocalesResponse([
          { locale: "en", name: "English", primary: true, published: true },
          { locale: "fr", name: "French", primary: false, published: true },
        ]),
      );

    // For each of the 5 resource types, return some translations
    for (let i = 0; i < 5; i++) {
      graphql.mockResolvedValueOnce(
        makeTranslatableResourcesResponse([
          {
            resourceId: `gid://shopify/Resource/${i}`,
            translations: [{ key: "title", value: `Titre ${i}`, outdated: i % 2 === 0 }],
          },
        ]),
      );
    }

    const admin = makeAdmin(graphql);

    const result = await auditTranslations(admin);

    expect(result.summaries).toHaveLength(5);
    expect(result.totalTranslations).toBe(5);
    expect(result.totalOutdated).toBe(3); // indices 0, 2, 4
  });

  it("excludes resource types with zero translations from summaries", async () => {
    const graphql = vi.fn().mockResolvedValueOnce(
      makeLocalesResponse([
        { locale: "en", name: "English", primary: true, published: true },
        { locale: "de", name: "German", primary: false, published: true },
      ]),
    );

    // First resource type has translations, rest are empty
    graphql.mockResolvedValueOnce(
      makeTranslatableResourcesResponse([
        {
          resourceId: "gid://shopify/Product/1",
          translations: [{ key: "title", value: "Produkt", outdated: false }],
        },
      ]),
    );
    for (let i = 0; i < 4; i++) {
      graphql.mockResolvedValueOnce(
        makeTranslatableResourcesResponse([
          { resourceId: `gid://shopify/Resource/${i}`, translations: [] },
        ]),
      );
    }

    const admin = makeAdmin(graphql);

    const result = await auditTranslations(admin);

    expect(result.summaries).toHaveLength(1);
    expect(result.totalTranslations).toBe(1);
  });
});

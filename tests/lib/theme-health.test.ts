/**
 * Tests for app/lib/theme-health.ts (gc-i6du): the checklist's category map
 * (exhaustive over FindingType), how a scan's coverage reads, the rows and
 * their copy. Pure.
 */
import { FindingType } from "@prisma/client";
import { describe, it, expect } from "vitest";

import {
  buildThemeHealthChecklist,
  coverageForType,
  HEALTH_CATEGORIES,
  HEALTH_CATEGORY_OF,
  type HealthCategoryKey,
  type HealthCoverageInput,
  healthCostLine,
  type HealthRow,
  MAX_NAMED_UNPUBLISHED_THEMES,
  THEME_LIBRARY_LIMIT,
  type ThemeHealthInput,
  themeTitle,
  typesForHealthCategory,
} from "../../app/lib/theme-health";

const ALL_TYPES = Object.values(FindingType);
const ALL_LIVE = new Set<string>(ALL_TYPES);

const FULL_COVERAGE: HealthCoverageInput = {
  skippedCategories: [],
  cappedCategories: [],
  unreachableCategories: [],
  liveTypes: ALL_LIVE,
  liveNow: ALL_LIVE,
  planWithheld: [],
  isPublishedTheme: true,
};

const DAWN = { name: "Dawn", version: "15.2.0", author: "Shopify", architecture: "os2" as const };

function input(overrides: Partial<ThemeHealthInput> = {}): ThemeHealthInput {
  return {
    scanId: "scan-1",
    typeCounts: {},
    coverage: FULL_COVERAGE,
    fullList: true,
    themeInfo: DAWN,
    scanThemeName: "Dawn - live",
    themes: null,
    scriptTagsStopped: false,
    ...overrides,
  };
}

const rowOf = (rows: HealthRow[], key: HealthRow["key"]) => rows.find((r) => r.key === key);

// ---------------------------------------------------------------------------
// The category map
// ---------------------------------------------------------------------------

describe("HEALTH_CATEGORY_OF: every FindingType lands in exactly one category", () => {
  const CATEGORY_KEYS = HEALTH_CATEGORIES.map((c) => c.key);

  it("maps every FindingType enum member (a new type must be placed here)", () => {
    for (const type of ALL_TYPES) {
      expect(HEALTH_CATEGORY_OF[type], `${type} has no theme health category`).toBeDefined();
      expect(CATEGORY_KEYS, `${type} maps to an unknown category`).toContain(
        HEALTH_CATEGORY_OF[type],
      );
    }
    // And nothing but enum members: no stale key for a removed type.
    expect(Object.keys(HEALTH_CATEGORY_OF).sort()).toEqual([...ALL_TYPES].sort());
  });

  it("the categories partition the enum: each type in one, none in two, none left out", () => {
    const seen: string[] = [];
    for (const key of CATEGORY_KEYS) seen.push(...typesForHealthCategory(key));
    expect(seen).toHaveLength(ALL_TYPES.length);
    expect(new Set(seen).size).toBe(ALL_TYPES.length);
  });

  it("every category has at least one type, a label and a 'what this checks' line", () => {
    expect(new Set(CATEGORY_KEYS).size).toBe(CATEGORY_KEYS.length);
    for (const category of HEALTH_CATEGORIES) {
      expect(typesForHealthCategory(category.key).length).toBeGreaterThan(0);
      expect(category.label.length).toBeGreaterThan(0);
      expect(category.checks.length).toBeGreaterThan(0);
    }
  });

  it("pins the placement of every type (a deliberate, reviewed call)", () => {
    const placed = Object.fromEntries(
      CATEGORY_KEYS.map((key) => [key, typesForHealthCategory(key).sort()]),
    );
    expect(placed).toEqual({
      malicious: ["MALICIOUS_SCRIPT"],
      // Its own row, so its status is never masked by theme-file checks.
      "liquid-errors": ["LIQUID_ERROR_RENDERED"],
      "shopper-visible": ["DANGLING_REFERENCE", "GHOST_TEXT", "OVERLAPPING_CHAT_WIDGET"],
      "scripts-styles": [
        "DUPLICATE_LIBRARY",
        "GHOST_AJAX",
        "GHOST_FONT",
        "GHOST_PRECONNECT",
        "GHOST_SCRIPT",
        "GHOST_STYLE",
      ],
      "snippets-sections": [
        "CHECKOUT_SUNSET",
        "GHOST_APP_EMBED",
        "GHOST_LAYOUT",
        "GHOST_SECTION",
        "GHOST_SNIPPET",
        "ORPHAN_ASSET",
        "SETTINGS_DRIFT",
      ],
      "seo-ai": [
        "DUPLICATE_META",
        "GHOST_CANONICAL",
        "GHOST_HREFLANG",
        "GHOST_JSON_LD",
        "GHOST_OG",
        "GHOST_ROBOTS",
        "GHOST_TITLE",
        "JSON_LD_CONFLICT",
        "JSON_LD_INVALID",
        "JSON_LD_PRICE_CONFLICT",
      ],
      tracking: ["DUPLICATE_TRACKER", "GHOST_PIXEL"],
      "store-data": [
        "GHOST_METAFIELD",
        "GHOST_PAGE",
        "GHOST_PRICE",
        "GHOST_REDIRECT",
        "GHOST_TAG",
        "GHOST_TRANSLATION",
      ],
      "script-tag-deadline": ["APP_EMBED_OFF", "SCRIPT_TAG_SUNSET"],
    });
  });

  it("a finding of ANY type is counted in exactly one row", () => {
    for (const type of ALL_TYPES) {
      const rows = buildThemeHealthChecklist(input({ typeCounts: { [type]: 2 } }));
      const counted = rows.filter((r) => r.count > 0);
      expect(
        counted.map((r) => r.key),
        type,
      ).toEqual([HEALTH_CATEGORY_OF[type]]);
      expect(counted[0].count).toBe(2);
    }
  });
});

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

describe("coverageForType", () => {
  it("checked by default", () => {
    expect(coverageForType("GHOST_SCRIPT", FULL_COVERAGE)).toBe("checked");
  });

  it.each([
    ["a missing permission", { skippedCategories: ["GHOST_TAG"] }, "GHOST_TAG", "permission"],
    ["a size cap", { cappedCategories: ["GHOST_REDIRECT"] }, "GHOST_REDIRECT", "capped"],
    [
      "an unreadable storefront",
      { unreachableCategories: ["LIQUID_ERROR_RENDERED"] },
      "LIQUID_ERROR_RENDERED",
      "unreachable",
    ],
    ["the plan", { planWithheld: ["DANGLING_REFERENCE"] }, "DANGLING_REFERENCE", "plan"],
  ] as const)("%s", (_name, overrides, type, expected) => {
    expect(coverageForType(type, { ...FULL_COVERAGE, ...overrides })).toBe(expected);
  });

  describe("a check that is on NOW but that the scan did not run is not_run, never checked", () => {
    const without = (...types: string[]) =>
      new Set(ALL_TYPES.filter((t) => !types.includes(t)) as string[]);

    it("the scan's live set lacks the type (a scan from before the check shipped)", () => {
      const scan = { ...FULL_COVERAGE, liveTypes: without("LIQUID_ERROR_RENDERED") };
      expect(coverageForType("LIQUID_ERROR_RENDERED", scan)).toBe("not_run");
      expect(coverageForType("GHOST_SCRIPT", scan)).toBe("checked");
    });

    it("the scan recorded no live set at all (legacy): every type is not_run", () => {
      const scan = { ...FULL_COVERAGE, liveTypes: null };
      expect(coverageForType("LIQUID_ERROR_RENDERED", scan)).toBe("not_run");
      expect(coverageForType("SCRIPT_TAG_SUNSET", scan)).toBe("not_run");
      expect(coverageForType("GHOST_SCRIPT", scan)).toBe("not_run");
    });

    it("the same rule for every type, not only Liquid errors", () => {
      const scan = { ...FULL_COVERAGE, liveTypes: without("SETTINGS_DRIFT", "SCRIPT_TAG_SUNSET") };
      expect(coverageForType("SETTINGS_DRIFT", scan)).toBe("not_run");
      expect(coverageForType("SCRIPT_TAG_SUNSET", scan)).toBe("not_run");
    });

    it("a check that is OFF for everyone now stays dark, whatever the scan recorded", () => {
      const off = {
        ...FULL_COVERAGE,
        liveNow: without("LIQUID_ERROR_RENDERED", "SCRIPT_TAG_SUNSET"),
      };
      // The scan ran it back when it was on, never ran it, or is legacy: dark.
      expect(coverageForType("LIQUID_ERROR_RENDERED", off)).toBe("dark");
      expect(
        coverageForType("LIQUID_ERROR_RENDERED", {
          ...off,
          liveTypes: without("LIQUID_ERROR_RENDERED"),
        }),
      ).toBe("dark");
      expect(coverageForType("SCRIPT_TAG_SUNSET", { ...off, liveTypes: null })).toBe("dark");
    });

    it("'unpublished' still wins for a storefront finding on a theme that is not published", () => {
      const other = {
        ...FULL_COVERAGE,
        liveTypes: without("LIQUID_ERROR_RENDERED", "SCRIPT_TAG_SUNSET"),
        isPublishedTheme: false,
      };
      expect(coverageForType("LIQUID_ERROR_RENDERED", other)).toBe("unpublished");
      expect(coverageForType("SCRIPT_TAG_SUNSET", other)).toBe("unpublished");
      // On the published theme, or when it is not known, it is simply not run.
      expect(coverageForType("LIQUID_ERROR_RENDERED", { ...other, isPublishedTheme: true })).toBe(
        "not_run",
      );
      expect(coverageForType("LIQUID_ERROR_RENDERED", { ...other, isPublishedTheme: null })).toBe(
        "not_run",
      );
      // A theme-file type is never "unpublished".
      expect(
        coverageForType("SETTINGS_DRIFT", { ...other, liveTypes: without("SETTINGS_DRIFT") }),
      ).toBe("not_run");
    });
  });

  it("the plan wins over everything; unreachable and permission win over the live set", () => {
    const base = {
      ...FULL_COVERAGE,
      planWithheld: ["DANGLING_REFERENCE"],
      skippedCategories: ["DANGLING_REFERENCE"],
      liveTypes: new Set<string>(),
    };
    expect(coverageForType("DANGLING_REFERENCE", base)).toBe("plan");
    expect(coverageForType("DANGLING_REFERENCE", { ...base, liveNow: new Set<string>() })).toBe(
      "plan",
    );
    expect(
      coverageForType("SCRIPT_TAG_SUNSET", {
        ...FULL_COVERAGE,
        unreachableCategories: ["SCRIPT_TAG_SUNSET"],
        liveTypes: new Set<string>(),
      }),
    ).toBe("unreachable");
  });
});

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

describe("buildThemeHealthChecklist: a clean, fully checked scan", () => {
  const rows = buildThemeHealthChecklist(input());

  it("lists the nine categories in order, then the theme row", () => {
    expect(rows.map((r) => r.key)).toEqual([
      "malicious",
      "liquid-errors",
      "shopper-visible",
      "scripts-styles",
      "snippets-sections",
      "seo-ai",
      "tracking",
      "store-data",
      "script-tag-deadline",
      "theme",
    ]);
  });

  it("every category reads Clean, with nothing to open and no cost line", () => {
    for (const row of rows.filter((r) => r.key !== "theme")) {
      expect(row).toMatchObject({
        status: "clean",
        statusLabel: "Clean",
        count: 0,
        detail: null,
        href: null,
      });
      expect(row.checks.length).toBeGreaterThan(0);
    }
  });
});

describe("buildThemeHealthChecklist: issues and their cost", () => {
  it("counts a category's types together and says '1 issue' / 'N issues'", () => {
    const rows = buildThemeHealthChecklist(
      input({ typeCounts: { GHOST_SCRIPT: 3, GHOST_STYLE: 1, GHOST_PIXEL: 1 } }),
    );
    expect(rowOf(rows, "scripts-styles")).toMatchObject({
      status: "issues",
      statusLabel: "4 issues",
      count: 4,
    });
    expect(rowOf(rows, "tracking")).toMatchObject({ statusLabel: "1 issue", count: 1 });
    expect(rowOf(rows, "seo-ai")).toMatchObject({ status: "clean" });
  });

  it("zero and undefined counts are not issues", () => {
    const rows = buildThemeHealthChecklist(input({ typeCounts: { GHOST_SCRIPT: 0 } }));
    expect(rowOf(rows, "scripts-styles")!.status).toBe("clean");
  });

  it.each<[HealthCategoryKey, Partial<Record<FindingType, number>>, string]>([
    [
      "malicious",
      { MALICIOUS_SCRIPT: 1 },
      "1 piece of code from a known malicious source is in your theme. It can steal shopper data or send your customers to other sites.",
    ],
    [
      "malicious",
      { MALICIOUS_SCRIPT: 2 },
      "2 pieces of code from a known malicious source are in your theme. It can steal shopper data or send your customers to other sites.",
    ],
    [
      "liquid-errors",
      { LIQUID_ERROR_RENDERED: 1 },
      "Your homepage prints 1 Liquid error because your theme renders a snippet that no longer exists. It can be inside a menu or a hidden section.",
    ],
    [
      "liquid-errors",
      { LIQUID_ERROR_RENDERED: 3 },
      "Your homepage prints 3 Liquid errors because your theme renders snippets that no longer exist. They can be inside a menu or a hidden section.",
    ],
    [
      "shopper-visible",
      { DANGLING_REFERENCE: 3, GHOST_TEXT: 1, OVERLAPPING_CHAT_WIDGET: 1 },
      "3 broken links, 1 piece of leftover app text and more than one chat widget loading at once.",
    ],
    [
      "shopper-visible",
      { OVERLAPPING_CHAT_WIDGET: 1 },
      "More than one chat widget loading at once.",
    ],
    [
      "scripts-styles",
      {
        GHOST_SCRIPT: 3,
        GHOST_STYLE: 1,
        GHOST_FONT: 1,
        GHOST_AJAX: 1,
        GHOST_PRECONNECT: 2,
        DUPLICATE_LIBRARY: 1,
      },
      "6 extra requests to apps you removed, on every page that loads them, 2 wasted connection hints and 1 library loaded more than once.",
    ],
    [
      "scripts-styles",
      { GHOST_SCRIPT: 1 },
      "1 extra request to apps you removed, on every page that loads it.",
    ],
    [
      "snippets-sections",
      { GHOST_SNIPPET: 2, ORPHAN_ASSET: 3, SETTINGS_DRIFT: 1, CHECKOUT_SUNSET: 1 },
      "5 leftover snippets, sections and files in your theme code, 1 leftover theme setting and a checkout.liquid file Shopify no longer runs.",
    ],
    ["snippets-sections", { CHECKOUT_SUNSET: 1 }, "A checkout.liquid file Shopify no longer runs."],
    [
      "seo-ai",
      { GHOST_CANONICAL: 1, DUPLICATE_META: 4 },
      "5 tags give Google and AI assistants wrong or conflicting information about your store.",
    ],
    [
      "seo-ai",
      { GHOST_ROBOTS: 1 },
      "1 tag gives Google and AI assistants wrong or conflicting information about your store.",
    ],
    [
      "tracking",
      { GHOST_PIXEL: 2, DUPLICATE_TRACKER: 1 },
      "2 tracking pixels that may still send shopper data to apps you removed and 1 tracker set up twice.",
    ],
    [
      "store-data",
      { GHOST_TAG: 40, GHOST_METAFIELD: 172 },
      "212 leftover records in your products, pages, redirects and translations.",
    ],
  ])("%s %j", (category, counts, expected) => {
    expect(healthCostLine(category, counts, { scriptTagsStopped: false })).toBe(expected);
    const row = rowOf(buildThemeHealthChecklist(input({ typeCounts: counts })), category)!;
    expect(row.detail).toBe(expected);
  });

  it("the script tag deadline line follows the date", () => {
    const counts = { SCRIPT_TAG_SUNSET: 2, APP_EMBED_OFF: 1 };
    expect(healthCostLine("script-tag-deadline", counts, { scriptTagsStopped: false })).toBe(
      "2 apps still load through script tags and 1 app embed is turned off. Shopify stops running script tags on March 1, 2027.",
    );
    expect(healthCostLine("script-tag-deadline", counts, { scriptTagsStopped: true })).toBe(
      "2 apps still load through script tags and 1 app embed is turned off. Shopify stopped running script tags on March 1, 2027.",
    );
    const after = buildThemeHealthChecklist(
      input({ typeCounts: { SCRIPT_TAG_SUNSET: 1 }, scriptTagsStopped: true }),
    );
    expect(rowOf(after, "script-tag-deadline")!.detail).toBe(
      "1 app still loads through script tags. Shopify stopped running script tags on March 1, 2027.",
    );
  });

  it("links to the type-filtered list when the row is ONE type on a full-list plan", () => {
    const rows = buildThemeHealthChecklist(input({ typeCounts: { GHOST_PIXEL: 2 } }));
    expect(rowOf(rows, "tracking")!.href).toBe("/app/scans/scan-1?type=GHOST_PIXEL");
  });

  it("links to the scan page when the row mixes types, or on Free, or for malicious code", () => {
    const mixed = buildThemeHealthChecklist(
      input({ typeCounts: { GHOST_PIXEL: 2, DUPLICATE_TRACKER: 1 } }),
    );
    expect(rowOf(mixed, "tracking")!.href).toBe("/app/scans/scan-1");
    const free = buildThemeHealthChecklist(
      input({ typeCounts: { GHOST_PIXEL: 2 }, fullList: false }),
    );
    expect(rowOf(free, "tracking")!.href).toBe("/app/scans/scan-1");
    const malicious = buildThemeHealthChecklist(input({ typeCounts: { MALICIOUS_SCRIPT: 1 } }));
    expect(rowOf(malicious, "malicious")!.href).toBe("/app/scans/scan-1");
  });
});

describe("buildThemeHealthChecklist: never 'Clean' about something nobody checked", () => {
  it("storefront unreadable: the Liquid errors row is Not checked; the deadline row is None found", () => {
    const rows = buildThemeHealthChecklist(
      input({
        coverage: {
          ...FULL_COVERAGE,
          unreachableCategories: ["SCRIPT_TAG_SUNSET", "LIQUID_ERROR_RENDERED"],
        },
      }),
    );
    const reason =
      "Your storefront homepage couldn't be read, for example because it has a password, so this wasn't checked.";
    expect(rowOf(rows, "liquid-errors")).toMatchObject({
      status: "not_checked",
      statusLabel: "Not checked",
      detail: reason,
    });
    // APP_EMBED_OFF was still checked, so the deadline row is only partly unchecked.
    expect(rowOf(rows, "script-tag-deadline")).toMatchObject({
      status: "partial",
      statusLabel: "None found",
      detail: reason,
    });
    // The theme-file row next to it is unaffected.
    expect(rowOf(rows, "shopper-visible")).toMatchObject({ status: "clean" });
  });

  describe("a scan that did not run a check that is on now (HIGH audit finding)", () => {
    const without = (...types: string[]) =>
      new Set(ALL_TYPES.filter((t) => !types.includes(t)) as string[]);
    const NOT_RUN = "This wasn't checked on your last scan. Run a new scan.";

    it("the scan's live set lacks Liquid errors (a pre-deploy scan): NOT clean, with what to do", () => {
      const rows = buildThemeHealthChecklist(
        input({ coverage: { ...FULL_COVERAGE, liveTypes: without("LIQUID_ERROR_RENDERED") } }),
      );
      const row = rowOf(rows, "liquid-errors")!;
      expect(row.status).not.toBe("clean");
      expect(row).toMatchObject({
        status: "not_checked",
        statusLabel: "Not checked",
        detail: NOT_RUN,
        count: 0,
        href: null,
      });
      // Its neighbour is not dragged down, and it does not mask this row.
      expect(rowOf(rows, "shopper-visible")).toMatchObject({ status: "clean" });
    });

    it("the scan recorded no live set (legacy): no row is clean", () => {
      const rows = buildThemeHealthChecklist(
        input({ coverage: { ...FULL_COVERAGE, liveTypes: null } }),
      );
      const categories = rows.filter((r) => r.key !== "theme");
      expect(categories).toHaveLength(9);
      for (const row of categories) {
        expect(row.status, row.key).toBe("not_checked");
        expect(row.detail, row.key).toBe(NOT_RUN);
      }
    });

    it("the same rule for the script tag deadline row", () => {
      const rows = buildThemeHealthChecklist(
        input({
          coverage: { ...FULL_COVERAGE, liveTypes: without("SCRIPT_TAG_SUNSET", "APP_EMBED_OFF") },
        }),
      );
      expect(rowOf(rows, "script-tag-deadline")).toMatchObject({
        status: "not_checked",
        detail: NOT_RUN,
      });
    });

    it("only part of a row was not run: None found, and it says part", () => {
      const rows = buildThemeHealthChecklist(
        input({ coverage: { ...FULL_COVERAGE, liveTypes: without("SETTINGS_DRIFT") } }),
      );
      expect(rowOf(rows, "snippets-sections")).toMatchObject({
        status: "partial",
        statusLabel: "None found",
        detail: "Part of this wasn't checked on your last scan. Run a new scan.",
      });
    });

    it("the check is off for everyone NOW: dark, so the row is left out rather than 'Not checked'", () => {
      const rows = buildThemeHealthChecklist(
        input({
          coverage: {
            ...FULL_COVERAGE,
            liveNow: without("LIQUID_ERROR_RENDERED"),
            liveTypes: without("LIQUID_ERROR_RENDERED"),
          },
        }),
      );
      expect(rowOf(rows, "liquid-errors")).toBeUndefined();
    });

    it("findings recorded by the scan still show, even if the type is not in its live set", () => {
      const rows = buildThemeHealthChecklist(
        input({
          typeCounts: { LIQUID_ERROR_RENDERED: 1 },
          coverage: { ...FULL_COVERAGE, liveTypes: without("LIQUID_ERROR_RENDERED") },
        }),
      );
      expect(rowOf(rows, "liquid-errors")).toMatchObject({
        status: "issues",
        statusLabel: "1 issue",
      });
    });
  });

  it("every type of a row un-checked: Not checked, with the reason", () => {
    const rows = buildThemeHealthChecklist(
      input({
        coverage: {
          ...FULL_COVERAGE,
          skippedCategories: typesForHealthCategory("store-data"),
        },
      }),
    );
    expect(rowOf(rows, "store-data")).toMatchObject({
      status: "not_checked",
      statusLabel: "Not checked",
      detail:
        "Part of this needs a permission you haven't allowed yet. You can allow it in Settings.",
    });
  });

  it("one permission missing: None found, not Clean", () => {
    const rows = buildThemeHealthChecklist(
      input({ coverage: { ...FULL_COVERAGE, skippedCategories: ["GHOST_TRANSLATION"] } }),
    );
    expect(rowOf(rows, "store-data")).toMatchObject({
      status: "partial",
      statusLabel: "None found",
    });
  });

  it("Free: broken links and old checkout code are named as Standard checks", () => {
    const rows = buildThemeHealthChecklist(
      input({
        fullList: false,
        coverage: { ...FULL_COVERAGE, planWithheld: ["DANGLING_REFERENCE", "CHECKOUT_SUNSET"] },
      }),
    );
    expect(rowOf(rows, "shopper-visible")).toMatchObject({
      status: "partial",
      detail: "Broken links are checked on Standard and Professional.",
    });
    expect(rowOf(rows, "snippets-sections")).toMatchObject({
      status: "partial",
      detail: "Old checkout code is checked on Standard and Professional.",
    });
  });

  it("a size cap: None found, with the cap as the reason", () => {
    const rows = buildThemeHealthChecklist(
      input({ coverage: { ...FULL_COVERAGE, cappedCategories: ["GHOST_REDIRECT"] } }),
    );
    expect(rowOf(rows, "store-data")!.detail).toBe(
      "Your store has more of these than one scan checks, so part of this wasn't checked.",
    );
  });

  it("a scan of another theme: storefront checks say they only run on the published theme", () => {
    const liveTypes = new Set(
      ALL_TYPES.filter(
        (t) => t !== "SCRIPT_TAG_SUNSET" && t !== "LIQUID_ERROR_RENDERED",
      ) as string[],
    );
    const rows = buildThemeHealthChecklist(
      input({ coverage: { ...FULL_COVERAGE, liveTypes, isPublishedTheme: false } }),
    );
    expect(rowOf(rows, "liquid-errors")).toMatchObject({
      status: "not_checked",
      detail: "This is only checked on your published theme.",
    });
    // APP_EMBED_OFF is a theme-file check and did run.
    expect(rowOf(rows, "script-tag-deadline")).toMatchObject({
      status: "partial",
      detail: "This is only checked on your published theme.",
    });
  });

  it("findings win over a gap: the row shows the issues and their cost", () => {
    const rows = buildThemeHealthChecklist(
      input({
        typeCounts: { GHOST_TAG: 3 },
        coverage: { ...FULL_COVERAGE, skippedCategories: ["GHOST_TRANSLATION"] },
      }),
    );
    expect(rowOf(rows, "store-data")).toMatchObject({ status: "issues", statusLabel: "3 issues" });
  });
});

describe("buildThemeHealthChecklist: checks that are off for everyone are left out", () => {
  const offNow = new Set(
    ALL_TYPES.filter(
      (t) =>
        t !== "SCRIPT_TAG_SUNSET" &&
        t !== "LIQUID_ERROR_RENDERED" &&
        t !== "APP_EMBED_OFF" &&
        t !== "SETTINGS_DRIFT",
    ) as string[],
  );
  const coverage = { ...FULL_COVERAGE, liveNow: offNow, liveTypes: offNow };

  it("a row whose every type is dark does not appear at all", () => {
    const rows = buildThemeHealthChecklist(input({ coverage }));
    expect(rowOf(rows, "script-tag-deadline")).toBeUndefined();
    expect(rowOf(rows, "liquid-errors")).toBeUndefined();
  });

  it("a dark type does not stop the rest of its row reading Clean", () => {
    const rows = buildThemeHealthChecklist(input({ coverage }));
    // SETTINGS_DRIFT is dark; the other snippets-and-sections checks ran.
    expect(rowOf(rows, "snippets-sections")).toMatchObject({ status: "clean", detail: null });
  });
});

// ---------------------------------------------------------------------------
// Theme row
// ---------------------------------------------------------------------------

describe("theme type and version row", () => {
  const theme = (overrides: Partial<ThemeHealthInput>) =>
    rowOf(buildThemeHealthChecklist(input(overrides)), "theme")!;

  it("Online Store 2.0: shown as info even when everything is clean", () => {
    expect(theme({})).toMatchObject({
      label: "Theme type and version",
      status: "clean",
      statusLabel: "Online Store 2.0",
      detail: "Dawn 15.2.0 by Shopify",
      count: 0,
      href: null,
    });
  });

  it("vintage: flagged, with what it costs", () => {
    expect(
      theme({
        themeInfo: { name: "Debut", version: "17.14.0", author: null, architecture: "vintage" },
      }),
    ).toMatchObject({
      status: "issues",
      statusLabel: "Vintage theme",
      count: 0,
      // App embeds DO work on a vintage theme; app blocks do not.
      detail:
        "Debut 17.14.0 is a vintage theme, not Online Store 2.0. It can't use app blocks, so an app that adds something to a page has to write its code into your theme files, and that code stays there when you remove the app. App embeds still work on it.",
    });
  });

  it("no name in settings_schema.json: falls back to the theme's name in the store", () => {
    const info = { name: null, version: null, author: null, architecture: "os2" as const };
    expect(theme({ themeInfo: info }).detail).toBe("Dawn - live");
    expect(themeTitle({ ...info, version: "2.0" }, "My theme")).toBe("My theme 2.0");
  });

  it("type not detected: says so, claims nothing", () => {
    expect(theme({ themeInfo: { ...DAWN, architecture: "unknown" } })).toMatchObject({
      status: "info",
      statusLabel: "Type not detected",
    });
  });

  it("a legacy scan with no theme info: Not checked, with what to do", () => {
    expect(theme({ themeInfo: null })).toMatchObject({
      status: "not_checked",
      statusLabel: "Not checked",
      detail: "Run a new scan to see your theme's name, version and type.",
    });
  });

  it("a vintage theme is never counted as a finding", () => {
    const rows = buildThemeHealthChecklist(
      input({ themeInfo: { ...DAWN, architecture: "vintage" } }),
    );
    expect(rows.reduce((sum, r) => sum + r.count, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Unpublished themes row
// ---------------------------------------------------------------------------

describe("unpublished themes row", () => {
  const t = (id: string, role: string, lastScanFindingCount: number | null = null) => ({
    id,
    name: `Theme ${id}`,
    role,
    lastScanFindingCount,
  });
  const unpublished = (themes: ThemeHealthInput["themes"]) =>
    rowOf(buildThemeHealthChecklist(input({ themes })), "unpublished-themes");

  it("no theme list: no row (nothing is guessed)", () => {
    expect(unpublished(null)).toBeUndefined();
    expect(unpublished([])).toBeUndefined();
  });

  it("counts unpublished themes, with the store limit as context", () => {
    expect(unpublished([t("1", "MAIN"), t("2", "UNPUBLISHED"), t("3", "UNPUBLISHED")])).toEqual({
      key: "unpublished-themes",
      label: "Unpublished themes",
      checks: "Themes in your library that shoppers don't see.",
      status: "info",
      statusLabel: "2 unpublished",
      count: 0,
      detail: `Your store has 3 themes. Shopify allows ${THEME_LIBRARY_LIMIT} (more on Plus).`,
      href: null,
    });
  });

  it("only the published theme: None", () => {
    expect(unpublished([t("1", "MAIN")])).toMatchObject({
      statusLabel: "None",
      detail: "Your store has 1 theme. Shopify allows 20 (more on Plus).",
    });
  });

  it("development themes are not part of the library", () => {
    const row = unpublished([t("1", "MAIN"), t("2", "DEVELOPMENT"), t("3", "DEMO")])!;
    expect(row.statusLabel).toBe("1 unpublished");
    expect(row.detail).toContain("Your store has 2 themes.");
  });

  it("themes that have a scan show their leftover counts, most first", () => {
    const row = unpublished([
      t("1", "MAIN", 99),
      t("2", "UNPUBLISHED", 4),
      t("3", "UNPUBLISHED", 12),
      t("4", "UNPUBLISHED"),
      t("5", "UNPUBLISHED", 0),
    ])!;
    expect(row.detail).toBe(
      "Your store has 5 themes. Shopify allows 20 (more on Plus). In their last scans: Theme 3: 12 findings; Theme 2: 4 findings; Theme 5: 0 findings.",
    );
    // The published theme's count is the checklist itself, never repeated here.
    expect(row.detail).not.toContain("99");
  });

  it(`names at most ${MAX_NAMED_UNPUBLISHED_THEMES} scanned themes, then 'and N more'`, () => {
    const themes = [t("0", "MAIN"), ...[5, 4, 3, 2, 1].map((n) => t(String(n), "UNPUBLISHED", n))];
    expect(unpublished(themes)!.detail).toMatch(
      /Theme 5: 5 findings; Theme 4: 4 findings; Theme 3: 3 findings; and 2 more\.$/,
    );
  });

  it("singular: 1 finding", () => {
    expect(unpublished([t("1", "MAIN"), t("2", "UNPUBLISHED", 1)])!.detail).toContain(
      "Theme 2: 1 finding.",
    );
  });

  it("is never an issue, whatever the size of the library", () => {
    const many = [
      t("0", "MAIN"),
      ...Array.from({ length: 30 }, (_, i) => t(`u${i}`, "UNPUBLISHED")),
    ];
    expect(unpublished(many)).toMatchObject({ status: "info", statusLabel: "30 unpublished" });
  });
});

// ---------------------------------------------------------------------------
// No score; no gated detail
// ---------------------------------------------------------------------------

describe("the checklist is a plain list", () => {
  const BUSY: Partial<Record<FindingType, number>> = Object.fromEntries(
    ALL_TYPES.map((t, i) => [t, i + 1]),
  );
  const scenarios: Array<[string, ThemeHealthInput]> = [
    ["clean", input()],
    ["every type has findings", input({ typeCounts: BUSY })],
    ["Free", input({ typeCounts: BUSY, fullList: false })],
    [
      "vintage with unpublished themes",
      input({
        themeInfo: { ...DAWN, architecture: "vintage" },
        themes: [
          { id: "1", name: "Live", role: "MAIN", lastScanFindingCount: null },
          { id: "2", name: "Old", role: "UNPUBLISHED", lastScanFindingCount: 7 },
        ],
      }),
    ],
  ];

  it.each(scenarios)("%s: no score, grade, percentage or 'x of y'", (_name, scenario) => {
    const text = JSON.stringify(buildThemeHealthChecklist(scenario));
    expect(text).not.toMatch(/%|\bscore\b|\bgrade\b|out of|\/\s*100|\b\d+ of \d+\b|health score/i);
  });

  it("no em dashes in any copy", () => {
    for (const [, scenario] of scenarios) {
      expect(JSON.stringify(buildThemeHealthChecklist(scenario))).not.toContain("—");
    }
    expect(JSON.stringify(HEALTH_CATEGORIES)).not.toContain("—");
  });

  it("rows carry counts and fixed copy only: the input has no file, snippet or app to leak", () => {
    const rows = buildThemeHealthChecklist(input({ typeCounts: BUSY, fullList: false }));
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        ["checks", "count", "detail", "href", "key", "label", "status", "statusLabel"].sort(),
      );
    }
  });

  it("Free and paid get the same rows; only the link target differs", () => {
    const strip = (rows: HealthRow[]) => rows.map((row) => ({ ...row, href: null }));
    const paid = buildThemeHealthChecklist(input({ typeCounts: BUSY }));
    const free = buildThemeHealthChecklist(input({ typeCounts: BUSY, fullList: false }));
    expect(strip(free)).toEqual(strip(paid));
    for (const row of free) {
      if (row.href) expect(row.href).toBe("/app/scans/scan-1");
    }
  });
});

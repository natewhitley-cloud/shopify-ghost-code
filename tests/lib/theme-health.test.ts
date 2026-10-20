/**
 * Tests for app/lib/theme-health.ts (gc-i6du): the checklist's category map
 * (exhaustive over FindingType), how a scan's coverage reads, the rows and
 * their copy. Pure.
 */
import { FindingType } from "@prisma/client";
import { describe, it, expect } from "vitest";

import {
  ADVISORY_HEALTH_LABEL,
  advisoryHealthRow,
  buildThemeHealthChecklist,
  coverageForType,
  HEALTH_CATEGORIES,
  HEALTH_CATEGORY_OF,
  type HealthCategoryKey,
  type HealthCoverageInput,
  groupGapsByReason,
  groupHealthRows,
  healthCostLine,
  maliciousHealthRow,
  type HealthRow,
  MAX_NAMED_UNPUBLISHED_THEMES,
  THEME_LIBRARY_LIMIT,
  type ThemeHealthInput,
  themeHealthVerdict,
  themeTitle,
  typesForHealthCategory,
  VERDICT_ADVISORY,
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

  // gc-14x5: an affected-app advisory is deliberately in NO category (it is a
  // notice, not something wrong in the theme). Every other type must be placed.
  const HEALTH_TYPES = ALL_TYPES.filter(
    (t): t is Exclude<FindingType, "APP_INCIDENT_ADVISORY"> => t !== "APP_INCIDENT_ADVISORY",
  );

  it("maps every FindingType enum member but the advisory (a new type must be placed here)", () => {
    for (const type of HEALTH_TYPES) {
      expect(HEALTH_CATEGORY_OF[type], `${type} has no theme health category`).toBeDefined();
      expect(CATEGORY_KEYS, `${type} maps to an unknown category`).toContain(
        HEALTH_CATEGORY_OF[type],
      );
    }
    // And nothing but enum members: no stale key for a removed type.
    expect(Object.keys(HEALTH_CATEGORY_OF).sort()).toEqual([...HEALTH_TYPES].sort());
  });

  it("the categories partition the enum: each type in one, none in two, none left out", () => {
    const seen: string[] = [];
    for (const key of CATEGORY_KEYS) seen.push(...typesForHealthCategory(key));
    expect(seen).toHaveLength(HEALTH_TYPES.length);
    expect(new Set(seen).size).toBe(HEALTH_TYPES.length);
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

  it("a finding of ANY type (but the advisory, which is in no row) is counted in exactly one row", () => {
    for (const type of HEALTH_TYPES) {
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
      "We couldn't read your storefront homepage, for example because it has a password. Run a new scan once the homepage can be read.";
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
    const NOT_RUN = "Not checked on your last scan. Run a new scan to try again.";

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
        detail: "Partly checked on your last scan. Run a new scan to try again.",
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
      detail: "Needs a permission you haven't allowed yet. You can allow it in Settings.",
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

  it("any other plan-gated check: the generic sentence, with no 'this' (it sits under several names)", () => {
    const rows = buildThemeHealthChecklist(
      input({ coverage: { ...FULL_COVERAGE, planWithheld: ["DUPLICATE_TRACKER"] } }),
    );
    expect(rowOf(rows, "tracking")).toMatchObject({
      status: "partial",
      detail: "Checked in full on Standard and Professional.",
    });
  });

  it("a size cap: None found, with the cap as the reason", () => {
    const rows = buildThemeHealthChecklist(
      input({ coverage: { ...FULL_COVERAGE, cappedCategories: ["GHOST_REDIRECT"] } }),
    );
    expect(rowOf(rows, "store-data")!.detail).toBe(
      "Your store has more of these than one scan checks, so part wasn't checked.",
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
      detail: "Only checked on your published theme.",
    });
    // APP_EMBED_OFF is a theme-file check and did run.
    expect(rowOf(rows, "script-tag-deadline")).toMatchObject({
      status: "partial",
      detail: "Only checked on your published theme.",
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

// ---------------------------------------------------------------------------
// End to end: the real checklist through the real grouping
// ---------------------------------------------------------------------------

describe("buildThemeHealthChecklist -> groupHealthRows", () => {
  const t = (id: string, role: string) => ({
    id,
    name: `Theme ${id}`,
    role,
    lastScanFindingCount: null,
  });
  const THEMES = [t("1", "MAIN"), t("2", "UNPUBLISHED")];
  const CATEGORY_KEYS = HEALTH_CATEGORIES.map((c) => c.key as string);
  const keys = (rows: readonly HealthRow[]) => rows.map((r) => r.key as string);

  it("a fully checked scan with no findings: all nine categories are clean, malicious included", () => {
    const rows = buildThemeHealthChecklist(input({ themes: THEMES }));
    const { theme, unpublished, clean, gaps, hasIssues } = groupHealthRows(rows);

    expect(keys(clean)).toEqual(CATEGORY_KEYS);
    for (const row of clean) expect(row.status, row.key).toBe("clean");
    expect(clean.map((r) => r.label).join(", ")).not.toMatch(/\d/);
    expect(gaps).toEqual([]);
    expect(hasIssues).toBe(false);
    expect(theme).toBe(rowOf(rows, "theme"));
    expect(theme).toMatchObject({
      detail: "Dawn 15.2.0 by Shopify",
      statusLabel: "Online Store 2.0",
    });
    expect(unpublished).toBe(rowOf(rows, "unpublished-themes"));
    // Every row is in exactly one group.
    expect(clean.length + gaps.length + 2).toBe(rows.length);
  });

  const without = (...types: string[]) =>
    new Set(ALL_TYPES.filter((t) => !types.includes(t)) as string[]);

  it.each<[string, Partial<HealthCoverageInput>, string[], boolean]>([
    ["a size cap", { cappedCategories: ["GHOST_REDIRECT"] }, ["store-data"], true],
    [
      "storefront unreadable",
      { unreachableCategories: ["SCRIPT_TAG_SUNSET", "LIQUID_ERROR_RENDERED"] },
      ["liquid-errors", "script-tag-deadline"],
      true,
    ],
    [
      "a check the scan did not run",
      { liveTypes: without("LIQUID_ERROR_RENDERED") },
      ["liquid-errors"],
      false,
    ],
    ["a missing permission", { skippedCategories: ["GHOST_TRANSLATION"] }, ["store-data"], true],
    ["no live set recorded (legacy)", { liveTypes: null }, CATEGORY_KEYS, false],
  ])("%s: every name under Clean is a clean row", (_name, coverage, unchecked, partial) => {
    const rows = buildThemeHealthChecklist(
      input({ themes: THEMES, coverage: { ...FULL_COVERAGE, ...coverage } }),
    );
    const { theme, unpublished, clean, gaps, hasIssues } = groupHealthRows(rows);

    for (const row of clean) {
      expect(row.status, row.key).toBe("clean");
      expect(row.detail, row.key).toBeNull();
    }
    // The rows the gap touches are not clean: each is a gap, with its reason.
    for (const key of unchecked) {
      const row = rowOf(rows, key as HealthRow["key"])!;
      expect(row.status, key).not.toBe("clean");
      expect(gaps, key).toContain(row);
      expect(row.detail, key).toEqual(expect.any(String));
      expect(keys(clean)).not.toContain(key);
    }
    // No findings here, so the gaps are exactly the categories that are not clean.
    expect(gaps).toEqual(rows.filter((r) => CATEGORY_KEYS.includes(r.key) && r.status !== "clean"));
    expect(keys(gaps)).toEqual(unchecked);
    for (const row of gaps) expect(["partial", "not_checked"], row.key).toContain(row.status);
    expect(gaps.some((r) => r.status === "partial")).toBe(partial);
    // A gap is not a finding.
    expect(hasIssues).toBe(false);
    expect(theme).toBe(rowOf(rows, "theme"));
    expect(unpublished).toBe(rowOf(rows, "unpublished-themes"));
    expect(clean.length + gaps.length + 2).toBe(rows.length);
  });

  it("findings in every category: nothing is clean or a gap; the vintage theme fact stays", () => {
    const rows = buildThemeHealthChecklist(
      input({
        typeCounts: Object.fromEntries(ALL_TYPES.map((type, i) => [type, i + 1])),
        themeInfo: { ...DAWN, architecture: "vintage" },
        themes: THEMES,
      }),
    );
    const groups = groupHealthRows(rows);
    expect(groups.clean).toEqual([]);
    expect(groups.gaps).toEqual([]);
    expect(groups.hasIssues).toBe(true);
    expect(groups.theme).toMatchObject({ status: "issues", statusLabel: "Vintage theme" });
    expect(groups.unpublished).toBe(rowOf(rows, "unpublished-themes"));
  });

  it("a legacy scan with no theme info: the theme row is the theme, not a gap", () => {
    const rows = buildThemeHealthChecklist(input({ themeInfo: null }));
    const groups = groupHealthRows(rows);
    expect(groups.theme).toMatchObject({ key: "theme", status: "not_checked" });
    expect(groups.unpublished).toBeNull();
    expect(keys(groups.gaps)).not.toContain("theme");
    expect(keys(groups.clean)).toEqual(CATEGORY_KEYS);
  });
});

describe("maliciousHealthRow + groupHealthRows(rows, malicious)", () => {
  const CATEGORY_KEYS = HEALTH_CATEGORIES.map((c) => c.key as string);
  const keys = (rows: readonly HealthRow[]) => rows.map((r) => r.key as string);

  it("is null for no findings and the builder's own malicious row otherwise, on every plan", () => {
    expect(maliciousHealthRow("scan-1", 0)).toBeNull();
    expect(maliciousHealthRow("scan-1", -1)).toBeNull();
    for (const count of [1, 2, 7]) {
      for (const fullList of [false, true]) {
        const rows = buildThemeHealthChecklist(
          input({ typeCounts: { MALICIOUS_SCRIPT: count }, fullList }),
        );
        expect(maliciousHealthRow("scan-1", count)).toEqual(rowOf(rows, "malicious"));
      }
    }
  });

  it("the given malicious row is the malicious group even with no rows at all", () => {
    const malicious = maliciousHealthRow("scan-1", 2)!;
    const groups = groupHealthRows([], malicious);
    expect(groups.malicious).toBe(malicious);
    expect(groups.clean).toEqual([]);
  });

  it("never names malicious under clean when a malicious row is given, and keeps the other clean rows", () => {
    // Rows built from counts that excluded the (ignored) malicious findings.
    const rows = buildThemeHealthChecklist(input());
    expect(keys(groupHealthRows(rows).clean)).toContain("malicious");
    const malicious = maliciousHealthRow("scan-1", 1)!;
    const groups = groupHealthRows(rows, malicious);
    expect(groups.malicious).toBe(malicious);
    expect(keys(groups.clean)).toEqual(CATEGORY_KEYS.filter((k) => k !== "malicious"));
  });

  it("no malicious row given: behaves exactly as before", () => {
    const rows = buildThemeHealthChecklist(input());
    expect(groupHealthRows(rows, null)).toEqual(groupHealthRows(rows));
    expect(groupHealthRows(rows).malicious).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Home's verdict line and action box
// ---------------------------------------------------------------------------

describe("gap reason copy: fits one check or several, and ends with the action", () => {
  const without = (...types: string[]) =>
    new Set(ALL_TYPES.filter((t) => !types.includes(t)) as string[]);

  /** Every gap sentence the builder can emit, from a real build of each gap. */
  const everyGapSentence = (): string[] => {
    const coverages: Array<Partial<HealthCoverageInput>> = [
      { unreachableCategories: ["SCRIPT_TAG_SUNSET", "LIQUID_ERROR_RENDERED"] },
      { liveTypes: null },
      { liveTypes: without("SETTINGS_DRIFT") },
      { skippedCategories: ["GHOST_TRANSLATION"] },
      { planWithheld: ["DANGLING_REFERENCE", "CHECKOUT_SUNSET", "DUPLICATE_TRACKER"] },
      { liveTypes: without("LIQUID_ERROR_RENDERED"), isPublishedTheme: false },
      { cappedCategories: ["GHOST_REDIRECT"] },
      { cappedCategories: ["LIQUID_ERROR_RENDERED"] },
    ];
    const sentences = coverages.flatMap((coverage) =>
      groupHealthRows(
        buildThemeHealthChecklist(input({ coverage: { ...FULL_COVERAGE, ...coverage } })),
      ).gaps.map((row) => row.detail!),
    );
    return [...new Set(sentences)];
  };

  it("the exact sentences", () => {
    expect(everyGapSentence().sort()).toEqual(
      [
        "We couldn't read your storefront homepage, for example because it has a password. Run a new scan once the homepage can be read.",
        "Not checked on your last scan. Run a new scan to try again.",
        "Partly checked on your last scan. Run a new scan to try again.",
        "Needs a permission you haven't allowed yet. You can allow it in Settings.",
        "Broken links are checked on Standard and Professional.",
        "Old checkout code is checked on Standard and Professional.",
        "Checked in full on Standard and Professional.",
        "Only checked on your published theme.",
        "Your store has more of these than one scan checks, so part wasn't checked.",
        "Your theme is missing more snippets than one scan checks, so part wasn't checked.",
      ].sort(),
    );
  });

  it("no sentence points at one row ('this'), and none has an em dash or a digit", () => {
    for (const sentence of everyGapSentence()) {
      expect(sentence, sentence).not.toMatch(/\bthis\b/i);
      expect(sentence, sentence).not.toMatch(/\u2014|\d/);
    }
  });
});

describe("themeHealthVerdict", () => {
  const cat = (key: HealthRow["key"], status: HealthRow["status"]): HealthRow => ({
    key,
    label: HEALTH_CATEGORIES.find((c) => c.key === key)?.label ?? String(key),
    checks: "",
    status,
    statusLabel: status,
    count: status === "issues" ? 2 : 0,
    detail: status === "clean" ? null : "Why.",
    href: null,
  });
  const verdict = (rows: HealthRow[], malicious: HealthRow | null = null) =>
    themeHealthVerdict(groupHealthRows(rows, malicious));

  const CLEAN = "No known malicious code found.";
  const UNCHECKED = "Some checks couldn't run, including the check for malicious code.";
  const GAPS = "No known malicious code found. Some checks couldn't run.";
  const PARTIAL = "No known malicious code found. Some checks only partly ran.";

  it("malicious clean, no gaps, nothing found: green, 'No known malicious code found.'", () => {
    expect(verdict([cat("malicious", "clean"), cat("tracking", "clean")])).toEqual({
      tone: "ok",
      text: CLEAN,
    });
    expect(verdict([cat("malicious", "clean")])).toEqual({ tone: "ok", text: CLEAN });
  });

  // The dot must not be green under lanes that list findings.
  it("malicious clean, no gaps, another check found something: neutral, the same sentence", () => {
    expect(verdict([cat("malicious", "clean"), cat("tracking", "issues")])).toEqual({
      tone: "neutral",
      text: CLEAN,
    });
    expect(
      verdict([
        cat("malicious", "clean"),
        cat("tracking", "issues"),
        cat("seo-ai", "issues"),
        cat("store-data", "clean"),
      ]),
    ).toEqual({ tone: "neutral", text: CLEAN });
  });

  it("a gap wins over findings: amber, with the gap's sentence", () => {
    expect(
      verdict([cat("malicious", "clean"), cat("tracking", "issues"), cat("seo-ai", "not_checked")]),
    ).toEqual({ tone: "warn", text: GAPS });
    expect(
      verdict([cat("malicious", "clean"), cat("tracking", "issues"), cat("seo-ai", "partial")]),
    ).toEqual({ tone: "warn", text: PARTIAL });
    // The malicious check not run: amber too, whatever else was found.
    expect(verdict([cat("malicious", "not_checked"), cat("tracking", "issues")])).toEqual({
      tone: "warn",
      text: UNCHECKED,
    });
  });

  it("a vintage theme (the theme row's 'issues') is a theme fact: the dot stays green", () => {
    expect(
      verdict([cat("malicious", "clean"), cat("tracking", "clean"), cat("theme", "issues")]),
    ).toEqual({ tone: "ok", text: CLEAN });
    expect(verdict([cat("malicious", "clean"), cat("unpublished-themes", "issues")])).toEqual({
      tone: "ok",
      text: CLEAN,
    });
  });

  it("reads hasIssues from the groups it is given", () => {
    const groups = groupHealthRows([cat("malicious", "clean"), cat("tracking", "clean")]);
    expect(themeHealthVerdict(groups)!.tone).toBe("ok");
    expect(themeHealthVerdict({ ...groups, hasIssues: true })).toEqual({
      tone: "neutral",
      text: CLEAN,
    });
  });

  it("malicious clean and a check that did not run: amber, 'couldn't run'", () => {
    expect(verdict([cat("malicious", "clean"), cat("liquid-errors", "not_checked")])).toEqual({
      tone: "warn",
      text: GAPS,
    });
    // A mix of not checked and partly checked is still "couldn't run".
    expect(
      verdict([
        cat("malicious", "clean"),
        cat("liquid-errors", "not_checked"),
        cat("script-tag-deadline", "partial"),
      ]),
    ).toEqual({ tone: "warn", text: GAPS });
  });

  it("malicious clean and every gap partial: amber, 'only partly ran'", () => {
    expect(
      verdict([
        cat("malicious", "clean"),
        cat("shopper-visible", "partial"),
        cat("snippets-sections", "partial"),
      ]),
    ).toEqual({ tone: "warn", text: PARTIAL });
  });

  // THE false-all-clear guard: only a malicious row that is exactly "clean"
  // may be described as "no known malicious code found".
  it.each(["not_checked", "partial"] as const)(
    "malicious %s: amber, names the malicious check, never says no known malicious code was found",
    (status) => {
      for (const others of [
        [],
        [cat("tracking", "clean")],
        [cat("tracking", "clean"), cat("store-data", "partial")],
      ]) {
        const result = verdict([cat("malicious", status), ...others])!;
        expect(result).toEqual({ tone: "warn", text: UNCHECKED });
        expect(result.text).not.toMatch(/no known malicious code found/i);
      }
    },
  );

  it("no malicious row at all (legacy): amber, names the malicious check", () => {
    for (const rows of [
      [],
      [cat("tracking", "clean")],
      [cat("tracking", "clean"), cat("store-data", "clean"), cat("theme", "clean")],
      [cat("liquid-errors", "partial")],
    ]) {
      const result = verdict(rows)!;
      expect(result).toEqual({ tone: "warn", text: UNCHECKED });
      expect(result.text).not.toMatch(/no known malicious code found/i);
    }
  });

  it("a malicious row with any other status is not 'no known malicious code found' either", () => {
    expect(verdict([cat("malicious", "info"), cat("tracking", "clean")])).toEqual({
      tone: "warn",
      text: UNCHECKED,
    });
  });

  it("null when the malicious line is showing, from the rows or passed on its own", () => {
    expect(verdict([cat("malicious", "issues"), cat("tracking", "clean")])).toBeNull();
    const line = maliciousHealthRow("scan-1", 2);
    // The rows say clean (ignored findings), the line says found: no verdict.
    expect(verdict([cat("malicious", "clean"), cat("tracking", "clean")], line)).toBeNull();
    expect(verdict([cat("malicious", "not_checked")], line)).toBeNull();
    expect(verdict([], line)).toBeNull();
  });

  it("is green ONLY for malicious clean with no gap and no findings, over every triple of statuses", () => {
    const statuses = ["clean", "partial", "not_checked", "issues", "info"] as const;
    const seen = new Set<string>();
    for (const malicious of statuses) {
      for (const a of statuses) {
        for (const b of statuses) {
          const result = verdict([
            cat("malicious", malicious),
            cat("tracking", a),
            cat("seo-ai", b),
          ]);
          const where = `${malicious}/${a}/${b}`;
          if (malicious === "issues") {
            expect(result, where).toBeNull();
            continue;
          }
          const others: string[] = [a, b];
          const gap = others.includes("partial") || others.includes("not_checked");
          const expected =
            malicious !== "clean" || gap ? "warn" : others.includes("issues") ? "neutral" : "ok";
          expect(result!.tone, where).toBe(expected);
          expect(/no known malicious code found/i.test(result!.text), where).toBe(
            malicious === "clean",
          );
          seen.add(result!.tone);
        }
      }
    }
    // Not vacuous: every tone was reached.
    expect([...seen].sort()).toEqual(["neutral", "ok", "warn"]);
  });

  it("never contains a digit, a score word, 'x of y' or an em dash", () => {
    for (const text of [CLEAN, UNCHECKED, GAPS, PARTIAL]) {
      expect(text).not.toMatch(/\d|%|\bscore\b|\bgrade\b|\bof\b.*\bchecks\b|\u2014/i);
    }
    // And those four are every sentence it can return.
    const statuses = ["clean", "partial", "not_checked", "issues", "info"] as const;
    const seen = new Set<string>();
    for (const a of statuses) {
      for (const b of statuses) {
        for (const c of statuses) {
          const result = verdict([cat("malicious", a), cat("tracking", b), cat("seo-ai", c)]);
          if (result) seen.add(result.text);
        }
      }
    }
    expect([...seen].sort()).toEqual([CLEAN, UNCHECKED, GAPS, PARTIAL].sort());
  });

  describe("with the real builder", () => {
    const real = (overrides: Partial<ThemeHealthInput>, count = 0) => {
      const rows = buildThemeHealthChecklist(input(overrides));
      return themeHealthVerdict(groupHealthRows(rows, maliciousHealthRow("scan-1", count)));
    };

    it("full coverage, no findings: green", () => {
      expect(real({})).toEqual({ tone: "ok", text: CLEAN });
    });

    it("full coverage, findings in two categories: neutral, the same sentence", () => {
      expect(real({ typeCounts: { GHOST_SCRIPT: 12, GHOST_PIXEL: 2 } })).toEqual({
        tone: "neutral",
        text: CLEAN,
      });
    });

    it("full coverage, a vintage theme, no findings: still green", () => {
      expect(real({ themeInfo: { ...DAWN, architecture: "vintage" } })).toEqual({
        tone: "ok",
        text: CLEAN,
      });
    });

    it("findings AND an unreadable storefront: amber (the gap wins)", () => {
      expect(
        real({
          typeCounts: { GHOST_SCRIPT: 12 },
          coverage: {
            ...FULL_COVERAGE,
            unreachableCategories: ["SCRIPT_TAG_SUNSET", "LIQUID_ERROR_RENDERED"],
          },
        }),
      ).toEqual({ tone: "warn", text: GAPS });
    });

    it("storefront unreadable: amber, no known malicious code found, some checks couldn't run", () => {
      expect(
        real({
          coverage: {
            ...FULL_COVERAGE,
            unreachableCategories: ["SCRIPT_TAG_SUNSET", "LIQUID_ERROR_RENDERED"],
          },
        }),
      ).toEqual({ tone: "warn", text: GAPS });
    });

    it("Free plan gaps (both partial): amber, 'only partly ran'", () => {
      expect(
        real({
          coverage: { ...FULL_COVERAGE, planWithheld: ["DANGLING_REFERENCE", "CHECKOUT_SUNSET"] },
        }),
      ).toEqual({ tone: "warn", text: PARTIAL });
    });

    it("a legacy scan (no live set): amber, names the malicious check", () => {
      expect(real({ coverage: { ...FULL_COVERAGE, liveTypes: null } })).toEqual({
        tone: "warn",
        text: UNCHECKED,
      });
    });

    it("malicious findings, kept or ignored: no verdict", () => {
      expect(real({ typeCounts: { MALICIOUS_SCRIPT: 2 } }, 2)).toBeNull();
      // Every malicious finding ignored: the rows were built without them.
      expect(real({}, 2)).toBeNull();
    });
  });
});

describe("groupGapsByReason", () => {
  const gap = (label: string, detail: string | null): HealthRow => ({
    key: "tracking",
    label,
    checks: "",
    status: "not_checked",
    statusLabel: "Not checked",
    count: 0,
    detail,
    href: null,
  });

  it("no gaps: no groups", () => {
    expect(groupGapsByReason([])).toEqual([]);
  });

  it("rows that share a reason are one group, with every name in row order", () => {
    expect(groupGapsByReason([gap("A", "Why."), gap("B", "Why."), gap("C", "Why.")])).toEqual([
      { reason: "Why.", labels: ["A", "B", "C"] },
    ]);
  });

  it("different reasons are separate groups, in the order each first appears", () => {
    expect(
      groupGapsByReason([gap("A", "One."), gap("B", "Two."), gap("C", "One."), gap("D", null)]),
    ).toEqual([
      { reason: "One.", labels: ["A", "C"] },
      { reason: "Two.", labels: ["B"] },
      { reason: null, labels: ["D"] },
    ]);
  });

  it("the real builder, storefront unreadable: both checks under the one reason", () => {
    const rows = buildThemeHealthChecklist(
      input({
        coverage: {
          ...FULL_COVERAGE,
          unreachableCategories: ["SCRIPT_TAG_SUNSET", "LIQUID_ERROR_RENDERED"],
        },
      }),
    );
    expect(groupGapsByReason(groupHealthRows(rows).gaps)).toEqual([
      {
        reason:
          "We couldn't read your storefront homepage, for example because it has a password. Run a new scan once the homepage can be read.",
        labels: ["Liquid errors on your homepage", "Script tag deadline"],
      },
    ]);
  });

  it("the real builder, a legacy scan: all nine checks under the one reason", () => {
    const rows = buildThemeHealthChecklist(
      input({ coverage: { ...FULL_COVERAGE, liveTypes: null } }),
    );
    expect(groupGapsByReason(groupHealthRows(rows).gaps)).toEqual([
      {
        reason: "Not checked on your last scan. Run a new scan to try again.",
        labels: HEALTH_CATEGORIES.map((c) => c.label),
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// gc-wr81
// ---------------------------------------------------------------------------

describe("gc-wr81: 'Run a new scan' does not promise a result", () => {
  const without = (...types: string[]) =>
    new Set(ALL_TYPES.filter((t) => !types.includes(t)) as string[]);

  it("a check that did not run: the exact sentence", () => {
    const rows = buildThemeHealthChecklist(
      input({ coverage: { ...FULL_COVERAGE, liveTypes: without("LIQUID_ERROR_RENDERED") } }),
    );
    expect(rowOf(rows, "liquid-errors")!.detail).toBe(
      "Not checked on your last scan. Run a new scan to try again.",
    );
  });

  it("part of a row did not run: the exact sentence", () => {
    const rows = buildThemeHealthChecklist(
      input({ coverage: { ...FULL_COVERAGE, liveTypes: without("SETTINGS_DRIFT") } }),
    );
    expect(rowOf(rows, "snippets-sections")!.detail).toBe(
      "Partly checked on your last scan. Run a new scan to try again.",
    );
  });

  it("no gap sentence ends on a bare 'Run a new scan.', and none has a dash", () => {
    const coverages: Array<Partial<HealthCoverageInput>> = [
      { liveTypes: null },
      { liveTypes: without("SETTINGS_DRIFT") },
      { liveTypes: without("LIQUID_ERROR_RENDERED") },
      { cappedCategories: ["LIQUID_ERROR_RENDERED"] },
    ];
    for (const coverage of coverages) {
      const rows = buildThemeHealthChecklist(
        input({ coverage: { ...FULL_COVERAGE, ...coverage } }),
      );
      for (const row of groupHealthRows(rows).gaps) {
        expect(row.detail, row.key).not.toMatch(/Run a new scan\.$/);
        expect(row.detail, row.key).not.toMatch(/[—–]/);
      }
    }
  });
});

describe("gc-wr81: the Liquid error check cut short by its size cap", () => {
  const capped = { ...FULL_COVERAGE, cappedCategories: ["LIQUID_ERROR_RENDERED"] };

  it("coverageForType: capped when the check ran", () => {
    expect(coverageForType("LIQUID_ERROR_RENDERED", capped)).toBe("capped");
  });

  it("unreachable wins over capped", () => {
    expect(
      coverageForType("LIQUID_ERROR_RENDERED", {
        ...capped,
        unreachableCategories: ["LIQUID_ERROR_RENDERED"],
      }),
    ).toBe("unreachable");
  });

  it("not run wins over capped (the scan's live set lacks the type)", () => {
    expect(
      coverageForType("LIQUID_ERROR_RENDERED", {
        ...capped,
        liveTypes: new Set(ALL_TYPES.filter((t) => t !== "LIQUID_ERROR_RENDERED") as string[]),
      }),
    ).toBe("not_run");
  });

  it("the row never reads Clean, is listed with the gaps, and gives the cap as the reason", () => {
    const rows = buildThemeHealthChecklist(input({ coverage: capped }));
    const row = rowOf(rows, "liquid-errors")!;
    expect(row.status).not.toBe("clean");
    expect(row.statusLabel).not.toBe("Clean");
    // The check ran, so the row is partial, never "Not checked".
    expect(row).toMatchObject({ status: "partial", statusLabel: "None found" });
    // gc-wnhs: names what is over the cap (missing snippets), not "these".
    expect(row.detail).toBe(
      "Your theme is missing more snippets than one scan checks, so part wasn't checked.",
    );
    expect(row).toMatchObject({ count: 0, href: null });
    const groups = groupHealthRows(rows);
    expect(groups.gaps.map((r) => r.key)).toContain("liquid-errors");
    expect(groups.clean.map((r) => r.key)).not.toContain("liquid-errors");
    // Its neighbours are unaffected.
    expect(rowOf(rows, "shopper-visible")).toMatchObject({ status: "clean" });
  });

  it("an error found inside the cut still shows as an issue", () => {
    const rows = buildThemeHealthChecklist(
      input({ coverage: capped, typeCounts: { LIQUID_ERROR_RENDERED: 1 } }),
    );
    expect(rowOf(rows, "liquid-errors")).toMatchObject({ status: "issues", count: 1 });
  });
});

// ---------------------------------------------------------------------------
// gc-q5z8: the "App security advisories" check
// ---------------------------------------------------------------------------

describe("advisoryHealthRow (gc-q5z8)", () => {
  const DARK = new Set<string>(ALL_TYPES.filter((t) => t !== "APP_INCIDENT_ADVISORY"));

  it("an open (non-ignored) advisory: issues, with a count and a link to the scan", () => {
    expect(advisoryHealthRow("scan-1", 1, FULL_COVERAGE)).toEqual({
      key: "app-advisories",
      label: ADVISORY_HEALTH_LABEL,
      checks: expect.any(String),
      status: "issues",
      statusLabel: "1 issue",
      count: 1,
      detail: "An app named in a security incident is in your theme.",
      href: "/app/scans/scan-1",
    });
    expect(advisoryHealthRow("scan-1", 2, FULL_COVERAGE)?.detail).toBe(
      "2 apps named in a security incident are in your theme.",
    );
  });

  it("the check ran and nothing is open: clean (a green chip)", () => {
    expect(advisoryHealthRow("scan-1", 0, FULL_COVERAGE)).toMatchObject({
      status: "clean",
      statusLabel: "Clean",
      count: 0,
      detail: null,
      href: null,
    });
  });

  it("live now but this scan did not run it: Not checked, with the rescan line", () => {
    expect(advisoryHealthRow("scan-1", 0, { ...FULL_COVERAGE, liveTypes: DARK })).toMatchObject({
      status: "not_checked",
      statusLabel: "Not checked",
      detail: "Not checked on your last scan. Run a new scan to try again.",
    });
    expect(advisoryHealthRow("scan-1", 0, { ...FULL_COVERAGE, liveTypes: null })?.status).toBe(
      "not_checked",
    );
  });

  it("not live for anyone (flag off or every entry expired): no row at all", () => {
    expect(advisoryHealthRow("scan-1", 0, { ...FULL_COVERAGE, liveNow: DARK })).toBeNull();
  });

  it("a scan of an unpublished theme: no row (the check reads the published theme only)", () => {
    expect(
      advisoryHealthRow("scan-1", 0, { ...FULL_COVERAGE, isPublishedTheme: false }),
    ).toBeNull();
  });

  it("an open advisory is reported even when the check is dark now (a stored finding is never hidden)", () => {
    expect(
      advisoryHealthRow("scan-1", 1, { ...FULL_COVERAGE, liveNow: DARK, isPublishedTheme: false })
        ?.status,
    ).toBe("issues");
  });
});

describe("theme health groups and verdict with the advisory check (gc-q5z8)", () => {
  const rows = (advisoryCount: number, coverage = FULL_COVERAGE) => {
    const built = buildThemeHealthChecklist(input({ coverage }));
    const advisory = advisoryHealthRow("scan-1", advisoryCount, coverage);
    return advisory ? [...built, advisory] : built;
  };

  it("an open advisory is its own group, never a clean chip", () => {
    const groups = groupHealthRows(rows(1));
    expect(groups.advisory?.key).toBe("app-advisories");
    expect(groups.clean.map((r) => r.key)).not.toContain("app-advisories");
    expect(groups.gaps.map((r) => r.key)).not.toContain("app-advisories");
  });

  it("the verdict is red and names the incident, NEVER 'No known malicious code found.'", () => {
    const verdict = themeHealthVerdict(groupHealthRows(rows(1)));
    expect(verdict).toEqual({ tone: "critical", text: VERDICT_ADVISORY });
    expect(VERDICT_ADVISORY).toBe("An app named in a security incident is in your theme.");
    // Even with every other check clean and nothing else found.
    expect(verdict?.text).not.toContain("No known malicious code found");
  });

  it("known malicious code beside it: the malicious line is the verdict (null), the advisory still fails", () => {
    const groups = groupHealthRows(rows(1), maliciousHealthRow("scan-1", 2));
    expect(themeHealthVerdict(groups)).toBeNull();
    expect(groups.advisory?.status).toBe("issues");
  });

  it("clean advisory check: a green chip and the usual green verdict", () => {
    const groups = groupHealthRows(rows(0));
    expect(groups.advisory).toBeNull();
    expect(groups.clean.map((r) => r.key)).toContain("app-advisories");
    expect(themeHealthVerdict(groups)).toEqual({
      tone: "ok",
      text: "No known malicious code found.",
    });
  });

  it("not checked: an amber gap (the verdict says some checks could not run)", () => {
    const DARK_SCAN = new Set<string>(ALL_TYPES.filter((t) => t !== "APP_INCIDENT_ADVISORY"));
    const groups = groupHealthRows(rows(0, { ...FULL_COVERAGE, liveTypes: DARK_SCAN }));
    expect(groups.gaps.map((r) => r.key)).toEqual(["app-advisories"]);
    expect(themeHealthVerdict(groups)?.tone).toBe("warn");
  });

  it("the nine category rows are unchanged by an advisory (it is still in no category)", () => {
    const built = buildThemeHealthChecklist(input({ typeCounts: { APP_INCIDENT_ADVISORY: 3 } }));
    expect(built).toEqual(buildThemeHealthChecklist(input()));
  });
});

describe("malicious row wording when code was seen on the live homepage (gc-0htk)", () => {
  it("does not say it is in the theme; the theme-only wording is unchanged", () => {
    expect(maliciousHealthRow("scan-1", 1, true)?.detail).toBe(
      "1 piece of code from a known malicious source was found in your theme or on your live homepage. It can steal shopper data or send your customers to other sites.",
    );
    expect(maliciousHealthRow("scan-1", 2)?.detail).toBe(
      "2 pieces of code from a known malicious source are in your theme. It can steal shopper data or send your customers to other sites.",
    );
  });
});

/**
 * Affected-app advisory (gc-14x5): the pure, client-safe product rules for the
 * APP_INCIDENT_ADVISORY finding type.
 *
 *   1. NEVER PAYWALLED, through the one shared helper
 *      (isNeverPaywalledFindingType), exactly like MALICIOUS_SCRIPT.
 *   2. Ranked below MALICIOUS_SCRIPT and above every other finding.
 *   3. NOT malicious code: a normal finding for the Home findings tile, no
 *      "Known malicious code" row, verify-first, the owner's copy.
 *
 * The detector and the list are covered in
 * tests/services/app-incident-advisory.server.test.ts.
 */
import { FindingType } from "@prisma/client";
import type { Severity } from "@prisma/client";
import { describe, it, expect } from "vitest";

import {
  CROSS_FILE_FINDING_TYPES,
  getFindingConfidence,
  hasVisualImpact,
  isAdminResourceFinding,
  isNeverPaywalledFindingType,
  isOwnSectionFindingType,
  isStorefrontFinding,
  isThemeFileFinding,
  NEVER_PAYWALLED_FINDING_TYPES,
  OWN_SECTION_FINDING_TYPES,
  SIZE_SKIP_STILL_SCANNED_FINDING_TYPES,
} from "../../app/lib/finding-classification";
import {
  computeLaneSummary,
  CONSEQUENCE_MAP,
  dominantLane,
  laneForType,
  LANES,
  soWhatForLane,
  startHereLane,
  typesForLane,
} from "../../app/lib/finding-consequence";
import {
  buildRemovalInstructions,
  findingMatchedLine,
  getFindingCardCopy,
  getFindingImpact,
  getFindingRemediation,
  LINE_CONTEXT_SNIPPET_TYPES,
  splitNumberedSteps,
} from "../../app/lib/finding-remediation";
import { getRemovalSafety, REMOVAL_SAFETY_LABELS } from "../../app/lib/finding-safety";
import { FINDING_TYPE_LABELS, findingTypeLabel } from "../../app/lib/finding-type-labels";
import { buildFindingsTile } from "../../app/lib/findings-tile";
import {
  freePreviewCount,
  freePreviewHiddenCount,
  pickFreePreviewFindings,
} from "../../app/lib/free-preview";
import { findingTypesWithheldByPlan } from "../../app/lib/plan-finding-types";
import {
  buildThemeHealthChecklist,
  groupHealthRows,
  HEALTH_CATEGORIES,
  HEALTH_CATEGORY_OF,
  healthCostLine,
  maliciousHealthRow,
  themeHealthVerdict,
  type HealthCoverageInput,
} from "../../app/lib/theme-health";
import {
  compareFindingClass,
  compareFindingImportance,
  findingCostLine,
  pickTopFindings,
  securityRank,
  topFindingHref,
  toTopFindingViews,
} from "../../app/lib/top-findings";
import { buildUpgradePreview, upgradePreviewHeadline } from "../../app/lib/upgrade-preview";
import { isUpgradeReturnEligible } from "../../app/lib/upgrade-return";

const ADVISORY = "APP_INCIDENT_ADVISORY" as const;
const ALL_TYPES = Object.values(FindingType);
const OTHER_TYPES = ALL_TYPES.filter((t) => t !== ADVISORY && t !== "MALICIOUS_SCRIPT");
const SEVERITIES: Severity[] = ["HIGH", "MEDIUM", "LOW"];

function c(id: string, findingType: FindingType, severity: Severity = "HIGH", minute = 0) {
  return { id, findingType, severity, createdAt: new Date(Date.UTC(2026, 9, 12, 0, minute)) };
}
const ids = (rows: ReadonlyArray<{ id: string }>) => rows.map((r) => r.id);

// ---------------------------------------------------------------------------
// The shared helper
// ---------------------------------------------------------------------------

describe("isNeverPaywalledFindingType (the one plan-gating exemption list)", () => {
  it("is true for known malicious code and for affected-app advisories", () => {
    expect(isNeverPaywalledFindingType("MALICIOUS_SCRIPT")).toBe(true);
    expect(isNeverPaywalledFindingType("APP_INCIDENT_ADVISORY")).toBe(true);
  });

  it("is false for every other FindingType", () => {
    for (const type of OTHER_TYPES) {
      expect(isNeverPaywalledFindingType(type), type).toBe(false);
    }
  });

  it.each([
    "",
    "malicious_script",
    "app_incident_advisory",
    "SOME_FUTURE_TYPE",
    " MALICIOUS_SCRIPT",
  ])("is false for %j (exact enum names only)", (value) => {
    expect(isNeverPaywalledFindingType(value)).toBe(false);
  });

  it("the list is exactly those two types, each a real FindingType, none repeated", () => {
    expect([...NEVER_PAYWALLED_FINDING_TYPES]).toEqual([
      "MALICIOUS_SCRIPT",
      "APP_INCIDENT_ADVISORY",
    ]);
    for (const type of NEVER_PAYWALLED_FINDING_TYPES) expect(ALL_TYPES).toContain(type);
    expect(new Set(NEVER_PAYWALLED_FINDING_TYPES).size).toBe(NEVER_PAYWALLED_FINDING_TYPES.length);
  });

  it("the helper and the list agree for every FindingType", () => {
    for (const type of ALL_TYPES) {
      expect(isNeverPaywalledFindingType(type), type).toBe(
        (NEVER_PAYWALLED_FINDING_TYPES as readonly string[]).includes(type),
      );
    }
  });

  it("a never-paywalled type is never withheld by a plan", () => {
    const withheld = findingTypesWithheldByPlan({
      canDetectDanglingReferences: false,
      canDetectCheckoutSunset: false,
    });
    for (const type of NEVER_PAYWALLED_FINDING_TYPES) expect(withheld).not.toContain(type);
  });
});

// ---------------------------------------------------------------------------
// Rule 1: never paywalled, at each pure gating site
// ---------------------------------------------------------------------------

describe("never paywalled: the Free preview picker (free-preview.ts)", () => {
  it("never gives an advisory a preview slot (it is shown in full outside the preview)", () => {
    const picked = pickFreePreviewFindings(
      [c("adv", ADVISORY), c("script", "GHOST_SCRIPT"), c("pixel", "GHOST_PIXEL", "LOW")],
      5,
    );
    expect(ids(picked)).not.toContain("adv");
    expect(ids(picked).sort()).toEqual(["pixel", "script"]);
  });

  it("drops an advisory even when it is the only candidate", () => {
    expect(pickFreePreviewFindings([c("adv", ADVISORY)], 5)).toEqual([]);
  });

  it("drops both never-paywalled types and keeps the rest of the lane", () => {
    // GHOST_PIXEL shares malicious code's lane (privacy); the advisory has none.
    const picked = pickFreePreviewFindings(
      [c("mal", "MALICIOUS_SCRIPT"), c("adv", ADVISORY), c("pixel", "GHOST_PIXEL", "LOW")],
      5,
    );
    expect(ids(picked)).toEqual(["pixel"]);
  });

  it("an advisory does not use up one of the picker's slots", () => {
    const others = Array.from({ length: 5 }, (_, i) => c(`s${i}`, "GHOST_SCRIPT", "HIGH", i));
    expect(pickFreePreviewFindings([c("adv", ADVISORY), ...others], 5)).toHaveLength(5);
  });
});

describe("never paywalled: the upgrade teaser (upgrade-preview.ts)", () => {
  it("an advisory is never counted as hidden", () => {
    expect(buildUpgradePreview({ APP_INCIDENT_ADVISORY: 1 }, [])).toBeNull();
    expect(buildUpgradePreview({ APP_INCIDENT_ADVISORY: 3, MALICIOUS_SCRIPT: 2 }, [])).toBeNull();
  });

  it("hidden = the paywalled findings only, with the advisory out of its lane's count", () => {
    const preview = buildUpgradePreview(
      { APP_INCIDENT_ADVISORY: 1, MALICIOUS_SCRIPT: 1, GHOST_PIXEL: 2, GHOST_SCRIPT: 4 },
      ["GHOST_SCRIPT"],
    );
    expect(preview).toEqual({
      hiddenCount: 5,
      groups: [
        { label: "Speed", count: 3 },
        { label: "Still tracking you", count: 2 },
      ],
    });
    expect(upgradePreviewHeadline(preview!)).toBe(
      "5 more findings on Standard: Speed (3), Still tracking you (2).",
    );
  });

  it("the hidden count is the same with and without an advisory in the scan", () => {
    const base = { GHOST_SCRIPT: 6, GHOST_SNIPPET: 2 } as const;
    expect(buildUpgradePreview({ ...base, APP_INCIDENT_ADVISORY: 1 }, ["GHOST_SCRIPT"])).toEqual(
      buildUpgradePreview(base, ["GHOST_SCRIPT"]),
    );
  });

  it("does not mutate the caller's counts", () => {
    const byType = { APP_INCIDENT_ADVISORY: 1, GHOST_SCRIPT: 2 };
    buildUpgradePreview(byType, []);
    expect(byType).toEqual({ APP_INCIDENT_ADVISORY: 1, GHOST_SCRIPT: 2 });
  });
});

describe("never paywalled: the Free preview formula and the return banner", () => {
  it("the formula's total is the paywalled count, so an advisory changes nothing", () => {
    // 4 paywalled findings -> 2 shown, 2 hidden, whether or not an advisory exists.
    expect(freePreviewCount(4)).toBe(2);
    expect(freePreviewHiddenCount(4)).toBe(2);
  });

  it("a scan whose only finding is an advisory never makes the return banner eligible", () => {
    // getLatestSuccessfulScanNonMaliciousCount excludes never-paywalled types,
    // so such a scan reports 0 here: nothing is hidden, nothing to upsell.
    const state = {
      plan: "free",
      firstSuccessfulScanAt: new Date("2026-10-01T00:00:00Z"),
      latestScanNonMaliciousCount: 0,
      upgradeReturnDismissCount: 0,
      upgradeReturnLastShownAt: null,
      upgradeReturnLastDismissedAt: null,
    };
    expect(isUpgradeReturnEligible(state, new Date("2026-10-12T00:00:00Z"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rule 3: ranking
// ---------------------------------------------------------------------------

describe("ranking: below MALICIOUS_SCRIPT, above every other finding (top-findings.ts)", () => {
  it("securityRank: malicious 0, advisory 1, everything else 2", () => {
    expect(securityRank("MALICIOUS_SCRIPT")).toBe(0);
    expect(securityRank(ADVISORY)).toBe(1);
    for (const type of OTHER_TYPES) expect(securityRank(type), type).toBe(2);
  });

  it("ranks below malicious code, even a LOW malicious finding", () => {
    const rows = [c("adv", ADVISORY, "HIGH", 0), c("mal", "MALICIOUS_SCRIPT", "LOW", 5)];
    expect(ids([...rows].sort(compareFindingImportance))).toEqual(["mal", "adv"]);
    expect(ids(pickTopFindings(rows))).toEqual(["mal", "adv"]);
  });

  it.each(OTHER_TYPES)("ranks above a HIGH %s that is older", (type) => {
    const rows = [c("other", type, "HIGH", 0), c("adv", ADVISORY, "HIGH", 30)];
    expect(ids([...rows].sort(compareFindingImportance))).toEqual(["adv", "other"]);
    expect(ids(pickTopFindings(rows))[0]).toBe("adv");
  });

  it.each(SEVERITIES)("ranks above every other type whatever its own severity (%s)", (severity) => {
    // The detector always emits HIGH; the rank must not depend on that.
    for (const type of OTHER_TYPES) {
      expect(
        compareFindingClass(
          { findingType: ADVISORY, severity },
          { findingType: type, severity: "HIGH" },
        ),
        type,
      ).toBeLessThan(0);
      expect(
        compareFindingClass(
          { findingType: "MALICIOUS_SCRIPT", severity: "LOW" },
          { findingType: ADVISORY, severity },
        ),
      ).toBeLessThan(0);
    }
  });

  it("full order: malicious, advisory, then HIGH, MEDIUM, LOW", () => {
    const rows = [
      c("low", "ORPHAN_ASSET", "LOW"),
      c("high", "GHOST_SCRIPT", "HIGH"),
      c("adv", ADVISORY, "HIGH"),
      c("med", "GHOST_SNIPPET", "MEDIUM"),
      c("mal", "MALICIOUS_SCRIPT", "MEDIUM"),
    ];
    expect(ids([...rows].sort(compareFindingImportance))).toEqual([
      "mal",
      "adv",
      "high",
      "med",
      "low",
    ]);
  });

  it("Start here with malicious code and an advisory: malicious, advisory, then the best other", () => {
    const rows = [
      c("script1", "GHOST_SCRIPT", "HIGH", 0),
      c("script2", "GHOST_SCRIPT", "HIGH", 1),
      c("adv", ADVISORY, "HIGH", 9),
      c("mal", "MALICIOUS_SCRIPT", "HIGH", 9),
    ];
    expect(ids(pickTopFindings(rows))).toEqual(["mal", "adv", "script1"]);
  });

  it("the diversity rule never displaces an advisory: two advisories both stay above a HIGH finding of another type", () => {
    const rows = [
      c("adv1", ADVISORY, "HIGH", 0),
      c("adv2", ADVISORY, "HIGH", 1),
      c("script", "GHOST_SCRIPT", "HIGH", 0),
      c("pixel", "GHOST_PIXEL", "HIGH", 0),
    ];
    expect(ids(pickTopFindings(rows))).toEqual(["adv1", "adv2", "script"]);
  });

  it("three malicious findings still fill every slot ahead of an advisory", () => {
    const rows = [
      c("adv", ADVISORY, "HIGH", 0),
      c("m1", "MALICIOUS_SCRIPT", "HIGH", 1),
      c("m2", "MALICIOUS_SCRIPT", "HIGH", 2),
      c("m3", "MALICIOUS_SCRIPT", "HIGH", 3),
    ];
    expect(ids(pickTopFindings(rows))).toEqual(["m1", "m2", "m3"]);
  });

  it("an advisory is never the diversity ALTERNATIVE either (it is already ranked first)", () => {
    const rows = [
      c("script1", "GHOST_SCRIPT", "HIGH", 0),
      c("script2", "GHOST_SCRIPT", "HIGH", 1),
      c("adv", ADVISORY, "HIGH", 5),
    ];
    expect(ids(pickTopFindings(rows))).toEqual(["adv", "script1", "script2"]);
  });

  it("among advisories the stable tie-break applies: oldest first, then id", () => {
    const rows = [
      c("b", ADVISORY, "HIGH", 1),
      c("a", ADVISORY, "HIGH", 1),
      c("z", ADVISORY, "HIGH", 0),
    ];
    expect(ids([...rows].sort(compareFindingImportance))).toEqual(["z", "a", "b"]);
  });
});

describe("Start here presentation", () => {
  const finding = {
    ...c("f1", ADVISORY),
    filename: "layout/theme.liquid",
    lineNumber: 42,
    appName: null,
  };

  it("builds the row: label, location, the advisory's own cost line, NO lane", () => {
    expect(toTopFindingViews("scan-1", [finding], true)).toEqual([
      {
        id: "f1",
        severity: "HIGH",
        lane: null,
        typeLabel: "App Security Advisories",
        location: "layout/theme.liquid, line 42",
        cost: "A public report describes this app delivering code that sent shoppers to a fake checkout page on at least one store.",
        href: "/app/scans/scan-1#finding-f1",
        appName: null,
      },
    ]);
  });

  it("the cost line is NOT the privacy lane's 'a removed app is still collecting data' line", () => {
    const line = findingCostLine(ADVISORY);
    expect(line).not.toBe(findingCostLine("GHOST_PIXEL"));
    expect(line).not.toMatch(/removed app|still collecting/i);
    expect(line).not.toBe(findingCostLine("MALICIOUS_SCRIPT"));
  });

  it("the cost line is a sentence of the type's own remediation copy, and claims nothing about this store", () => {
    const line = findingCostLine(ADVISORY);
    expect(getFindingImpact(ADVISORY)).toContain(line);
    expect(line).not.toMatch(/your (store|checkout|theme)/i);
    expect(line).not.toMatch(/[—–]/);
  });

  it("links to its card on the unfiltered page on a full-list plan too (it is above the list, not in it)", () => {
    expect(topFindingHref("scan-1", { id: "f1", findingType: ADVISORY }, true)).toBe(
      "/app/scans/scan-1#finding-f1",
    );
    // Control: any other type still links into the type-filtered list.
    expect(topFindingHref("scan-1", { id: "f2", findingType: "GHOST_SCRIPT" }, true)).toBe(
      "/app/scans/scan-1?type=GHOST_SCRIPT#finding-f2",
    );
  });

  it("links to its row on the unfiltered page on Free (the advisories list)", () => {
    expect(topFindingHref("scan-1", { id: "f1", findingType: ADVISORY }, false)).toBe(
      "/app/scans/scan-1#finding-f1",
    );
  });
});

// ---------------------------------------------------------------------------
// Rule 4: tone. Not malicious code.
// ---------------------------------------------------------------------------

describe("Home findings tile: an advisory is a normal finding, never critical", () => {
  it("an advisory alone is a warning tile counting 1, not a critical one", () => {
    // Home feeds maliciousFound / maliciousKept from the MALICIOUS_SCRIPT counts
    // only; an advisory reaches the tile through the filtered total.
    expect(buildFindingsTile({ filteredTotal: 1, maliciousFound: 0, maliciousKept: 0 })).toEqual({
      total: 1,
      tone: "warning",
    });
  });

  it("an ignored advisory leaves a green zero (it honours ignores; nothing is added back)", () => {
    expect(buildFindingsTile({ filteredTotal: 0, maliciousFound: 0, maliciousKept: 0 })).toEqual({
      total: 0,
      tone: "success",
    });
  });

  it("malicious code beside an advisory is still critical (unchanged)", () => {
    expect(buildFindingsTile({ filteredTotal: 2, maliciousFound: 1, maliciousKept: 1 }).tone).toBe(
      "critical",
    );
  });
});

describe("theme health: no row of its own, and never 'Known malicious code'", () => {
  const ALL_LIVE = new Set<string>(ALL_TYPES);
  const coverage: HealthCoverageInput = {
    skippedCategories: [],
    cappedCategories: [],
    unreachableCategories: [],
    liveTypes: ALL_LIVE,
    liveNow: ALL_LIVE,
    planWithheld: [],
    isPublishedTheme: true,
  };
  const rows = (
    typeCounts: Partial<Record<FindingType, number>>,
    over: Partial<HealthCoverageInput> = {},
    fullList = true,
  ) =>
    buildThemeHealthChecklist({
      scanId: "scan-1",
      typeCounts,
      coverage: { ...coverage, ...over },
      fullList,
      themeInfo: null,
      scanThemeName: "Dawn",
      themes: null,
      scriptTagsStopped: false,
    });

  it("counts in the theme scripts row, not the malicious row", () => {
    expect(HEALTH_CATEGORY_OF.APP_INCIDENT_ADVISORY).toBe("scripts-styles");
    expect(HEALTH_CATEGORY_OF.APP_INCIDENT_ADVISORY).not.toBe("malicious");
  });

  it("adds no category (still the nine rows)", () => {
    expect(HEALTH_CATEGORIES.map((c) => c.key)).toEqual([
      "malicious",
      "liquid-errors",
      "shopper-visible",
      "scripts-styles",
      "snippets-sections",
      "seo-ai",
      "tracking",
      "store-data",
      "script-tag-deadline",
    ]);
  });

  it("an advisory alone: the malicious row stays Clean and its row reads 1 issue", () => {
    const built = rows({ APP_INCIDENT_ADVISORY: 1 });
    expect(built.find((r) => r.key === "malicious")).toMatchObject({
      status: "clean",
      statusLabel: "Clean",
      count: 0,
    });
    expect(built.find((r) => r.key === "scripts-styles")).toMatchObject({
      status: "issues",
      statusLabel: "1 issue",
      count: 1,
      detail: "1 script from an app named in a public security report.",
      // The unfiltered page: the advisory is above the list, not a list filter.
      href: "/app/scans/scan-1",
    });
  });

  it("on Free the row links to the unfiltered scan page (where the advisories list is)", () => {
    const built = rows({ APP_INCIDENT_ADVISORY: 1 }, {}, false);
    expect(built.find((r) => r.key === "scripts-styles")?.href).toBe("/app/scans/scan-1");
  });

  it.each([
    [1, "1 script from an app named in a public security report."],
    [2, "2 scripts from apps named in a public security report."],
  ])("cost line for %i advisory finding(s)", (count, line) => {
    expect(
      healthCostLine(
        "scripts-styles",
        { APP_INCIDENT_ADVISORY: count },
        { scriptTagsStopped: false },
      ),
    ).toBe(line);
  });

  it("joins the row's other costs, and never calls the app removed or the code malicious", () => {
    const line = healthCostLine(
      "scripts-styles",
      { APP_INCIDENT_ADVISORY: 1, GHOST_SCRIPT: 2 },
      { scriptTagsStopped: false },
    );
    expect(line).toBe(
      "2 extra requests to apps you removed, on every page that loads them and 1 script from an app named in a public security report.",
    );
    const alone = healthCostLine(
      "scripts-styles",
      { APP_INCIDENT_ADVISORY: 1 },
      { scriptTagsStopped: false },
    );
    expect(alone).not.toMatch(/removed|leftover|malicious|compromised/i);
    expect(alone).not.toMatch(/[—–]/);
  });

  it("the malicious cost line ignores advisories", () => {
    expect(
      healthCostLine(
        "malicious",
        { MALICIOUS_SCRIPT: 1, APP_INCIDENT_ADVISORY: 5 },
        { scriptTagsStopped: false },
      ),
    ).toBe(
      "1 piece of code from a known malicious source is in your theme. It can steal shopper data or send your customers to other sites.",
    );
  });

  it("Home's critical malicious line is never built for an advisory", () => {
    // Home passes the MALICIOUS_SCRIPT count only; an advisory-only scan has 0.
    expect(maliciousHealthRow("scan-1", 0)).toBeNull();
    const groups = groupHealthRows(rows({ APP_INCIDENT_ADVISORY: 1 }), null);
    expect(groups.malicious).toBeNull();
    expect(groups.hasIssues).toBe(true);
    // The verdict stays the plain sentence, with a neutral (not green, not red) dot.
    expect(themeHealthVerdict(groups)).toEqual({
      tone: "neutral",
      text: "No known malicious code found.",
    });
  });

  it("while the check is dark (its flag off) its row is unchanged: Clean, nothing promised", () => {
    const liveNow = new Set(ALL_TYPES.filter((t) => t !== ADVISORY) as string[]);
    const liveTypes = new Set(liveNow);
    const built = rows({}, { liveNow, liveTypes });
    expect(built.find((r) => r.key === "scripts-styles")).toMatchObject({
      status: "clean",
      statusLabel: "Clean",
    });
  });

  it("once the check is on, a scan that predates it reads 'None found', never 'Clean', for that row", () => {
    const liveTypes = new Set(ALL_TYPES.filter((t) => t !== ADVISORY) as string[]);
    const built = rows({}, { liveTypes });
    expect(built.find((r) => r.key === "scripts-styles")).toMatchObject({
      status: "partial",
      statusLabel: "None found",
    });
  });
});

// ---------------------------------------------------------------------------
// Classification and copy
// ---------------------------------------------------------------------------

describe("classification", () => {
  it("label is the owner's wording", () => {
    expect(FINDING_TYPE_LABELS.APP_INCIDENT_ADVISORY).toBe("App Security Advisories");
    expect(findingTypeLabel(ADVISORY)).toBe("App Security Advisories");
  });

  it("is a theme-file finding (Open in code editor), not an admin or storefront one", () => {
    expect(isThemeFileFinding(ADVISORY)).toBe(true);
    expect(isAdminResourceFinding(ADVISORY)).toBe(false);
    expect(isStorefrontFinding(ADVISORY)).toBe(false);
  });

  it("is a curated-list match (signature tier) and not a shopper-visible element", () => {
    expect(getFindingConfidence(ADVISORY)).toBe("signature");
    expect(hasVisualImpact(ADVISORY)).toBe(false);
  });

  it("is a cross-file type for the differ: one per list entry, recomputed over every file each scan", () => {
    expect(CROSS_FILE_FINDING_TYPES.has(ADVISORY)).toBe(true);
    // Not also in the per-file "still scanned when oversized" set.
    expect(SIZE_SKIP_STILL_SCANNED_FINDING_TYPES.has(ADVISORY)).toBe(false);
  });

  describe("NO consequence lane (owner decision: an advisory is not a cost)", () => {
    it("maps to no lane at all", () => {
      expect(CONSEQUENCE_MAP.APP_INCIDENT_ADVISORY).toEqual({
        primary: null,
        secondary: [],
        urgency: "act-now",
        agentic: false,
      });
      expect(laneForType(ADVISORY)).toBeNull();
    });

    it("it is the ONLY type without a lane", () => {
      const unlaned = ALL_TYPES.filter((t) => CONSEQUENCE_MAP[t].primary === null);
      expect(unlaned).toEqual([ADVISORY]);
    });

    it.each(LANES.map((l) => l.key))(
      "is not in the %s lane's types (so no ?lane= filter matches it)",
      (lane) => {
        expect(typesForLane(lane)).not.toContain(ADVISORY);
      },
    );

    it("an advisory-only scan has NO lane rows, no dominant lane and no start-here lane", () => {
      const summary = computeLaneSummary({ APP_INCIDENT_ADVISORY: 1 });
      expect(summary).toEqual([]);
      expect(dominantLane(summary)).toBeNull();
      expect(startHereLane(summary)).toBeNull();
    });

    it("beside other findings it adds nothing to any lane's count, urgency or the dominant lane", () => {
      const others = { GHOST_PIXEL: 2, ORPHAN_ASSET: 3 } as const;
      const withAdvisory = computeLaneSummary({ ...others, APP_INCIDENT_ADVISORY: 5 });
      expect(withAdvisory).toEqual(computeLaneSummary(others));
      expect(withAdvisory.reduce((n, row) => n + row.count, 0)).toBe(5);
      expect(dominantLane(withAdvisory)).toBe("housekeeping");
      expect(startHereLane(withAdvisory)).toBe("privacy");
    });

    it("never carries any lane's label or 'so what' copy", () => {
      expect(findingCostLine(ADVISORY)).not.toBe(soWhatForLane("privacy"));
      for (const lane of LANES) {
        expect(findingCostLine(ADVISORY)).not.toBe(lane.soWhat);
        expect(findingCostLine(ADVISORY)).not.toContain(lane.label);
      }
    });

    it("malicious code keeps its lane (unchanged)", () => {
      expect(laneForType("MALICIOUS_SCRIPT")).toBe("privacy");
      expect(computeLaneSummary({ MALICIOUS_SCRIPT: 1, APP_INCIDENT_ADVISORY: 1 })).toEqual([
        expect.objectContaining({ lane: "privacy", count: 1 }),
      ]);
    });

    it("two advisories of one severity are the same class (the tie-break orders them)", () => {
      expect(
        compareFindingClass(
          { findingType: ADVISORY, severity: "HIGH" },
          { findingType: ADVISORY, severity: "HIGH" },
        ),
      ).toBe(0);
    });
  });

  describe("shown in its own section, never in the findings list", () => {
    it("is the one own-section type", () => {
      expect([...OWN_SECTION_FINDING_TYPES]).toEqual(["APP_INCIDENT_ADVISORY"]);
      expect(isOwnSectionFindingType(ADVISORY)).toBe(true);
    });

    it("no other type is, malicious code included (it has the security alert and stays in the list)", () => {
      for (const type of ALL_TYPES.filter((t) => t !== ADVISORY)) {
        expect(isOwnSectionFindingType(type), type).toBe(false);
      }
      expect(isOwnSectionFindingType("")).toBe(false);
    });

    it("every own-section type is never paywalled", () => {
      for (const type of OWN_SECTION_FINDING_TYPES) {
        expect(isNeverPaywalledFindingType(type)).toBe(true);
      }
    });
  });

  it("is 'Verify first', never 'safe to remove': the script may belong to an app still in use", () => {
    expect(getRemovalSafety(ADVISORY)).toBe("verify-first");
    expect(REMOVAL_SAFETY_LABELS[getRemovalSafety(ADVISORY)]).toBe("Verify first");
  });
});

describe("remediation copy (the owner's sentences, as written)", () => {
  const WHY = [
    "Your theme loads a script from this app.",
    "A public report describes this app delivering code that sent shoppers to a fake checkout page on at least one store.",
    "GhostCode reads theme files and cannot see code an app loads while a shopper is browsing, so we cannot tell you whether your store was affected.",
    "This script loads whether or not the app is still installed.",
  ];
  const STEPS = [
    "Open your store in a private (incognito) window, add a product to the cart and click the ordinary Checkout button.",
    "Read the address bar before typing anything. It should start with a domain listed under Settings, Domains in your Shopify admin.",
    "Shop Pay, PayPal and similar buttons open their own sites. That is normal.",
    "If the page asking for contact, shipping or card details is on any other address, do not enter card details. Contact Shopify Support and the app developer.",
    "If you no longer use the app, remove its script line from the theme file shown here (duplicate your theme first). If you still use it, ask the developer whether this affects you.",
  ];

  it("'Why it matters' is the four sentences, in order", () => {
    expect(getFindingImpact(ADVISORY)).toBe(WHY.join(" "));
  });

  it("the how-to is the five numbered steps, in order", () => {
    expect(getFindingRemediation(ADVISORY)).toBe(STEPS.map((s, i) => `${i + 1}. ${s}`).join(" "));
  });

  it("uses the brand name GhostCode and no dashes", () => {
    const text = `${getFindingImpact(ADVISORY)} ${getFindingRemediation(ADVISORY)}`;
    expect(text).toContain("GhostCode");
    expect(text).not.toMatch(/Ghost Code/);
    expect(text).not.toMatch(/[—–]/);
  });

  it("never says the store or its checkout was hijacked, or that the code is malicious or leftover", () => {
    const text = `${getFindingImpact(ADVISORY)} ${getFindingRemediation(ADVISORY)}`;
    expect(text).not.toMatch(/hijack|compromised|malicious|infected|hacked|skimmer/i);
    expect(text).not.toMatch(/leftover|left behind|uninstalled/i);
    // The one sentence about this store says what GhostCode cannot know.
    expect(text.match(/your store (is|was|has been) /gi)).toEqual(["your store was "]);
    expect(text).toContain("we cannot tell you whether your store was affected");
    expect(text).not.toMatch(/your checkout (is|was|has been) /i);
  });

  it("is not the generic fallback and not the malicious copy", () => {
    expect(getFindingRemediation(ADVISORY)).not.toBe(getFindingRemediation("SOME_FUTURE_TYPE"));
    expect(getFindingRemediation(ADVISORY)).not.toBe(getFindingRemediation("MALICIOUS_SCRIPT"));
    expect(getFindingImpact(ADVISORY)).not.toBe(getFindingImpact("MALICIOUS_SCRIPT"));
  });

  it("the copied instructions name the file, the line and the code found, then the steps", () => {
    const snippet = '<script src="https://productoption.hulkapps.com/hulkcode.js"></script>';
    const text = buildRemovalInstructions(
      {
        findingType: ADVISORY,
        filename: "layout/theme.liquid",
        lineNumber: 42,
        codeSnippet: snippet,
      },
      "App Security Advisories",
    );
    expect(text).toBe(
      [
        "GhostCode finding: App Security Advisories",
        "File: layout/theme.liquid  (line 42)",
        "Code found:",
        snippet,
        `How: ${getFindingRemediation(ADVISORY)}`,
      ].join("\n"),
    );
  });

  it("the snippet is a window of the line, so the card never derives a 'matched line' from it", () => {
    expect(LINE_CONTEXT_SNIPPET_TYPES.has(ADVISORY)).toBe(false);
    expect(
      findingMatchedLine({ findingType: ADVISORY, lineNumber: 2, codeSnippet: "a\nb\nc" }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Card wording (round 2): this type only
// ---------------------------------------------------------------------------

describe("getFindingCardCopy", () => {
  it("an advisory: its own title, detection sentence, steps heading, copy label and report link", () => {
    expect(getFindingCardCopy(ADVISORY)).toEqual({
      title: "An app in your theme was named in a checkout phishing report",
      confidence: "Matched a script address from a public incident report.",
      stepsHeading: "What to check",
      copyStepsLabel: "Copy steps",
      copyStepsAccessibilityLabel: "Copy steps for this finding",
      reportLinkLabel: "Read the report",
    });
  });

  it.each([...ALL_TYPES.filter((t) => t !== ADVISORY), "SOME_FUTURE_TYPE", ""])(
    "%s keeps the default card wording",
    (type) => {
      expect(getFindingCardCopy(type)).toEqual({
        title: null,
        confidence: null,
        stepsHeading: "How to remove",
        copyStepsLabel: "Copy removal steps",
        copyStepsAccessibilityLabel: "Copy removal steps for this finding",
        reportLinkLabel: null,
      });
    },
  );

  it("the advisory wording has no dashes and none of the words the card must not say", () => {
    const text = Object.values(getFindingCardCopy(ADVISORY)).join(" ");
    expect(text).not.toMatch(/[—–]/);
    expect(text).not.toMatch(/remove|removal|leftover|malicious|compromised|hijack|signature/i);
    expect(text).not.toMatch(/your (store|checkout) (is|was)/i);
  });
});

describe("splitNumberedSteps", () => {
  it("splits the advisory how-to into its five steps, numbers dropped, text untouched", () => {
    expect(splitNumberedSteps(getFindingRemediation(ADVISORY))).toEqual([
      "Open your store in a private (incognito) window, add a product to the cart and click the ordinary Checkout button.",
      "Read the address bar before typing anything. It should start with a domain listed under Settings, Domains in your Shopify admin.",
      "Shop Pay, PayPal and similar buttons open their own sites. That is normal.",
      "If the page asking for contact, shipping or card details is on any other address, do not enter card details. Contact Shopify Support and the app developer.",
      "If you no longer use the app, remove its script line from the theme file shown here (duplicate your theme first). If you still use it, ask the developer whether this affects you.",
    ]);
  });

  it("the string stays the source of truth: the steps rebuild it exactly", () => {
    const howTo = getFindingRemediation(ADVISORY);
    const steps = splitNumberedSteps(howTo)!;
    expect(steps.map((step, i) => `${i + 1}. ${step}`).join(" ")).toBe(howTo);
  });

  it.each(ALL_TYPES.filter((t) => t !== ADVISORY))(
    "%s: its how-to is not a numbered list, so its card renders the string as before",
    (type) => {
      expect(splitNumberedSteps(getFindingRemediation(type))).toBeNull();
    },
  );

  it.each([
    ["", null],
    ["Just one sentence.", null],
    ["1. Only one step.", null],
    ["2. Starts at two. 3. Then three.", null],
    ["Intro first. 1. Then a step. 2. Another.", null],
    ["1. First. 2. ", null],
    ["1. First. 2. Second.", ["First.", "Second."]],
    ["1. First.  2.  Second. ", ["First.", "Second."]],
    ["1. A. 2. B. 3. C.", ["A.", "B.", "C."]],
    // A number that is out of order is part of the step's text.
    ["1. Wait 3. minutes. 2. Then go.", ["Wait 3. minutes.", "Then go."]],
    ["1. Use v1.2. now. 2. Done.", ["Use v1.2. now.", "Done."]],
    ["1. A. 2. B. 4. C.", ["A.", "B. 4. C."]],
    ["1. Before March 1, 2027. 2. After.", ["Before March 1, 2027.", "After."]],
  ])("splitNumberedSteps(%j)", (input, expected) => {
    expect(splitNumberedSteps(input)).toEqual(expected);
  });

  it("handles ten or more steps", () => {
    const howTo = Array.from({ length: 12 }, (_, i) => `${i + 1}. Step ${i + 1}.`).join(" ");
    expect(splitNumberedSteps(howTo)).toHaveLength(12);
  });
});

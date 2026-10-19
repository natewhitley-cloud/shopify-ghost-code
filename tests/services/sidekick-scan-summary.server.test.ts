/**
 * Tests for app/services/sidekick-scan-summary.server.ts (Sidekick data
 * extension, gc-5nok; reused from the spike's test). The models and the theme
 * cache (the Admin API edge) are mocked with an in-memory scan that honors
 * each read's filters / order / take, so the REAL plan gating, ignore filter,
 * Free preview, top-findings ranking and theme health checklist all run. No
 * database is touched.
 */
import type { FindingType, Severity } from "@prisma/client";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../app/models/finding.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/models/finding.server")>();
  return {
    // The REAL pure zero maps (used by the summary aggregates).
    createZeroSeverityCounts: actual.createZeroSeverityCounts,
    createZeroTypeCounts: actual.createZeroTypeCounts,
    getFindingSummary: vi.fn(),
    getFindingsForScan: vi.fn(),
    getTopFindingsOfTypes: vi.fn(),
    getTypeSeverityCountsForScan: vi.fn(),
    getTopFindingsInGroup: vi.fn(),
    getTypeCountsForScan: vi.fn(),
  };
});
vi.mock("../../app/models/scan.server", () => ({
  getScansForShop: vi.fn(),
  getCompletedScansForShop: vi.fn(),
  getScanById: vi.fn(),
  getLatestScanFindingCountsByTheme: vi.fn(),
}));
vi.mock("../../app/models/shop.server", () => ({ getShopMetadata: vi.fn() }));
vi.mock("../../app/models/ignored-finding.server", () => ({ getIgnoredFindingsForShop: vi.fn() }));
vi.mock("../../app/services/theme-cache.server", () => ({
  getCachedMainTheme: vi.fn(),
  getCachedAllThemes: vi.fn(),
}));

import { getPlanFeatures } from "../../app/lib/billing.server";
import { findingTypesWithheldByPlan } from "../../app/lib/plan-finding-types";
import * as findingModel from "../../app/models/finding.server";
import { getIgnoredFindingsForShop } from "../../app/models/ignored-finding.server";
import {
  getCompletedScansForShop,
  getLatestScanFindingCountsByTheme,
  getScanById,
  getScansForShop,
} from "../../app/models/scan.server";
import { getShopMetadata } from "../../app/models/shop.server";
import { getFreePreviewFindings } from "../../app/services/free-preview.server";
import { detectAppIncidentAdvisories } from "../../app/services/scan-engine.server";
import {
  FIRST_SCAN_RUNNING_MESSAGE,
  getSidekickScanSummary,
  MALICIOUS_VERDICT,
  MAX_MALICIOUS_LISTED,
  NO_COMPLETED_SCAN_MESSAGE,
  NO_SCANS_MESSAGE,
  PLAN_GAP_REASON,
} from "../../app/services/sidekick-scan-summary.server";
import { getCachedAllThemes, getCachedMainTheme } from "../../app/services/theme-cache.server";

const mockShop = vi.mocked(getShopMetadata);
const mockLatest = vi.mocked(getScansForShop);
const mockCompleted = vi.mocked(getCompletedScansForShop);
const mockScanById = vi.mocked(getScanById);
const mockIgnores = vi.mocked(getIgnoredFindingsForShop);
const mockMainTheme = vi.mocked(getCachedMainTheme);
const mockAllThemes = vi.mocked(getCachedAllThemes);

const admin = { graphql: vi.fn() };

type Row = {
  id: string;
  findingType: FindingType;
  severity: Severity;
  createdAt: Date;
  filename: string;
  lineNumber: number;
  codeSnippet: string;
  appName: string | null;
  description: string;
};

const SNIPPET_SECRET = "SECRET_THEME_SOURCE_DO_NOT_LEAK";

function f(
  id: string,
  findingType: FindingType,
  severity: Severity,
  extra: Partial<Row> = {},
): Row {
  return {
    id,
    findingType,
    severity,
    createdAt: new Date(Date.UTC(2026, 8, 1, 0, Number(id.replace(/\D/g, "")) || 0)),
    filename: `snippets/${id}.liquid`,
    lineNumber: 3,
    codeSnippet: `${SNIPPET_SECRET} ${id}`,
    appName: null,
    description: `References evil-${id}.example (reported skimmer).`,
    ...extra,
  };
}

const SEV: Record<Severity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
const dbOrder = (a: Row, b: Row) =>
  SEV[a.severity] - SEV[b.severity] ||
  a.createdAt.getTime() - b.createdAt.getTime() ||
  (a.id < b.id ? -1 : 1);

/** Back the mocked finding model with an in-memory scan. */
function serveScan(rows: Row[]) {
  const m = vi.mocked(findingModel);
  m.getFindingSummary.mockImplementation((async () => {
    const bySeverity = findingModel.createZeroSeverityCounts();
    const byType = findingModel.createZeroTypeCounts();
    for (const r of rows) {
      bySeverity[r.severity] += 1;
      byType[r.findingType] += 1;
    }
    return { total: rows.length, bySeverity, byType };
  }) as never);
  m.getTypeCountsForScan.mockImplementation((async () => {
    const byType = findingModel.createZeroTypeCounts();
    for (const r of rows) byType[r.findingType] += 1;
    return byType;
  }) as never);
  m.getFindingsForScan.mockImplementation((async (
    _s: string,
    filters?: { findingType?: FindingType },
  ) =>
    rows
      .filter((r) => !filters?.findingType || r.findingType === filters.findingType)
      .sort(dbOrder)) as never);
  m.getTopFindingsOfTypes.mockImplementation((async (
    _s: string,
    types: FindingType[],
    take: number,
  ) =>
    rows
      .filter((r) => types.includes(r.findingType) && r.findingType !== "MALICIOUS_SCRIPT")
      .sort(dbOrder)
      .slice(0, take)) as never);
  m.getTopFindingsInGroup.mockImplementation((async (
    _s: string,
    type: FindingType,
    severity: Severity | null,
    take: number,
  ) =>
    rows
      .filter((r) => r.findingType === type && (severity === null || r.severity === severity))
      .sort(dbOrder)
      .slice(0, take)) as never);
  m.getTypeSeverityCountsForScan.mockImplementation((async () => {
    const groups = new Map<
      string,
      { findingType: FindingType; severity: Severity; count: number }
    >();
    for (const r of rows) {
      const k = `${r.findingType}|${r.severity}`;
      const e = groups.get(k) ?? { findingType: r.findingType, severity: r.severity, count: 0 };
      e.count += 1;
      groups.set(k, e);
    }
    return [...groups.values()];
  }) as never);
}

/**
 * A stored Selleasy advisory as the REAL detector writes it (embed signal):
 * appName null, the app named only through the curated entry its description
 * matches. ACTIVE is a fixed date inside the entry's review window.
 */
const ACTIVE = new Date("2026-10-20T12:00:00Z");
function selleasyAdvisory(id: string): Row {
  const [finding] = detectAppIncidentAdvisories(
    [
      {
        filename: "config/settings_data.json",
        content: JSON.stringify({
          current: {
            blocks: {
              selleasy: {
                type: "shopify://apps/selleasy/blocks/app-embed/790c1a03-a71f-4bc1-9869-00dad526d3c2",
                disabled: false,
                settings: {},
              },
            },
          },
        }),
      },
    ],
    ACTIVE,
  );
  if (!finding) throw new Error("the detector found no Selleasy advisory");
  return f(id, "APP_INCIDENT_ADVISORY", finding.severity as Severity, {
    filename: finding.filename,
    lineNumber: finding.lineNumber ?? 1,
    codeSnippet: finding.codeSnippet,
    appName: finding.appName ?? null,
    description: finding.description,
  });
}
const SELLEASY_REPORT = "On 13 October 2026, Logbase (Selleasy's developer) reported";

const COMPLETED_AT = new Date("2026-09-30T12:00:00.000Z");
const SCAN = {
  id: "scan_1",
  status: "COMPLETED",
  completedAt: COMPLETED_AT,
  createdAt: new Date("2026-09-30T11:58:00.000Z"),
  themeId: "gid://shopify/OnlineStoreTheme/1",
  themeName: "Dawn",
  skippedCategories: [] as string[],
  cappedCategories: [] as string[],
  unreachableCategories: [] as string[],
  liveFindingTypes: null as unknown,
  themeInfo: { name: "Dawn", version: "15.2.0", author: "Shopify", architecture: "os2" },
};
const NO_IGNORES = { fingerprints: new Set<string>(), appNames: new Set<string>() };

function setShop(plan: string) {
  mockShop.mockResolvedValue({ id: "shop_1", domain: "a.myshopify.com", plan } as never);
}

function setLatest(items: unknown[]) {
  mockLatest.mockResolvedValue({ items, hasNextPage: false } as never);
}

beforeEach(() => {
  vi.resetAllMocks();
  setShop("Standard");
  setLatest([SCAN]);
  mockCompleted.mockResolvedValue([
    { id: SCAN.id, completedAt: SCAN.completedAt, themeName: SCAN.themeName },
  ]);
  mockIgnores.mockResolvedValue(NO_IGNORES);
  mockMainTheme.mockResolvedValue({ id: SCAN.themeId, name: "Dawn" } as never);
  mockAllThemes.mockResolvedValue([
    { id: SCAN.themeId, name: "Dawn", role: "MAIN" },
    { id: "gid://shopify/OnlineStoreTheme/2", name: "Old", role: "UNPUBLISHED" },
  ] as never);
  vi.mocked(getLatestScanFindingCountsByTheme).mockResolvedValue(
    new Map([["gid://shopify/OnlineStoreTheme/2", 7]]),
  );
});

async function okSummary() {
  const result = await getSidekickScanSummary(admin, "a.myshopify.com");
  if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
  return result;
}

describe("getSidekickScanSummary: full-list plans (Standard, Professional)", () => {
  // Stored advisories are shown only while their flag is on (gc-5nok kill switch).
  beforeEach(() => {
    process.env.APP_INCIDENT_ADVISORY_LIVE_ENABLED = "true";
  });
  afterEach(() => {
    delete process.env.APP_INCIDENT_ADVISORY_LIVE_ENABLED;
  });

  it.each(["Standard", "Professional"])(
    "%s: date, theme, counts by impact area, top findings and an app:// link",
    async (plan) => {
      setShop(plan);
      serveScan([
        f("a1", "GHOST_SCRIPT", "HIGH", { appName: "OldApp" }),
        f("a2", "GHOST_STYLE", "MEDIUM"),
        f("a3", "GHOST_SNIPPET", "LOW"),
        f("a4", "GHOST_SNIPPET", "LOW"),
      ]);
      const r = await okSummary();
      expect(r.scanDate).toBe("2026-09-30T12:00:00.000Z");
      expect(r.themeName).toBe("Dawn");
      expect(r.totalFindings).toBe(4);
      // Consequence lanes in the app's display order, never severity.
      expect(r.byImpact).toEqual([
        {
          area: "Customers see it",
          count: 2,
          meaning: "Shoppers can see this on your live storefront right now.",
        },
        {
          area: "Speed",
          count: 2,
          meaning: "This is loading extra code that slows your storefront down.",
        },
      ]);
      expect(JSON.stringify(r)).not.toMatch(/severity/i);
      expect(r.topFindings).toHaveLength(3);
      expect(r.topFindings[0]).toMatchObject({ impact: "Speed", app: "OldApp" });
      expect(r.topFindings[0].location).toBe("snippets/a1.liquid, line 3");
      expect(r.maliciousCode).toEqual({ found: 0, findings: [], moreNotListed: false });
      expect(r.appSecurityAdvisories).toBe(0);
      expect(r.url).toBe("app://app/scans/scan_1");
      expect(r.newerScanInProgress).toBe(false);
      // The latest scan row is the full scan: no second read.
      expect(mockScanById).not.toHaveBeenCalled();
    },
  );

  it("returns only allow-listed fields (no ids, hrefs, severity or code)", async () => {
    serveScan([f("a1", "GHOST_SCRIPT", "HIGH"), f("m1", "MALICIOUS_SCRIPT", "HIGH")]);
    const r = await okSummary();
    expect(Object.keys(r).sort()).toEqual([
      "appSecurityAdvisories",
      "byImpact",
      "maliciousCode",
      "newerScanInProgress",
      "scanDate",
      "status",
      "themeHealth",
      "themeName",
      "topFindings",
      "totalFindings",
      "url",
    ]);
    for (const t of r.topFindings) {
      expect(Object.keys(t).sort()).toEqual(["app", "description", "impact", "location", "type"]);
    }
    expect(Object.keys(r.maliciousCode.findings[0]).sort()).toEqual([
      "app",
      "description",
      "location",
    ]);
    expect(Object.keys(r.themeHealth!).sort()).toEqual([
      "checksNotFullyRun",
      "cleanChecks",
      "theme",
      "unpublishedThemes",
      "verdict",
    ]);
    const json = JSON.stringify(r);
    expect(json).not.toContain("codeSnippet");
    expect(json).not.toContain(SNIPPET_SECRET);
    expect(json).not.toContain("href");
    expect(json).not.toContain("/app/scans/scan_1?");
    expect(json).not.toMatch(/"id"/);
  });

  it("excludes ignored findings from counts and top findings", async () => {
    serveScan([
      f("a1", "GHOST_SCRIPT", "HIGH", { appName: "IgnoredApp" }),
      f("a2", "GHOST_STYLE", "MEDIUM", { appName: "KeptApp" }),
    ]);
    mockIgnores.mockResolvedValue({ fingerprints: new Set(), appNames: new Set(["IgnoredApp"]) });
    const r = await okSummary();
    expect(r.totalFindings).toBe(1);
    expect(r.byImpact.map((i) => [i.area, i.count])).toEqual([["Speed", 1]]);
    expect(r.topFindings.map((t) => t.app)).toEqual(["KeptApp"]);
  });

  it("labels an affected-app advisory (in no impact area) as a security advisory", async () => {
    const advisory = selleasyAdvisory("v1");
    // A real stored advisory carries no appName: the entry must supply it.
    expect(advisory.appName).toBeNull();
    serveScan([advisory, f("a2", "GHOST_STYLE", "LOW")]);
    const r = await okSummary();
    expect(r.appSecurityAdvisories).toBe(1);
    expect(r.topFindings[0]).toMatchObject({ impact: "Security advisory", app: "Selleasy" });
    expect(r.byImpact.map((i) => i.area)).toEqual(["Speed"]);
  });

  it("names the advisory's app and uses the entry's own report wording, as Home does (gc-q5z8)", async () => {
    serveScan([selleasyAdvisory("v1"), f("a2", "GHOST_STYLE", "LOW")]);
    const r = await okSummary();
    const [top] = r.topFindings;
    expect(top.type).toBe("Selleasy is in your theme and was named in a security incident");
    expect(top.app).toBe("Selleasy");
    expect(top.description.startsWith(SELLEASY_REPORT)).toBe(true);
    expect(top.description).not.toContain("An app in your theme");
  });

  it("kill switch (gc-5nok): with the flag off a stored advisory is not reported at all", async () => {
    delete process.env.APP_INCIDENT_ADVISORY_LIVE_ENABLED;
    serveScan([
      selleasyAdvisory("v1"),
      f("m1", "MALICIOUS_SCRIPT", "HIGH"),
      f("a2", "GHOST_STYLE", "LOW"),
    ]);
    const r = await okSummary();
    expect(r.appSecurityAdvisories).toBe(0);
    expect(r.topFindings.map((t) => t.impact)).not.toContain("Security advisory");
    // Nothing anywhere in the result names the app (the flag-on case above does).
    expect(JSON.stringify(r)).not.toContain("Selleasy");
    // The advisory is out of the total; malicious code is untouched.
    expect(r.totalFindings).toBe(2);
    expect(r.maliciousCode.found).toBe(1);
  });
});

describe("getSidekickScanSummary: Free plan", () => {
  beforeEach(() => setShop("free"));

  it("returns only findings the Free scan page already shows in full (preview rows)", async () => {
    const rows = [
      f("a1", "GHOST_SCRIPT", "HIGH"),
      f("a2", "GHOST_STYLE", "MEDIUM"),
      f("a3", "GHOST_SNIPPET", "LOW"),
      f("a4", "GHOST_SECTION", "LOW"),
    ];
    serveScan(rows);
    const r = await okSummary();
    const preview = await getFreePreviewFindings(
      "scan_1",
      { GHOST_SCRIPT: 1, GHOST_STYLE: 1, GHOST_SNIPPET: 1, GHOST_SECTION: 1 } as never,
      null,
      findingTypesWithheldByPlan(getPlanFeatures("free")),
    );
    const previewLocations = preview.map((p) => `snippets/${p.id}.liquid, line 3`);
    expect(r.topFindings.length).toBeGreaterThan(0);
    for (const t of r.topFindings) expect(previewLocations).toContain(t.location);
    // Non-vacuous: Free hides some findings, so it returns fewer than Standard would.
    expect(r.topFindings.length).toBeLessThan(3);
    // The counts are the ones Free's Home tiles and lanes show.
    expect(r.totalFindings).toBe(4);
    expect(r.byImpact.reduce((n, i) => n + i.count, 0)).toBe(4);
  });

  it("shows a single finding in full (a scan of 2 previews exactly 1)", async () => {
    serveScan([f("a1", "GHOST_SCRIPT", "HIGH"), f("a2", "GHOST_STYLE", "LOW")]);
    const r = await okSummary();
    expect(r.topFindings).toHaveLength(1);
  });

  it("returns malicious findings IN FULL on Free, even when they are not preview rows", async () => {
    serveScan([
      f("a1", "GHOST_SCRIPT", "HIGH"),
      f("a2", "GHOST_STYLE", "LOW"),
      f("a3", "MALICIOUS_SCRIPT", "HIGH", { appName: "Shady" }),
    ]);
    const r = await okSummary();
    expect(r.maliciousCode).toEqual({
      found: 1,
      findings: [
        {
          location: "snippets/a3.liquid, line 3",
          app: "Shady",
          description: "References evil-a3.example (reported skimmer).",
        },
      ],
      moreNotListed: false,
    });
    expect(r.topFindings.map((t) => t.location)).toContain("snippets/a3.liquid, line 3");
    expect(r.themeHealth?.verdict).toBe(MALICIOUS_VERDICT);
  });

  it("lists an IGNORED malicious finding in maliciousCode (as the scan page's alert does), not in top findings", async () => {
    serveScan([f("a1", "MALICIOUS_SCRIPT", "HIGH", { appName: "BadApp" })]);
    mockIgnores.mockResolvedValue({ fingerprints: new Set(), appNames: new Set(["BadApp"]) });
    const r = await okSummary();
    expect(r.topFindings).toEqual([]);
    // Home's findings tile adds ignored malicious findings back: never 0 here.
    expect(r.totalFindings).toBe(1);
    expect(r.byImpact).toEqual([]);
    expect(r.maliciousCode.found).toBe(1);
    expect(r.maliciousCode.findings.map((m) => m.app)).toEqual(["BadApp"]);
    expect(r.themeHealth?.verdict).toBe(MALICIOUS_VERDICT);
  });

  it("does not return a plan-withheld finding type (downgraded shop)", async () => {
    serveScan([f("a1", "DANGLING_REFERENCE", "HIGH"), f("a2", "GHOST_STYLE", "LOW")]);
    const r = await okSummary();
    expect(r.topFindings.map((t) => t.location)).not.toContain("snippets/a1.liquid, line 3");
  });

  it("never names a plan in a theme health reason (no plan pitch through Sidekick)", async () => {
    const { FindingType } = await import("@prisma/client");
    setLatest([{ ...SCAN, liveFindingTypes: Object.values(FindingType) }]);
    serveScan([f("a2", "GHOST_STYLE", "LOW")]);
    const r = await okSummary();
    const reasons = r.themeHealth!.checksNotFullyRun.map((g) => g.reason);
    // Non-vacuous: Free has plan-withheld checks, so a plan reason exists.
    expect(reasons).toContain(PLAN_GAP_REASON);
    expect(JSON.stringify(r)).not.toMatch(/\b(Standard|Professional|upgrade)\b/i);
  });
});

describe("getSidekickScanSummary: malicious code on every plan", () => {
  it.each(["free", "Standard", "Professional"])(
    "%s: lists at most MAX_MALICIOUS_LISTED and says more were found",
    async (plan) => {
      setShop(plan);
      const rows = Array.from({ length: MAX_MALICIOUS_LISTED + 2 }, (_, i) =>
        f(`m${i + 1}`, "MALICIOUS_SCRIPT", "HIGH"),
      );
      serveScan(rows);
      const r = await okSummary();
      expect(r.maliciousCode.found).toBe(MAX_MALICIOUS_LISTED + 2);
      expect(r.maliciousCode.findings).toHaveLength(MAX_MALICIOUS_LISTED);
      expect(r.maliciousCode.moreNotListed).toBe(true);
    },
  );
});

describe("getSidekickScanSummary: theme health", () => {
  it("folds in Home's verdict, clean checks and theme rows", async () => {
    serveScan([f("a2", "GHOST_STYLE", "LOW")]);
    const r = await okSummary();
    const h = r.themeHealth!;
    // Legacy scan (no recorded live types): Home's "couldn't run" verdict.
    expect(h.verdict).toBe("Some checks couldn't run, including the check for malicious code.");
    expect(h.checksNotFullyRun.length).toBeGreaterThan(0);
    expect(h.theme).toBe("Online Store 2.0: Dawn 15.2.0 by Shopify");
    expect(h.unpublishedThemes).toBe(
      "Your store has 2 themes. Shopify allows 20 (more on Plus). In their last scans: Old: 7 findings.",
    );
  });

  it("says no known malicious code was found only when that check ran in full", async () => {
    const { FindingType } = await import("@prisma/client");
    setLatest([{ ...SCAN, liveFindingTypes: Object.values(FindingType) }]);
    serveScan([f("a2", "GHOST_STYLE", "LOW")]);
    const r = await okSummary();
    expect(r.themeHealth!.verdict).toMatch(/^No known malicious code found\./);
    expect(r.themeHealth!.cleanChecks).toContain("Known malicious code");
  });

  it("still answers when the theme list cannot be read (the theme library line is dropped)", async () => {
    mockMainTheme.mockRejectedValue(new Error("Admin API down"));
    mockAllThemes.mockRejectedValue(new Error("Admin API down"));
    serveScan([f("a2", "GHOST_STYLE", "LOW")]);
    const r = await okSummary();
    expect(r.themeHealth?.unpublishedThemes).toBeNull();
    expect(r.themeHealth?.theme).toBe("Online Store 2.0: Dawn 15.2.0 by Shopify");
  });
});

describe("getSidekickScanSummary: states", () => {
  it("shop row missing: no_data", async () => {
    mockShop.mockResolvedValue(null);
    expect(await getSidekickScanSummary(admin, "gone.myshopify.com")).toEqual({
      status: "no_data",
      message: NO_SCANS_MESSAGE,
    });
  });

  it("no scans yet: no_data, and no finding is read", async () => {
    setLatest([]);
    mockCompleted.mockResolvedValue([]);
    expect(await getSidekickScanSummary(admin, "a.myshopify.com")).toEqual({
      status: "no_data",
      message: NO_SCANS_MESSAGE,
    });
    expect(findingModel.getFindingSummary).not.toHaveBeenCalled();
  });

  it("first scan still running", async () => {
    setLatest([{ id: "s0", status: "IN_PROGRESS" }]);
    mockCompleted.mockResolvedValue([]);
    expect(await getSidekickScanSummary(admin, "a.myshopify.com")).toEqual({
      status: "no_data",
      message: FIRST_SCAN_RUNNING_MESSAGE,
    });
  });

  it("only failed scans: no_data, never zero counts", async () => {
    setLatest([{ id: "s0", status: "FAILED" }]);
    mockCompleted.mockResolvedValue([]);
    const r = await getSidekickScanSummary(admin, "a.myshopify.com");
    expect(r).toEqual({ status: "no_data", message: NO_COMPLETED_SCAN_MESSAGE });
    expect(JSON.stringify(r)).not.toMatch(/totalFindings|byImpact/);
  });

  it("latest scan failed after a successful one: summarizes the successful scan", async () => {
    setLatest([{ id: "scan_2", status: "FAILED" }]);
    mockScanById.mockResolvedValue(SCAN as never);
    serveScan([f("a1", "GHOST_SCRIPT", "HIGH")]);
    const r = await okSummary();
    expect(mockScanById).toHaveBeenCalledWith("scan_1", { includeFindings: false });
    expect(r.url).toBe("app://app/scans/scan_1");
    expect(r.newerScanInProgress).toBe(false);
  });

  it("newer scan running: summarizes the older successful scan and says so", async () => {
    setLatest([{ id: "scan_2", status: "IN_PROGRESS" }]);
    mockScanById.mockResolvedValue(SCAN as never);
    serveScan([f("a1", "GHOST_SCRIPT", "HIGH")]);
    const r = await okSummary();
    expect(r.newerScanInProgress).toBe(true);
    expect(r.url).toBe("app://app/scans/scan_1");
  });

  it("no findings: zero counts and an empty top list", async () => {
    serveScan([]);
    const r = await okSummary();
    expect(r.totalFindings).toBe(0);
    expect(r.byImpact).toEqual([]);
    expect(r.topFindings).toEqual([]);
  });
});

describe("getSidekickScanSummary: response size", () => {
  it.each(["free", "Professional"])(
    "%s: a large scan stays far under Sidekick's 4,000-token limit",
    async (plan) => {
      setShop(plan);
      const long = "x".repeat(400);
      const types: FindingType[] = [
        "GHOST_SCRIPT",
        "GHOST_STYLE",
        "GHOST_SNIPPET",
        "GHOST_SECTION",
        "DANGLING_REFERENCE",
      ];
      const rows: Row[] = [];
      for (let i = 0; i < 500; i += 1) {
        rows.push(
          f(`r${i}`, types[i % types.length], (["HIGH", "MEDIUM", "LOW"] as const)[i % 3], {
            appName: `Some Long App Name ${i}`,
            filename: `sections/a-very-long-section-file-name-${i}.liquid`,
          }),
        );
      }
      for (let i = 0; i < 30; i += 1) {
        rows.push(f(`m${i}`, "MALICIOUS_SCRIPT", "HIGH", { description: `${long} ${i}` }));
      }
      serveScan(rows);
      const json = JSON.stringify({ results: [await okSummary()] });
      // ~4 characters per token, conservative; keep well under the limit.
      expect(Math.ceil(json.length / 4)).toBeLessThan(2500);
    },
  );
});

/**
 * Affected-app advisory (gc-14x5): the service-level product rules.
 *
 *   1. Never paywalled: the Free preview read, the Free always-shown list and
 *      Free's "Start here" (free-preview.server, top-findings.server).
 *   2. Honours ignores, unlike MALICIOUS_SCRIPT (finding-aggregation, the
 *      summary email's counts).
 *   3. Ranked below malicious code and above everything else by the bounded
 *      "Start here" reads.
 *   6. Diffs like any other finding type, and is never "new" against a scan
 *      taken before the type was live (scan-differ).
 *
 * Also: an advisory is never an app's leftover (app-removal). The finding
 * model is mocked with an in-memory scan; everything else runs for real.
 */
import { FindingType } from "@prisma/client";
import type { Severity } from "@prisma/client";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../app/models/finding.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/models/finding.server")>();
  return {
    // Pure zero-seeded counters: used for real by finding-aggregation.
    createZeroSeverityCounts: actual.createZeroSeverityCounts,
    createZeroTypeCounts: actual.createZeroTypeCounts,
    getFindingsForScan: vi.fn(),
    getFindingSummary: vi.fn(),
    getTopFindingsOfTypes: vi.fn(),
    getTopFindingsInGroup: vi.fn(),
    getTypeSeverityCountsForScan: vi.fn(),
  };
});

import { APP_SIGNATURES } from "../../app/data/app-signatures.server";
import { isNeverPaywalledFindingType } from "../../app/lib/finding-classification";
import { freePreviewCount } from "../../app/lib/free-preview";
import { pickTopFindings } from "../../app/lib/top-findings";
import {
  getFindingsForScan,
  getTopFindingsInGroup,
  getTopFindingsOfTypes,
  getTypeSeverityCountsForScan,
} from "../../app/models/finding.server";
import {
  appLeftoverFindings,
  computeAppSignatureFingerprints,
  detectAppRemovals,
} from "../../app/services/app-removal.server";
import {
  filterIgnoredExceptMalicious,
  filterIgnoredFindings,
  getFilteredFindingSummaryAndKept,
  isFindingIgnored,
} from "../../app/services/finding-aggregation.server";
import {
  getFreeAlwaysShownFindings,
  getFreePreviewFindings,
  PREVIEW_READ_BUCKETS,
} from "../../app/services/free-preview.server";
import {
  diffScans,
  fingerprintFinding,
  scanDiffOptions,
  unauditedCategories,
} from "../../app/services/scan-differ.server";
import { computeFindingChanges } from "../../app/services/summary-email.server";
import {
  getFreeTopFindings,
  getFullListTopFindings,
  planTopFindingReads,
} from "../../app/services/top-findings.server";

const mockAll = getFindingsForScan as ReturnType<typeof vi.fn>;
const mockGroup = getTopFindingsInGroup as ReturnType<typeof vi.fn>;
const mockOfTypes = getTopFindingsOfTypes as ReturnType<typeof vi.fn>;
const mockCounts = getTypeSeverityCountsForScan as ReturnType<typeof vi.fn>;

const ADVISORY = FindingType.APP_INCIDENT_ADVISORY;
const ALL_TYPES = Object.values(FindingType) as string[];
const TAG = '<script src="https://productoption.hulkapps.com/hulkcode.js"></script>';
const DESCRIPTION =
  "Loads code from Hulk Product Options (productoption.hulkapps.com), an app named in a public report of shoppers being sent to a fake checkout page (10 October 2026)";

type Row = {
  id: string;
  scanId: string;
  findingType: FindingType;
  severity: Severity;
  createdAt: Date;
  filename: string;
  lineNumber: number;
  codeSnippet: string;
  appName: string | null;
  description: string;
};

function f(
  id: string,
  findingType: FindingType,
  severity: Severity = "HIGH",
  over: Partial<Row> = {},
): Row {
  return {
    id,
    scanId: "scan-1",
    findingType,
    severity,
    createdAt: new Date(Date.UTC(2026, 9, 12, 0, 0)),
    filename: `snippets/${id}.liquid`,
    lineNumber: 1,
    codeSnippet: id,
    appName: null,
    description: id,
    ...over,
  };
}

/** The advisory as the detector stores it. */
const advisory = (id = "adv", over: Partial<Row> = {}) =>
  f(id, ADVISORY, "HIGH", {
    filename: "layout/theme.liquid",
    lineNumber: 42,
    codeSnippet: TAG,
    description: DESCRIPTION,
    ...over,
  });

const SEV: Record<Severity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
const dbOrder = (a: Row, b: Row) =>
  SEV[a.severity] - SEV[b.severity] ||
  a.createdAt.getTime() - b.createdAt.getTime() ||
  (a.id < b.id ? -1 : 1);

/** Back the mocked model with an in-memory scan, honouring where / order / take. */
function serveScan(rows: Row[]) {
  mockCounts.mockImplementation(async () => {
    const m = new Map<string, { findingType: FindingType; severity: Severity; count: number }>();
    for (const r of rows) {
      const k = `${r.findingType}|${r.severity}`;
      const e = m.get(k) ?? { findingType: r.findingType, severity: r.severity, count: 0 };
      e.count += 1;
      m.set(k, e);
    }
    return [...m.values()];
  });
  mockGroup.mockImplementation(
    async (_s: string, type: FindingType, severity: Severity | null, take: number) =>
      rows
        .filter((r) => r.findingType === type && (severity === null || r.severity === severity))
        .sort(dbOrder)
        .slice(0, take),
  );
  // The real model drops never-paywalled types (tests/models/finding.server.test.ts).
  mockOfTypes.mockImplementation(async (_s: string, types: FindingType[], take: number) =>
    rows
      .filter((r) => types.includes(r.findingType) && !isNeverPaywalledFindingType(r.findingType))
      .sort(dbOrder)
      .slice(0, take),
  );
  mockAll.mockImplementation(async (_s: string, filters?: { findingType?: FindingType }) =>
    rows.filter((r) => filters?.findingType === undefined || r.findingType === filters.findingType),
  );
}

function byTypeOf(rows: Row[]): Partial<Record<FindingType, number>> {
  const out: Partial<Record<FindingType, number>> = {};
  for (const r of rows) out[r.findingType] = (out[r.findingType] ?? 0) + 1;
  return out;
}

const ids = (rows: ReadonlyArray<{ id: string }>) => rows.map((r) => r.id);
const NO_IGNORES = { fingerprints: new Set<string>(), appNames: new Set<string>() };
const ignoring = (...rows: Row[]) => ({
  fingerprints: new Set(
    rows.map((r) => fingerprintFinding(r.filename, r.findingType, r.codeSnippet, r.lineNumber)),
  ),
  appNames: new Set<string>(),
});

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// Rule 1: never paywalled (Free plan)
// ---------------------------------------------------------------------------

describe("never paywalled: the Free preview read (free-preview.server.ts)", () => {
  it("no (lane, urgency) read bucket holds a never-paywalled type", () => {
    const bucketed = PREVIEW_READ_BUCKETS.flat();
    expect(bucketed).not.toContain(ADVISORY);
    expect(bucketed).not.toContain("MALICIOUS_SCRIPT");
  });

  it("an advisory does not raise the preview count: 2 scripts + 1 advisory still shows 1 row", async () => {
    const rows = [f("s1", "GHOST_SCRIPT"), f("s2", "GHOST_SCRIPT"), advisory()];
    serveScan(rows);

    const preview = await getFreePreviewFindings("scan-1", byTypeOf(rows), null, []);

    // total = 2 (the advisory is outside the formula) -> floor(2 / 2) = 1.
    expect(freePreviewCount(2)).toBe(1);
    expect(ids(preview)).toEqual(["s1"]);
    for (const call of mockOfTypes.mock.calls) expect(call[1]).not.toContain(ADVISORY);
  });

  it("a scan whose only finding is an advisory has no preview rows and reads nothing", async () => {
    serveScan([advisory()]);

    await expect(
      getFreePreviewFindings("scan-1", { APP_INCIDENT_ADVISORY: 1 }, null, []),
    ).resolves.toEqual([]);
    expect(mockOfTypes).not.toHaveBeenCalled();
  });

  it("skips a lane whose only findings are never paywalled (advisory + malicious, both privacy)", async () => {
    const rows = [
      f("s1", "GHOST_SCRIPT"),
      f("s2", "GHOST_SCRIPT"),
      advisory(),
      f("m", "MALICIOUS_SCRIPT"),
    ];
    serveScan(rows);

    await getFreePreviewFindings("scan-1", byTypeOf(rows), null, []);

    expect(mockOfTypes).toHaveBeenCalledTimes(1);
    expect(mockOfTypes.mock.calls[0][1]).toContain("GHOST_SCRIPT");
  });

  it("with ignores (kept rows passed in) an advisory is never picked either", async () => {
    const kept = [
      advisory(),
      f("s1", "GHOST_SCRIPT"),
      f("s2", "GHOST_SCRIPT"),
      f("p", "GHOST_PIXEL"),
    ];

    const preview = await getFreePreviewFindings("scan-1", byTypeOf(kept), kept as never, []);

    expect(ids(preview)).not.toContain("adv");
    // total = 3 -> 1 row.
    expect(preview).toHaveLength(1);
    expect(mockOfTypes).not.toHaveBeenCalled();
  });
});

describe("never paywalled: the Free always-shown list (getFreeAlwaysShownFindings)", () => {
  it("no ignores: reads every advisory of the scan, in full", async () => {
    const rows = [advisory(), f("s1", "GHOST_SCRIPT"), f("m", "MALICIOUS_SCRIPT")];
    serveScan(rows);

    const shown = await getFreeAlwaysShownFindings("scan-1", byTypeOf(rows), null);

    expect(shown).toEqual([advisory()]);
    expect(shown[0]).toMatchObject({
      filename: "layout/theme.liquid",
      lineNumber: 42,
      codeSnippet: TAG,
      description: DESCRIPTION,
    });
    expect(mockAll).toHaveBeenCalledTimes(1);
    expect(mockAll).toHaveBeenCalledWith("scan-1", { findingType: "APP_INCIDENT_ADVISORY" });
  });

  it("never returns malicious code (the security alert shows that, ignored or not)", async () => {
    const rows = [f("m1", "MALICIOUS_SCRIPT"), f("m2", "MALICIOUS_SCRIPT")];
    serveScan(rows);

    await expect(getFreeAlwaysShownFindings("scan-1", byTypeOf(rows), null)).resolves.toEqual([]);
    expect(mockAll).not.toHaveBeenCalled();
    await expect(
      getFreeAlwaysShownFindings("scan-1", byTypeOf(rows), rows as never),
    ).resolves.toEqual([]);
  });

  it("a scan without advisories issues no query", async () => {
    serveScan([f("s1", "GHOST_SCRIPT")]);

    await expect(getFreeAlwaysShownFindings("scan-1", { GHOST_SCRIPT: 1 }, null)).resolves.toEqual(
      [],
    );
    await expect(getFreeAlwaysShownFindings("scan-1", {}, null)).resolves.toEqual([]);
    await expect(
      getFreeAlwaysShownFindings("scan-1", { APP_INCIDENT_ADVISORY: 0 }, null),
    ).resolves.toEqual([]);
    expect(mockAll).not.toHaveBeenCalled();
  });

  it("with ignores: picks from the kept rows and issues no query", async () => {
    const kept = [f("s1", "GHOST_SCRIPT"), advisory(), f("m", "MALICIOUS_SCRIPT")];

    const shown = await getFreeAlwaysShownFindings("scan-1", byTypeOf(kept), kept as never);

    expect(ids(shown)).toEqual(["adv"]);
    expect(mockAll).not.toHaveBeenCalled();
  });

  it("HONOURS IGNORES: an ignored advisory is not in the kept rows, so it is not shown", async () => {
    const adv = advisory();
    const all = [adv, f("s1", "GHOST_SCRIPT")];
    const { kept } = filterIgnoredFindings(all, ignoring(adv));

    const shown = await getFreeAlwaysShownFindings("scan-1", byTypeOf(kept), kept as never);

    expect(shown).toEqual([]);
    expect(mockAll).not.toHaveBeenCalled();
  });

  it("orders several advisories by the shared ranking (oldest first, then id)", async () => {
    const rows = [
      advisory("b", { createdAt: new Date(Date.UTC(2026, 9, 12, 0, 5)) }),
      advisory("a", { createdAt: new Date(Date.UTC(2026, 9, 12, 0, 5)) }),
      advisory("z", { createdAt: new Date(Date.UTC(2026, 9, 12, 0, 1)) }),
    ];
    serveScan(rows);

    expect(ids(await getFreeAlwaysShownFindings("scan-1", byTypeOf(rows), null))).toEqual([
      "z",
      "a",
      "b",
    ]);
  });

  it("propagates a read failure", async () => {
    mockAll.mockRejectedValue(new Error("db down"));
    await expect(
      getFreeAlwaysShownFindings("scan-1", { APP_INCIDENT_ADVISORY: 1 }, null),
    ).rejects.toThrow("db down");
  });
});

describe("never paywalled: Free's Start here (getFreeTopFindings)", () => {
  it("a Free shop's top findings include the advisory, ranked first", async () => {
    // 10 paywalled findings -> 5 preview rows; the advisory is outside them.
    const rows = [
      ...Array.from({ length: 6 }, (_, i) =>
        f(`script${i}`, "GHOST_SCRIPT", "HIGH", {
          createdAt: new Date(Date.UTC(2026, 9, 12, 0, i)),
        }),
      ),
      f("snippet", "GHOST_SNIPPET", "LOW"),
      f("pixel", "GHOST_PIXEL", "LOW"),
      f("hreflang", "GHOST_HREFLANG", "LOW"),
      f("orphan", "ORPHAN_ASSET", "LOW"),
      advisory(),
    ];
    serveScan(rows);

    const top = await getFreeTopFindings("scan-1", byTypeOf(rows), null, []);

    expect(ids(top)[0]).toBe("adv");
    expect(top).toHaveLength(3);
    expect(mockGroup).toHaveBeenCalledWith("scan-1", "APP_INCIDENT_ADVISORY", null, 3);
  });

  it("malicious code first, then the advisory, then the best preview row", async () => {
    const rows = [
      f("s1", "GHOST_SCRIPT"),
      f("s2", "GHOST_SCRIPT"),
      advisory(),
      f("mal", "MALICIOUS_SCRIPT", "LOW"),
    ];
    serveScan(rows);

    expect(ids(await getFreeTopFindings("scan-1", byTypeOf(rows), null, []))).toEqual([
      "mal",
      "adv",
      "s1",
    ]);
  });

  it("an advisory alone (nothing else in the scan) is the whole block", async () => {
    serveScan([advisory()]);

    expect(ids(await getFreeTopFindings("scan-1", { APP_INCIDENT_ADVISORY: 1 }, null, []))).toEqual(
      ["adv"],
    );
  });

  it("reads the advisory group only when the scan has one", async () => {
    const rows = [f("a", "GHOST_SCRIPT"), f("b", "GHOST_PIXEL", "LOW")];
    serveScan(rows);

    await getFreeTopFindings("scan-1", byTypeOf(rows), null, []);

    expect(mockGroup).not.toHaveBeenCalled();
  });

  it("with loaded rows (the scan page) ranks malicious, the always-shown rows and the preview, reading nothing", async () => {
    const top = await getFreeTopFindings("scan-1", {}, null, [], {
      preview: [f("p1", "GHOST_SCRIPT", "HIGH"), f("p2", "ORPHAN_ASSET", "LOW")] as never,
      malicious: [f("m", "MALICIOUS_SCRIPT", "MEDIUM")] as never,
      alwaysShown: [advisory()] as never,
    });

    expect(ids(top)).toEqual(["m", "adv", "p1"]);
    expect(mockOfTypes).not.toHaveBeenCalled();
    expect(mockGroup).not.toHaveBeenCalled();
    expect(mockAll).not.toHaveBeenCalled();
  });

  it("loaded rows without `alwaysShown` behave exactly as before (malicious + preview)", async () => {
    const top = await getFreeTopFindings("scan-1", {}, null, [], {
      preview: [f("p1", "GHOST_SCRIPT", "HIGH")] as never,
      malicious: [f("m", "MALICIOUS_SCRIPT", "MEDIUM")] as never,
    });
    expect(ids(top)).toEqual(["m", "p1"]);
  });

  it("with ignores: an ignored advisory is gone, a kept one is ranked, and nothing is read", async () => {
    const adv = advisory();
    const all = [adv, f("s1", "GHOST_SCRIPT"), f("s2", "GHOST_SNIPPET")];

    const keptAll = filterIgnoredFindings(all, NO_IGNORES).kept;
    expect(
      ids(await getFreeTopFindings("scan-1", byTypeOf(keptAll), keptAll as never, [])),
    ).toContain("adv");

    const kept = filterIgnoredFindings(all, ignoring(adv)).kept;
    expect(
      ids(await getFreeTopFindings("scan-1", byTypeOf(kept), kept as never, [])),
    ).not.toContain("adv");
    expect(mockGroup).not.toHaveBeenCalled();
  });

  it("is never withheld by the plan's withheld types", async () => {
    const rows = [advisory(), f("d", "DANGLING_REFERENCE")];
    serveScan(rows);

    const top = await getFreeTopFindings("scan-1", byTypeOf(rows), null, [
      "DANGLING_REFERENCE",
      "CHECKOUT_SUNSET",
    ]);

    expect(ids(top)).toEqual(["adv"]);
  });
});

// ---------------------------------------------------------------------------
// Rule 3: ranking through the bounded reads (full-list plans)
// ---------------------------------------------------------------------------

describe("ranking: the bounded Start here reads (top-findings.server.ts)", () => {
  it("drains levels in order: malicious, then advisories, then HIGH", () => {
    const reads = planTopFindingReads([
      { findingType: "GHOST_SCRIPT", severity: "HIGH", count: 40 },
      { findingType: ADVISORY, severity: "HIGH", count: 1 },
      { findingType: "MALICIOUS_SCRIPT", severity: "LOW", count: 1 },
      { findingType: "GHOST_PIXEL", severity: "MEDIUM", count: 5 },
    ]);
    expect(reads).toEqual([
      { findingType: "MALICIOUS_SCRIPT", severity: "LOW", take: 1 },
      { findingType: ADVISORY, severity: "HIGH", take: 1 },
      { findingType: "GHOST_SCRIPT", severity: "HIGH", take: 1 },
    ]);
  });

  it("an advisory level needs only its own rows (no diversity read of other types)", () => {
    const reads = planTopFindingReads([
      { findingType: ADVISORY, severity: "HIGH", count: 5 },
      { findingType: "GHOST_SCRIPT", severity: "HIGH", count: 40 },
    ]);
    expect(reads).toEqual([{ findingType: ADVISORY, severity: "HIGH", take: 3 }]);
  });

  it("reads only as many advisory groups as the picks need (advisories are never swapped out)", () => {
    // The detector only emits HIGH; the planner must not depend on that.
    const reads = planTopFindingReads([
      { findingType: ADVISORY, severity: "HIGH", count: 5 },
      { findingType: ADVISORY, severity: "LOW", count: 5 },
      { findingType: "GHOST_SCRIPT", severity: "HIGH", count: 40 },
    ]);
    expect(reads).toEqual([{ findingType: ADVISORY, severity: "HIGH", take: 3 }]);
  });

  it("a full-list plan: malicious, advisory, then the best other finding", async () => {
    const rows = [
      ...Array.from({ length: 30 }, (_, i) => f(`s${i}`, "GHOST_SCRIPT", "HIGH")),
      advisory(),
      f("mal", "MALICIOUS_SCRIPT", "MEDIUM"),
    ];
    serveScan(rows);

    const top = await getFullListTopFindings("scan-1", null);

    expect(ids(top).slice(0, 2)).toEqual(["mal", "adv"]);
    expect(top).toHaveLength(3);
    for (const call of mockGroup.mock.calls) expect(call[3]).toBeLessThanOrEqual(3);
  });

  it("with ignores, ranks the kept findings (advisory first) and reads nothing", async () => {
    const kept = [f("a", "GHOST_PIXEL", "LOW"), f("b", "GHOST_SNIPPET", "HIGH"), advisory()];
    expect(ids(await getFullListTopFindings("scan-1", kept as never))).toEqual(["adv", "b", "a"]);
    expect(mockCounts).not.toHaveBeenCalled();
  });

  it("the bounded reads match a brute-force pick over randomized scans that hold advisories", async () => {
    const types = Object.values(FindingType);
    const sevs: Severity[] = ["HIGH", "MEDIUM", "LOW"];
    let seed = 1414;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let trial = 0; trial < 300; trial += 1) {
      const pool: FindingType[] = [
        ...types.slice(0, 2 + rand(10)),
        ADVISORY,
        ...(rand(3) === 0 ? [FindingType.MALICIOUS_SCRIPT] : []),
      ];
      const rows: Row[] = [];
      const n = rand(25);
      for (let i = 0; i < n; i += 1) {
        rows.push(
          f(`r${trial}-${i}`, pool[rand(pool.length)], sevs[rand(3)], {
            createdAt: new Date(Date.UTC(2026, 9, 12, 0, rand(5))),
          }),
        );
      }
      serveScan(rows);
      const got = await getFullListTopFindings("scan-1", null);
      expect(ids(got), `trial ${trial}`).toEqual(ids(pickTopFindings(rows)));
    }
  });
});

// ---------------------------------------------------------------------------
// Rule 2: honours ignores (unlike malicious code)
// ---------------------------------------------------------------------------

describe("honours ignores", () => {
  it("an instance-ignored advisory is ignored like any other finding", () => {
    const adv = advisory();
    expect(isFindingIgnored(adv, ignoring(adv))).toBe(true);
    expect(isFindingIgnored(adv, NO_IGNORES)).toBe(false);
  });

  it("filterIgnoredFindings drops it: it disappears from counts, lanes and Start here", () => {
    const adv = advisory();
    const script = f("s", "GHOST_SCRIPT");
    const { kept, ignored } = filterIgnoredFindings([adv, script], ignoring(adv));
    expect(ids(kept)).toEqual(["s"]);
    expect(ids(ignored)).toEqual(["adv"]);
  });

  it("the 'shows regardless of ignores' exception is malicious-only: an ignored advisory is NOT kept", () => {
    const adv = advisory();
    const mal = f("mal", "MALICIOUS_SCRIPT", "HIGH", {
      codeSnippet: "https://jsdeliver.cloud/x.js",
    });
    const { shown, ignoredMalicious } = filterIgnoredExceptMalicious(
      [adv, mal],
      ignoring(adv, mal),
    );
    // The ignored malicious finding stays (and is marked); the advisory goes.
    expect(ids(shown)).toEqual(["mal"]);
    expect([...ignoredMalicious].map((r) => r.id)).toEqual(["mal"]);
  });

  it("the ignore-filtered summary leaves it out of the total and its type count, and adds nothing back", async () => {
    const adv = advisory();
    const rows = [adv, f("s", "GHOST_SCRIPT", "MEDIUM")];
    serveScan(rows);

    const { summary, keptFindings, ignoredMalicious } = await getFilteredFindingSummaryAndKept(
      "scan-1",
      ignoring(adv),
    );

    expect(summary.total).toBe(1);
    expect(summary.byType.APP_INCIDENT_ADVISORY).toBe(0);
    expect(summary.bySeverity).toEqual({ HIGH: 0, MEDIUM: 1, LOW: 0 });
    expect(ids(keptFindings ?? [])).toEqual(["s"]);
    // Home adds `ignoredMalicious` back to the tile and the trend: never an advisory.
    expect(ignoredMalicious).toBe(0);
  });

  it("not ignored: it counts as one HIGH finding of its type", async () => {
    const adv = advisory();
    const other = f("x", "GHOST_PIXEL", "LOW");
    serveScan([adv, other]);

    const { summary } = await getFilteredFindingSummaryAndKept("scan-1", ignoring(other));

    expect(summary.total).toBe(1);
    expect(summary.byType.APP_INCIDENT_ADVISORY).toBe(1);
    expect(summary.bySeverity.HIGH).toBe(1);
  });

  it("the finding has no app name, so an app-level ignore can never hide it", () => {
    const adv = advisory();
    expect(adv.appName).toBeNull();
    const appIgnore = {
      fingerprints: new Set<string>(),
      appNames: new Set(["Hulk Product Options"]),
    };
    expect(isFindingIgnored(adv, appIgnore)).toBe(false);
  });

  it("the ignore survives a rescan of an unchanged theme (same fingerprint)", () => {
    const first = advisory("scan1-row");
    const second = advisory("scan2-row", { scanId: "scan-2" });
    expect(isFindingIgnored(second, ignoring(first))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rule 5: the summary email's counts are the existing ones
// ---------------------------------------------------------------------------

describe("summary email counts (no advisory-specific behaviour)", () => {
  const coverage = (live: string[] = ALL_TYPES) => ({
    skippedCategories: [],
    cappedCategories: [],
    unreachableCategories: [],
    skippedFiles: [],
    liveFindingTypes: live as unknown,
  });
  const changes = (
    current: Row[],
    baseline: Row[],
    ignores = NO_IGNORES,
    baselineLive: string[] = ALL_TYPES,
  ) =>
    computeFindingChanges({
      currentFindings: current,
      currentCoverage: coverage(),
      currentLiveFindingTypes: ALL_TYPES,
      baseline: { ...coverage(baselineLive), findings: baseline },
      ignores,
    });

  it("a new advisory counts as one new and one open finding", () => {
    expect(changes([advisory()], [])).toEqual({
      ok: true,
      newCount: 1,
      fixedCount: 0,
      openCount: 1,
    });
  });

  it("an unchanged advisory is open, neither new nor fixed", () => {
    expect(changes([advisory("b")], [advisory("a")])).toEqual({
      ok: true,
      newCount: 0,
      fixedCount: 0,
      openCount: 1,
    });
  });

  it("a removed script counts as one fixed finding", () => {
    expect(changes([], [advisory()])).toEqual({
      ok: true,
      newCount: 0,
      fixedCount: 1,
      openCount: 0,
    });
  });

  it("an IGNORED advisory counts in none of the three numbers (unlike ignored malicious code)", () => {
    const adv = advisory();
    expect(changes([adv], [], ignoring(adv))).toEqual({
      ok: true,
      newCount: 0,
      fixedCount: 0,
      openCount: 0,
    });
    const mal = f("mal", "MALICIOUS_SCRIPT");
    expect(changes([mal], [], ignoring(mal))).toEqual({
      ok: true,
      newCount: 1,
      fixedCount: 0,
      openCount: 1,
    });
  });

  it("the first scan after the detector goes live never reports the advisory as new", () => {
    const before = ALL_TYPES.filter((t) => t !== ADVISORY);
    expect(changes([advisory()], [], NO_IGNORES, before)).toEqual({
      ok: true,
      newCount: 0,
      fixedCount: 0,
      openCount: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// Rule 6: diffing
// ---------------------------------------------------------------------------

describe("scan differ", () => {
  const coverage = (over: Record<string, unknown> = {}) => ({
    skippedCategories: [] as string[],
    cappedCategories: [] as string[],
    unreachableCategories: [] as string[],
    skippedFiles: [] as string[],
    liveFindingTypes: ALL_TYPES as unknown,
    ...over,
  });
  const NOT_LIVE = ALL_TYPES.filter((t) => t !== ADVISORY);

  it("new: present now, absent before", () => {
    const diff = diffScans([advisory()], [], scanDiffOptions(coverage(), coverage()));
    expect(diff.newFindings).toEqual([
      {
        filename: "layout/theme.liquid",
        findingType: ADVISORY,
        severity: "HIGH",
        appName: null,
        description: DESCRIPTION,
      },
    ]);
    expect(diff.resolvedFindings).toEqual([]);
    expect(diff.unchangedCount).toBe(0);
  });

  it("resolved: the merchant removed the script", () => {
    const diff = diffScans([], [advisory()], scanDiffOptions(coverage(), coverage()));
    expect(diff.newFindings).toEqual([]);
    expect(diff.resolvedFindings.map((r) => r.findingType)).toEqual([ADVISORY]);
  });

  it("unchanged: same file, line and snippet on both scans", () => {
    const diff = diffScans(
      [advisory("b")],
      [advisory("a")],
      scanDiffOptions(coverage(), coverage()),
    );
    expect(diff).toEqual({ newFindings: [], resolvedFindings: [], unchangedCount: 1 });
  });

  it("an edit above the line does not turn it into resolved + new (the fingerprint has no line number)", () => {
    const moved = advisory("b", { lineNumber: 57 });
    const diff = diffScans([moved], [advisory("a")], scanDiffOptions(coverage(), coverage()));
    expect(diff).toEqual({ newFindings: [], resolvedFindings: [], unchangedCount: 1 });
  });

  it("the anchor moving to another file reads as one resolved and one new (one finding per scan)", () => {
    const moved = advisory("b", { filename: "sections/main-product.liquid", lineNumber: 3 });
    const diff = diffScans([moved], [advisory("a")], scanDiffOptions(coverage(), coverage()));
    expect(diff.newFindings).toHaveLength(1);
    expect(diff.resolvedFindings).toHaveLength(1);
  });

  it("NOT new just because the detector shipped: the baseline's live set does not hold the type", () => {
    // Every scan recorded before this change has a live set without the type.
    const baseline = coverage({ liveFindingTypes: NOT_LIVE });
    expect(unauditedCategories(baseline)).toContain(ADVISORY);
    const diff = diffScans([advisory()], [], scanDiffOptions(coverage(), baseline));
    expect(diff.newFindings).toEqual([]);
    expect(diff.resolvedFindings).toEqual([]);
  });

  it("NOT new when the soft-launch flag was off at the baseline and on now (the same mechanism)", () => {
    const baseline = coverage({ liveFindingTypes: NOT_LIVE });
    const current = coverage();
    expect(diffScans([advisory()], [], scanDiffOptions(current, baseline)).newFindings).toEqual([]);
    // The scan after that one compares normally.
    expect(
      diffScans([advisory("b")], [advisory("a")], scanDiffOptions(coverage(), current)),
    ).toEqual({ newFindings: [], resolvedFindings: [], unchangedCount: 1 });
  });

  it("NOT resolved when the flag is switched off again (the current scan did not look)", () => {
    const current = coverage({ liveFindingTypes: NOT_LIVE });
    const diff = diffScans([], [advisory()], scanDiffOptions(current, coverage()));
    expect(diff.resolvedFindings).toEqual([]);
  });

  it("a legacy baseline with no recorded live set infers nothing, like every other type", () => {
    const baseline = coverage({ liveFindingTypes: null });
    expect(unauditedCategories(baseline)).not.toContain(ADVISORY);
    expect(
      diffScans([advisory()], [], scanDiffOptions(coverage(), baseline)).newFindings,
    ).toHaveLength(1);
  });

  it("anchored to a file that is now over the size cap: still diffed (the cross-file pass still reads it)", () => {
    const current = coverage({ skippedFiles: ["layout/theme.liquid"] });
    // Still present: unchanged, not excluded and re-reported as new.
    expect(
      diffScans([advisory("b")], [advisory("a")], scanDiffOptions(current, coverage())),
    ).toEqual({
      newFindings: [],
      resolvedFindings: [],
      unchangedCount: 1,
    });
    // Gone: resolved, not silently dropped.
    expect(
      diffScans([], [advisory("a")], scanDiffOptions(current, coverage())).resolvedFindings,
    ).toHaveLength(1);
    // Control: a per-file type in that file is excluded (unknown, not fixed).
    const perFile = f("g", "GHOST_SCRIPT", "HIGH", { filename: "layout/theme.liquid" });
    expect(diffScans([], [perFile], scanDiffOptions(current, coverage())).resolvedFindings).toEqual(
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// Never an app's leftover
// ---------------------------------------------------------------------------

describe("app-removal detection never counts an advisory", () => {
  const fingerprints = computeAppSignatureFingerprints(APP_SIGNATURES);
  const scan = (findings: Row[], embedApps: string[]) => ({
    skippedCategories: [],
    cappedCategories: [],
    unreachableCategories: [],
    skippedFiles: [],
    liveFindingTypes: ALL_TYPES as unknown,
    appSignatureFingerprints: fingerprints as unknown,
    liveAppHooks: { embedApps, scriptTagApps: null } as unknown,
    findings,
  });
  const LIVE_APP = APP_SIGNATURES.find((s) => (s.embedHandles ?? []).length > 0)!.appName;

  it("control: an app whose embed went away, with one leftover finding, IS a removal", () => {
    const leftover = f("left", "GHOST_SCRIPT", "HIGH", { appName: LIVE_APP });
    expect(
      detectAppRemovals(scan([leftover], []), scan([], [LIVE_APP]), { ignores: NO_IGNORES }),
    ).toEqual([{ appName: LIVE_APP, leftoverCount: 1 }]);
  });

  it("the same scans with only an advisory: no removal, for that app or any other", () => {
    expect(
      detectAppRemovals(scan([advisory()], []), scan([], [LIVE_APP]), { ignores: NO_IGNORES }),
    ).toEqual([]);
  });

  it("an advisory beside a real leftover does not inflate the leftover count", () => {
    const leftover = f("left", "GHOST_SCRIPT", "HIGH", { appName: LIVE_APP });
    expect(
      detectAppRemovals(scan([leftover, advisory()], []), scan([], [LIVE_APP]), {
        ignores: NO_IGNORES,
      }),
    ).toEqual([{ appName: LIVE_APP, leftoverCount: 1 }]);
  });

  it("is in no app's leftover list, including one named like the advisory's app", () => {
    const current = scan([advisory()], []);
    for (const name of ["Hulk Product Options", LIVE_APP]) {
      expect(appLeftoverFindings(name, [advisory()], current, null, NO_IGNORES)).toEqual([]);
    }
  });
});

/**
 * Tests for app/services/top-findings.server.ts (gc-bn0x): the bounded reads
 * behind the "Start here" block. The finding model is mocked with an
 * in-memory scan that honors each read's where / orderBy / take, so the
 * planner is checked against a brute-force pick over the whole scan.
 */
import type { FindingType, Severity } from "@prisma/client";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../app/models/finding.server", () => ({
  getTopFindingsOfTypes: vi.fn(),
  getTopFindingsInGroup: vi.fn(),
  getTypeSeverityCountsForScan: vi.fn(),
}));

import { CONSEQUENCE_MAP } from "../../app/lib/finding-consequence";
import { freePreviewCount } from "../../app/lib/free-preview";
import { pickTopFindings } from "../../app/lib/top-findings";
import {
  getTopFindingsInGroup,
  getTopFindingsOfTypes,
  getTypeSeverityCountsForScan,
} from "../../app/models/finding.server";
import { getFreePreviewFindings } from "../../app/services/free-preview.server";
import {
  getFreeTopFindings,
  getFullListTopFindings,
  planTopFindingReads,
} from "../../app/services/top-findings.server";

const mockGroup = getTopFindingsInGroup as ReturnType<typeof vi.fn>;
const mockOfTypes = getTopFindingsOfTypes as ReturnType<typeof vi.fn>;
const mockCounts = getTypeSeverityCountsForScan as ReturnType<typeof vi.fn>;

type Row = {
  id: string;
  findingType: FindingType;
  severity: Severity;
  createdAt: Date;
  filename: string;
  lineNumber: number;
  codeSnippet: string;
  appName: string | null;
};

function f(id: string, findingType: FindingType, severity: Severity, minute = 0): Row {
  return {
    id,
    findingType,
    severity,
    createdAt: new Date(Date.UTC(2026, 8, 1, 0, minute)),
    filename: `snippets/${id}.liquid`,
    lineNumber: 1,
    codeSnippet: id,
    appName: null,
  };
}

const SEV: Record<Severity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
const dbOrder = (a: Row, b: Row) =>
  SEV[a.severity] - SEV[b.severity] ||
  a.createdAt.getTime() - b.createdAt.getTime() ||
  (a.id < b.id ? -1 : 1);

/** Back the mocked model with an in-memory scan. */
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
  mockOfTypes.mockImplementation(async (_s: string, types: FindingType[], take: number) =>
    rows
      .filter((r) => types.includes(r.findingType) && r.findingType !== "MALICIOUS_SCRIPT")
      .sort(dbOrder)
      .slice(0, take),
  );
}

function byTypeOf(rows: Row[]): Partial<Record<FindingType, number>> {
  const out: Partial<Record<FindingType, number>> = {};
  for (const r of rows) out[r.findingType] = (out[r.findingType] ?? 0) + 1;
  return out;
}

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("planTopFindingReads", () => {
  it("plans nothing for an empty scan", () => {
    expect(planTopFindingReads([])).toEqual([]);
  });

  it("reads only the best classes, capped at the picks needed", () => {
    const reads = planTopFindingReads([
      { findingType: "GHOST_SNIPPET", severity: "HIGH", count: 40 },
      { findingType: "GHOST_SCRIPT", severity: "HIGH", count: 40 },
      { findingType: "GHOST_PIXEL", severity: "HIGH", count: 40 },
      { findingType: "ORPHAN_ASSET", severity: "HIGH", count: 40 },
      { findingType: "GHOST_SCRIPT", severity: "LOW", count: 500 },
    ]);
    // 3 HIGH types cover 3 rows and 3 types; housekeeping and LOW are never read.
    expect(reads).toEqual([
      { findingType: "GHOST_SNIPPET", severity: "HIGH", take: 3 },
      { findingType: "GHOST_SCRIPT", severity: "HIGH", take: 3 },
      { findingType: "GHOST_PIXEL", severity: "HIGH", take: 3 },
    ]);
  });

  it("keeps reading a level until 3 distinct types are covered (diversity)", () => {
    const reads = planTopFindingReads([
      { findingType: "GHOST_SCRIPT", severity: "HIGH", count: 10 },
      { findingType: "ORPHAN_ASSET", severity: "HIGH", count: 1 },
    ]);
    expect(reads.map((r) => r.findingType)).toEqual(["GHOST_SCRIPT", "ORPHAN_ASSET"]);
  });

  it("drains levels in order: malicious, then HIGH, then MEDIUM", () => {
    const reads = planTopFindingReads([
      { findingType: "MALICIOUS_SCRIPT", severity: "HIGH", count: 1 },
      { findingType: "GHOST_SCRIPT", severity: "HIGH", count: 1 },
      { findingType: "GHOST_PIXEL", severity: "MEDIUM", count: 5 },
      { findingType: "ORPHAN_ASSET", severity: "LOW", count: 5 },
    ]);
    expect(reads).toEqual([
      { findingType: "MALICIOUS_SCRIPT", severity: "HIGH", take: 1 },
      { findingType: "GHOST_SCRIPT", severity: "HIGH", take: 1 },
      { findingType: "GHOST_PIXEL", severity: "MEDIUM", take: 1 },
    ]);
  });

  it("matches a brute-force pick over randomized scans", async () => {
    const types = Object.keys(CONSEQUENCE_MAP) as FindingType[];
    const sevs: Severity[] = ["HIGH", "MEDIUM", "LOW"];
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let trial = 0; trial < 400; trial += 1) {
      const pool = types.slice(0, 2 + rand(10)).concat(rand(4) === 0 ? ["MALICIOUS_SCRIPT"] : []);
      const rows: Row[] = [];
      const n = rand(25);
      for (let i = 0; i < n; i += 1) {
        rows.push(f(`r${trial}-${i}`, pool[rand(pool.length)], sevs[rand(3)], rand(5)));
      }
      serveScan(rows);
      const got = await getFullListTopFindings("scan-1", null);
      expect(ids(got)).toEqual(ids(pickTopFindings(rows)));
    }
  });
});

describe("getFullListTopFindings", () => {
  it("no findings: one count query, no row reads, empty", async () => {
    serveScan([]);
    await expect(getFullListTopFindings("scan-1", null)).resolves.toEqual([]);
    expect(mockCounts).toHaveBeenCalledTimes(1);
    expect(mockGroup).not.toHaveBeenCalled();
  });

  it("reads at most `take <= 3` rows per planned group", async () => {
    const rows = Array.from({ length: 60 }, (_, i) => f(`s${i}`, "GHOST_SCRIPT", "HIGH", i % 50));
    serveScan(rows);
    const top = await getFullListTopFindings("scan-1", null);
    expect(top).toHaveLength(3);
    for (const call of mockGroup.mock.calls) expect(call[3]).toBeLessThanOrEqual(3);
  });

  it("with ignores, ranks the kept findings and reads nothing", async () => {
    const kept = [f("a", "GHOST_PIXEL", "LOW"), f("b", "GHOST_SNIPPET", "HIGH")];
    const top = await getFullListTopFindings("scan-1", kept as never);
    expect(ids(top)).toEqual(["b", "a"]);
    expect(mockCounts).not.toHaveBeenCalled();
    expect(mockGroup).not.toHaveBeenCalled();
  });

  it("propagates a read failure", async () => {
    mockCounts.mockRejectedValue(new Error("db down"));
    await expect(getFullListTopFindings("scan-1", null)).rejects.toThrow("db down");
  });
});

describe("getFreeTopFindings", () => {
  it("with loaded rows, ranks malicious + preview and reads nothing", async () => {
    const top = await getFreeTopFindings("scan-1", {}, null, [], {
      preview: [f("p1", "GHOST_SCRIPT", "HIGH"), f("p2", "ORPHAN_ASSET", "LOW")] as never,
      malicious: [f("m", "MALICIOUS_SCRIPT", "MEDIUM")] as never,
    });
    expect(ids(top)).toEqual(["m", "p1", "p2"]);
    expect(mockOfTypes).not.toHaveBeenCalled();
    expect(mockGroup).not.toHaveBeenCalled();
  });

  it("only ever returns preview rows or malicious rows (the Free subset guarantee)", async () => {
    let seed = 11;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const types = Object.keys(CONSEQUENCE_MAP) as FindingType[];
    const sevs: Severity[] = ["HIGH", "MEDIUM", "LOW"];
    for (let trial = 0; trial < 200; trial += 1) {
      const rows = Array.from({ length: 1 + rand(30) }, (_, i) =>
        f(`r${trial}-${i}`, types[rand(types.length)], sevs[rand(3)], rand(5)),
      );
      serveScan(rows);
      const byType = byTypeOf(rows);
      const preview = await getFreePreviewFindings("scan-1", byType, null, []);
      const visible = new Set([
        ...ids(preview),
        ...ids(rows.filter((r) => r.findingType === "MALICIOUS_SCRIPT")),
      ]);
      const top = await getFreeTopFindings("scan-1", byType, null, []);
      for (const id of ids(top)) expect(visible.has(id)).toBe(true);
      const nonMalicious = rows.filter((r) => r.findingType !== "MALICIOUS_SCRIPT").length;
      const malicious = rows.length - nonMalicious;
      expect(top.length).toBe(Math.min(3, freePreviewCount(nonMalicious) + malicious));
    }
  });

  it("a Free shop with many findings never sees a hidden one ranked above its preview", async () => {
    // 10 non-malicious -> 5 preview rows; the 5 hidden rows include HIGH
    // scripts that would win on a full-list plan.
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => f(`script${i}`, "GHOST_SCRIPT", "HIGH", i)),
      f("snippet", "GHOST_SNIPPET", "LOW", 0),
      f("pixel", "GHOST_PIXEL", "LOW", 0),
      f("hreflang", "GHOST_HREFLANG", "LOW", 0),
      f("orphan", "ORPHAN_ASSET", "LOW", 0),
    ];
    serveScan(rows);
    const byType = byTypeOf(rows);
    const preview = ids(await getFreePreviewFindings("scan-1", byType, null, []));
    const top = ids(await getFreeTopFindings("scan-1", byType, null, []));
    expect(top.every((id) => preview.includes(id))).toBe(true);
    expect(top).toEqual(["script0", "snippet", "pixel"]);
    // A full-list plan ranks the whole scan: three HIGH scripts (no other HIGH
    // type exists, so diversity cannot pull in a LOW finding).
    const full = ids(await getFullListTopFindings("scan-1", null));
    expect(full).toEqual(["script0", "script1", "script2"]);
  });

  it("reads malicious rows only when the scan has some", async () => {
    serveScan([f("a", "GHOST_SCRIPT", "HIGH"), f("b", "GHOST_PIXEL", "LOW")]);
    await getFreeTopFindings("scan-1", { GHOST_SCRIPT: 1, GHOST_PIXEL: 1 }, null, []);
    expect(mockGroup).not.toHaveBeenCalled();

    serveScan([f("a", "GHOST_SCRIPT", "HIGH"), f("m", "MALICIOUS_SCRIPT", "HIGH")]);
    const top = await getFreeTopFindings(
      "scan-1",
      { GHOST_SCRIPT: 1, MALICIOUS_SCRIPT: 1 },
      null,
      [],
    );
    expect(mockGroup).toHaveBeenCalledWith("scan-1", "MALICIOUS_SCRIPT", null, 3);
    expect(ids(top)).toEqual(["m", "a"]);
  });

  it("with ignores, uses the kept rows (ignored malicious excluded) and reads nothing", async () => {
    const kept = [f("a", "GHOST_SCRIPT", "HIGH"), f("b", "GHOST_PIXEL", "LOW")];
    const top = await getFreeTopFindings(
      "scan-1",
      { GHOST_SCRIPT: 1, GHOST_PIXEL: 1 },
      kept as never,
      [],
    );
    // 2 non-malicious -> 1 preview row.
    expect(ids(top)).toEqual(["a"]);
    expect(mockOfTypes).not.toHaveBeenCalled();
    expect(mockGroup).not.toHaveBeenCalled();
  });

  it("no findings: nothing", async () => {
    serveScan([]);
    await expect(getFreeTopFindings("scan-1", {}, null, [])).resolves.toEqual([]);
  });
});

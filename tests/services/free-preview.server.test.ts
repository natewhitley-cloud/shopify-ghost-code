/**
 * Tests for app/services/free-preview.server.ts (gc-97k.10): the bounded read
 * behind the Free preview rows. The finding model is mocked; the pure formula
 * and picker run for real.
 *
 * Changed on purpose (audit 1 #7): for a shop with ignores the service used to
 * re-read the scan's full findings itself; it now picks from the kept findings
 * the page's summary read already loaded, and issues no query at all.
 */
import type { FindingType } from "@prisma/client";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../app/models/finding.server", () => ({
  getFindingsForScan: vi.fn(),
  getTopFindingsOfTypes: vi.fn(),
}));

import { CONSEQUENCE_MAP } from "../../app/lib/finding-consequence";
import { freePreviewCount, pickFreePreviewFindings } from "../../app/lib/free-preview";
import { getFindingsForScan, getTopFindingsOfTypes } from "../../app/models/finding.server";
import {
  getFreePreviewFindings,
  PREVIEW_READ_BUCKETS,
} from "../../app/services/free-preview.server";

/** The (lane, urgency) read bucket holding `type`. */
function bucketOf(type: FindingType): FindingType[] {
  const bucket = PREVIEW_READ_BUCKETS.find((b) => b.includes(type));
  if (!bucket) throw new Error(`no bucket for ${type}`);
  return bucket;
}

const mockTop = getTopFindingsOfTypes as ReturnType<typeof vi.fn>;
const mockAll = getFindingsForScan as ReturnType<typeof vi.fn>;

/** A shop with no ignores: no kept findings were read, so the bounded path runs. */
const NO_IGNORES = null;

/** A plan that withholds no finding type (Standard+ features all on). */
const NONE: FindingType[] = [];
/** What Free withholds (findingTypesWithheldByPlan(free)). */
const WITHHELD: FindingType[] = ["DANGLING_REFERENCE", "CHECKOUT_SUNSET"];

const SEV_ORDER = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;

/** A faithful fake of the bounded DB read over `rows` (DB ORDER BY + take). */
function serveRows(rows: Array<ReturnType<typeof f>>) {
  mockTop.mockImplementation(async (_scan: string, types: FindingType[], take: number) =>
    rows
      .filter((r) => types.includes(r.findingType) && r.findingType !== "MALICIOUS_SCRIPT")
      .sort(
        (a, b) =>
          SEV_ORDER[a.severity] - SEV_ORDER[b.severity] ||
          a.createdAt.getTime() - b.createdAt.getTime() ||
          (a.id < b.id ? -1 : 1),
      )
      .slice(0, take),
  );
}

function f(id: string, findingType: FindingType, appName: string | null = null, minute = 0) {
  return {
    id,
    findingType,
    severity: "HIGH" as "HIGH" | "MEDIUM" | "LOW",
    createdAt: new Date(Date.UTC(2026, 8, 1, 0, minute)),
    filename: `snippets/${id}.liquid`,
    lineNumber: 1,
    codeSnippet: id,
    appName,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockTop.mockResolvedValue([]);
  mockAll.mockResolvedValue([]);
});

describe("getFreePreviewFindings", () => {
  it("reads nothing when there is nothing to show", async () => {
    await expect(getFreePreviewFindings("scan-1", {}, NO_IGNORES, NONE)).resolves.toEqual([]);
    expect(mockTop).not.toHaveBeenCalled();
    expect(mockAll).not.toHaveBeenCalled();
  });

  it("does not count malicious findings toward the total (all-malicious shows nothing)", async () => {
    await expect(
      getFreePreviewFindings("scan-1", { MALICIOUS_SCRIPT: 9 }, NO_IGNORES, NONE),
    ).resolves.toEqual([]);
    expect(mockTop).not.toHaveBeenCalled();
  });

  it("queries only non-empty (lane, urgency) buckets, each capped at the shown count", async () => {
    // 8 non-malicious -> shown 4. Speed and Still tracking you have findings;
    // the malicious count lives in the privacy lane but must not make it
    // "non-empty" on its own, and must not raise the count.
    await getFreePreviewFindings(
      "scan-1",
      { GHOST_SCRIPT: 6, GHOST_STYLE: 1, GHOST_PIXEL: 1, MALICIOUS_SCRIPT: 20, GHOST_SNIPPET: 0 },
      NO_IGNORES,
      NONE,
    );

    // GHOST_SCRIPT and GHOST_STYLE share the Speed / act-now bucket.
    expect(mockTop).toHaveBeenCalledTimes(2);
    expect(mockTop).toHaveBeenCalledWith("scan-1", bucketOf("GHOST_SCRIPT"), 4);
    expect(bucketOf("GHOST_SCRIPT")).toContain("GHOST_STYLE");
    expect(mockTop).toHaveBeenCalledWith("scan-1", bucketOf("GHOST_PIXEL"), 4);
    expect(mockAll).not.toHaveBeenCalled();
  });

  it("skips a lane whose only findings are malicious", async () => {
    await getFreePreviewFindings(
      "scan-1",
      { GHOST_SCRIPT: 2, MALICIOUS_SCRIPT: 3 },
      NO_IGNORES,
      NONE,
    );

    expect(mockTop).toHaveBeenCalledTimes(1);
    expect(mockTop).toHaveBeenCalledWith("scan-1", bucketOf("GHOST_SCRIPT"), 1);
  });

  it("buckets partition every non-malicious type by (primary lane, urgency)", () => {
    const all = PREVIEW_READ_BUCKETS.flat();
    const expected = (Object.keys(CONSEQUENCE_MAP) as FindingType[]).filter(
      (t) => t !== "MALICIOUS_SCRIPT",
    );
    expect([...all].sort()).toEqual([...expected].sort());
    for (const bucket of PREVIEW_READ_BUCKETS) {
      const keys = new Set(
        bucket.map((t) => `${CONSEQUENCE_MAP[t].primary}|${CONSEQUENCE_MAP[t].urgency}`),
      );
      expect(keys.size).toBe(1);
    }
  });

  it("reads a lane per urgency, so a newer act-now row beats an older whenever row (gc-bn0x)", async () => {
    // Speed has an older HIGH preconnect (whenever) and a newer HIGH script
    // (act-now). Read per lane by (severity, createdAt) with take 1, the
    // preconnect would win; the shared ranking wants the script.
    mockTop.mockImplementation(async (_scan: string, types: FindingType[]) =>
      types.includes("GHOST_SCRIPT")
        ? [f("script", "GHOST_SCRIPT", null, 9)]
        : types.includes("GHOST_PRECONNECT")
          ? [f("preconnect", "GHOST_PRECONNECT", null, 0)]
          : [],
    );

    const rows = await getFreePreviewFindings(
      "scan-1",
      { GHOST_SCRIPT: 1, GHOST_PRECONNECT: 2 },
      NO_IGNORES,
      NONE,
    );

    expect(mockTop).toHaveBeenCalledTimes(2);
    expect(rows.map((r) => r.id)).toEqual(["script"]);
  });

  it("picks across the per-lane reads", async () => {
    mockTop.mockImplementation(async (_scan: string, types: FindingType[]) =>
      types.includes("GHOST_SCRIPT")
        ? [f("s1", "GHOST_SCRIPT", null, 0), f("s2", "GHOST_SCRIPT", null, 1)]
        : [f("d1", "GHOST_HREFLANG", null, 2)],
    );

    const rows = await getFreePreviewFindings(
      "scan-1",
      { GHOST_SCRIPT: 3, GHOST_HREFLANG: 1 },
      NO_IGNORES,
      NONE,
    );

    expect(rows.map((r) => r.id)).toEqual(["s1", "d1"]);
  });

  it("with ignores, picks from the summary's kept findings with NO query (never a second full read)", async () => {
    // The kept set the summary read (ignored BadApp rows already removed).
    const kept = [
      f("keep-1", "GHOST_SCRIPT", "GoodApp", 2),
      f("keep-2", "GHOST_HREFLANG", null, 3),
      f("mal", "MALICIOUS_SCRIPT", null, 4),
    ];

    // The page's summary already excludes ignored rows: 2 kept non-malicious.
    const rows = await getFreePreviewFindings(
      "scan-1",
      { GHOST_SCRIPT: 1, GHOST_HREFLANG: 1, MALICIOUS_SCRIPT: 1 },
      kept as never,
      NONE,
    );

    expect(mockAll).not.toHaveBeenCalled();
    expect(mockTop).not.toHaveBeenCalled();
    expect(rows.map((r) => r.id)).toEqual(["keep-1"]);
  });

  it("with ignores and every finding ignored: shows nothing, no query", async () => {
    await expect(getFreePreviewFindings("scan-1", {}, [], NONE)).resolves.toEqual([]);
    expect(mockAll).not.toHaveBeenCalled();
    expect(mockTop).not.toHaveBeenCalled();
  });

  it("never reads or picks a plan-withheld type, but keeps it in the formula's total", async () => {
    // A downgraded Free shop: 4 old Broken links + 2 scripts = 6 -> count 3.
    serveRows([
      ...Array.from({ length: 4 }, (_, i) => f(`dr${i}`, "DANGLING_REFERENCE", null, i)),
      f("s1", "GHOST_SCRIPT", null, 9),
      f("s2", "GHOST_SCRIPT", null, 10),
    ]);
    const rows = await getFreePreviewFindings(
      "scan-1",
      { DANGLING_REFERENCE: 4, GHOST_SCRIPT: 2 },
      NO_IGNORES,
      WITHHELD,
    );

    expect(rows.map((r) => r.id)).toEqual(["s1", "s2"]);
    for (const [, types] of mockTop.mock.calls) {
      expect(types).not.toContain("DANGLING_REFERENCE");
      expect(types).not.toContain("CHECKOUT_SUNSET");
    }
  });

  it("with ignores, filters plan-withheld types out of the kept rows", async () => {
    const kept = [f("dr", "DANGLING_REFERENCE", null, 0), f("cs", "CHECKOUT_SUNSET", null, 1)];
    kept.push(f("s1", "GHOST_SCRIPT", null, 2), f("s2", "GHOST_PIXEL", null, 3));
    const rows = await getFreePreviewFindings(
      "scan-1",
      { DANGLING_REFERENCE: 1, CHECKOUT_SUNSET: 1, GHOST_SCRIPT: 1, GHOST_PIXEL: 1 },
      kept as never,
      WITHHELD,
    );
    expect(rows.map((r) => r.id)).toEqual(["s1", "s2"]);
  });

  it("a scan whose only findings are withheld previews nothing", async () => {
    serveRows([f("dr", "DANGLING_REFERENCE", null, 0), f("dr2", "DANGLING_REFERENCE", null, 1)]);
    await expect(
      getFreePreviewFindings("scan-1", { DANGLING_REFERENCE: 2 }, NO_IGNORES, WITHHELD),
    ).resolves.toEqual([]);
  });

  it("matches a brute-force pick over randomized scans (the per-bucket read is exact)", async () => {
    const types = (Object.keys(CONSEQUENCE_MAP) as FindingType[]).filter(
      (t) => t !== "MALICIOUS_SCRIPT",
    );
    const sevs = ["HIGH", "MEDIUM", "LOW"] as const;
    let seed = 3;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let trial = 0; trial < 400; trial += 1) {
      const pool = types.slice(rand(types.length - 4), types.length).slice(0, 2 + rand(12));
      const rows = Array.from({ length: rand(30) }, (_, i) => ({
        ...f(`r${trial}-${i}`, pool[rand(pool.length)], null, rand(6)),
        severity: sevs[rand(3)],
      }));
      serveRows(rows);
      const byType: Partial<Record<FindingType, number>> = {};
      for (const r of rows) byType[r.findingType] = (byType[r.findingType] ?? 0) + 1;
      const withheld = rand(2) === 0 ? NONE : WITHHELD;

      const got = await getFreePreviewFindings("scan-1", byType, NO_IGNORES, withheld);

      const visible = rows.filter((r) => !withheld.includes(r.findingType));
      const expected = pickFreePreviewFindings(visible, freePreviewCount(rows.length));
      expect(got.map((r) => r.id)).toEqual(expected.map((r) => r.id));
    }
  });
});

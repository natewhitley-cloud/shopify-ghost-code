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

function f(id: string, findingType: FindingType, appName: string | null = null, minute = 0) {
  return {
    id,
    findingType,
    severity: "HIGH" as const,
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
    await expect(getFreePreviewFindings("scan-1", {}, NO_IGNORES)).resolves.toEqual([]);
    expect(mockTop).not.toHaveBeenCalled();
    expect(mockAll).not.toHaveBeenCalled();
  });

  it("does not count malicious findings toward the total (all-malicious shows nothing)", async () => {
    await expect(
      getFreePreviewFindings("scan-1", { MALICIOUS_SCRIPT: 9 }, NO_IGNORES),
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
    );

    // GHOST_SCRIPT and GHOST_STYLE share the Speed / act-now bucket.
    expect(mockTop).toHaveBeenCalledTimes(2);
    expect(mockTop).toHaveBeenCalledWith("scan-1", bucketOf("GHOST_SCRIPT"), 4);
    expect(bucketOf("GHOST_SCRIPT")).toContain("GHOST_STYLE");
    expect(mockTop).toHaveBeenCalledWith("scan-1", bucketOf("GHOST_PIXEL"), 4);
    expect(mockAll).not.toHaveBeenCalled();
  });

  it("skips a lane whose only findings are malicious", async () => {
    await getFreePreviewFindings("scan-1", { GHOST_SCRIPT: 2, MALICIOUS_SCRIPT: 3 }, NO_IGNORES);

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
    );

    expect(mockAll).not.toHaveBeenCalled();
    expect(mockTop).not.toHaveBeenCalled();
    expect(rows.map((r) => r.id)).toEqual(["keep-1"]);
  });

  it("with ignores and every finding ignored: shows nothing, no query", async () => {
    await expect(getFreePreviewFindings("scan-1", {}, [])).resolves.toEqual([]);
    expect(mockAll).not.toHaveBeenCalled();
    expect(mockTop).not.toHaveBeenCalled();
  });
});

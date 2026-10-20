/**
 * Tests for recordChangeSetForScan (gc-rrh.4, spec 2.1-2.2): baseline choice
 * (compared, theme switch, baseline), the saved row, idempotent re-runs and
 * error propagation (the worker step contains errors). Models are mocked; no
 * database is touched.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  getScanForChangeLog: vi.fn(),
  getLatestPublishedChangeSetBefore: vi.fn(),
  upsertScanChangeSet: vi.fn(),
  getScanManifest: vi.fn(),
  getLatestManifestForTheme: vi.fn(),
  getRemovalNoticeRows: vi.fn(),
  getIgnoredFindingsForShop: vi.fn(),
}));
vi.mock("../../app/db.server", () => ({ default: {} }));
vi.mock("../../app/models/scan-change.server", () => ({
  getScanForChangeLog: m.getScanForChangeLog,
  getLatestPublishedChangeSetBefore: m.getLatestPublishedChangeSetBefore,
  upsertScanChangeSet: m.upsertScanChangeSet,
}));
vi.mock("../../app/models/scan-manifest.server", () => ({
  getScanManifest: m.getScanManifest,
  getLatestManifestForTheme: m.getLatestManifestForTheme,
}));
vi.mock("../../app/models/app-removal.server", () => ({
  getRemovalNoticeRows: m.getRemovalNoticeRows,
}));
vi.mock("../../app/models/ignored-finding.server", () => ({
  getIgnoredFindingsForShop: m.getIgnoredFindingsForShop,
}));

import { computeChangeSet, recordChangeSetForScan } from "../../app/services/change-log.server";
import type { ChangeLogScan } from "../../app/services/change-log.server";
import {
  AFTER_SCAN_ID,
  BEFORE_SCAN_ID,
  OTHER_THEME_ID,
  PUSHOWL_REMOVED,
  SWITCH_SCAN_ID,
  THEME_ID,
  afterScan,
  beforeScan,
  switchScan,
} from "../fixtures/change-log-scans";

const SHOP_ID = "shop-1";
const CREATED = {
  [BEFORE_SCAN_ID]: new Date("2026-10-12T06:40:00Z"),
  [AFTER_SCAN_ID]: new Date("2026-10-19T06:40:00Z"),
  [SWITCH_SCAN_ID]: new Date("2026-10-19T09:00:00Z"),
};

/** A fixture scan as getScanForChangeLog returns it. */
function dbRow(scan: ChangeLogScan, over: Record<string, unknown> = {}) {
  return {
    id: scan.scanId,
    shopId: SHOP_ID,
    themeId: scan.themeId,
    themeName: scan.themeName,
    status: "COMPLETED",
    origin: "SCHEDULED",
    createdAt: CREATED[scan.scanId as keyof typeof CREATED],
    skippedCategories: scan.coverage.skippedCategories,
    cappedCategories: scan.coverage.cappedCategories,
    unreachableCategories: scan.coverage.unreachableCategories,
    skippedFiles: scan.coverage.skippedFiles,
    liveFindingTypes: scan.coverage.liveFindingTypes,
    walkCoverage: scan.coverage.walkCoverage,
    liveAppHooks: scan.liveAppHooks,
    appSignatureFingerprints: scan.appSignatureFingerprints,
    themeInfo: scan.themeInfo,
    shop: { plan: "Professional" },
    findings: scan.findings,
    unknownScripts: scan.unknownScripts,
    scanDomains: scan.scanDomains,
    ...over,
  };
}
const stored = (scan: ChangeLogScan) => ({
  scanId: scan.scanId,
  themeId: scan.themeId,
  createdAt: CREATED[scan.scanId as keyof typeof CREATED],
  entries: scan.manifest,
});

const SCANS: Record<string, ChangeLogScan> = {
  [BEFORE_SCAN_ID]: beforeScan(),
  [AFTER_SCAN_ID]: afterScan(),
  [SWITCH_SCAN_ID]: switchScan(),
};

beforeEach(() => {
  vi.clearAllMocks();
  m.getScanForChangeLog.mockImplementation(async (id: string) =>
    SCANS[id] ? dbRow(SCANS[id]) : null,
  );
  m.getScanManifest.mockImplementation(async (id: string) =>
    SCANS[id] ? stored(SCANS[id]) : null,
  );
  m.getLatestManifestForTheme.mockImplementation(async (_shop: string, themeId: string) =>
    themeId === THEME_ID ? stored(SCANS[BEFORE_SCAN_ID]) : null,
  );
  m.getLatestPublishedChangeSetBefore.mockResolvedValue({
    scanId: BEFORE_SCAN_ID,
    themeId: THEME_ID,
  });
  m.getRemovalNoticeRows.mockResolvedValue([PUSHOWL_REMOVED]);
  m.getIgnoredFindingsForShop.mockResolvedValue({ fingerprints: new Set(), appNames: new Set() });
  m.upsertScanChangeSet.mockResolvedValue({ scanId: AFTER_SCAN_ID });
});

const run = (over: Partial<Parameters<typeof recordChangeSetForScan>[0]> = {}) =>
  recordChangeSetForScan({
    scanId: AFTER_SCAN_ID,
    shopId: SHOP_ID,
    themeId: THEME_ID,
    isPublishedTheme: true,
    ...over,
  });

describe("recordChangeSetForScan", () => {
  it("compares with the theme's latest earlier manifest and saves the set", async () => {
    await expect(run()).resolves.toEqual({
      status: "saved",
      kind: "compared",
      changeCount: 4,
      worthALookCount: 2,
    });
    expect(m.getLatestManifestForTheme).toHaveBeenCalledWith(SHOP_ID, THEME_ID, {
      excludeScanId: AFTER_SCAN_ID,
      before: CREATED[AFTER_SCAN_ID],
    });
    expect(m.getRemovalNoticeRows).toHaveBeenCalledWith(SHOP_ID, THEME_ID, AFTER_SCAN_ID);
    const expected = computeChangeSet({
      current: afterScan(),
      baseline: beforeScan(),
      kind: "compared",
      removals: [PUSHOWL_REMOVED],
      ignores: { fingerprints: new Set(), appNames: new Set() },
    });
    expect(m.upsertScanChangeSet).toHaveBeenCalledWith(AFTER_SCAN_ID, {
      shopId: SHOP_ID,
      themeId: THEME_ID,
      checkKind: "weekly",
      onPublishedTheme: true,
      ...expected,
    });
  });

  it("a re-run (Inngest retry) writes the same row again: one upsert per run, same content", async () => {
    await run();
    await run();
    const [a, b] = m.upsertScanChangeSet.mock.calls;
    expect(a).toEqual(b);
  });

  it("the published theme changed: compares across themes (theme switch)", async () => {
    m.getLatestPublishedChangeSetBefore.mockResolvedValue({
      scanId: AFTER_SCAN_ID,
      themeId: THEME_ID,
    });
    m.getLatestManifestForTheme.mockImplementation(async (_s: string, themeId: string) =>
      themeId === THEME_ID ? stored(SCANS[AFTER_SCAN_ID]) : null,
    );
    m.getRemovalNoticeRows.mockResolvedValue([]);

    const out = await run({ scanId: SWITCH_SCAN_ID, themeId: OTHER_THEME_ID });

    expect(out).toMatchObject({ status: "saved", kind: "theme_switch", changeCount: 1 });
    expect(m.getLatestManifestForTheme).toHaveBeenCalledWith(SHOP_ID, THEME_ID, {
      before: CREATED[SWITCH_SCAN_ID],
    });
    const saved = m.upsertScanChangeSet.mock.calls[0][1];
    expect(saved).toMatchObject({
      themeId: OTHER_THEME_ID,
      baselineScanId: AFTER_SCAN_ID,
      kind: "theme_switch",
    });
    expect(saved.rows[0].type).toBe("theme_published");
  });

  it("a theme switch reads no AppRemoval rows: removal detection is per theme and adds nothing (M4)", async () => {
    m.getLatestPublishedChangeSetBefore.mockResolvedValue({
      scanId: AFTER_SCAN_ID,
      themeId: THEME_ID,
    });
    m.getLatestManifestForTheme.mockImplementation(async (_s: string, themeId: string) =>
      themeId === THEME_ID ? stored(SCANS[AFTER_SCAN_ID]) : null,
    );
    // Rows that would exist for this theme must not reach a switch.
    m.getRemovalNoticeRows.mockResolvedValue([PUSHOWL_REMOVED]);

    await run({ scanId: SWITCH_SCAN_ID, themeId: OTHER_THEME_ID });

    expect(m.getRemovalNoticeRows).not.toHaveBeenCalled();
    const saved = m.upsertScanChangeSet.mock.calls[0][1];
    expect(saved.kind).toBe("theme_switch");
    expect(saved.rows.some((r: { type: string }) => r.type === "app_inactive")).toBe(false);
  });

  it("theme switch with no surviving manifest for the old theme: falls back to this theme's own baseline", async () => {
    m.getLatestPublishedChangeSetBefore.mockResolvedValue({
      scanId: "x",
      themeId: "gid://shopify/Theme/999",
    });
    await expect(run()).resolves.toMatchObject({ kind: "compared" });
  });

  it("an unpublished or unknown theme never checks for a switch, and is saved as not published", async () => {
    for (const isPublishedTheme of [false, null]) {
      m.upsertScanChangeSet.mockClear();
      await run({ isPublishedTheme });
      expect(m.upsertScanChangeSet.mock.calls[0][1].onPublishedTheme).toBe(false);
    }
    expect(m.getLatestPublishedChangeSetBefore).not.toHaveBeenCalled();
  });

  it("no earlier manifest (first scan, legacy, pruned): a baseline check with no rows", async () => {
    m.getLatestManifestForTheme.mockResolvedValue(null);
    await expect(run()).resolves.toEqual({
      status: "saved",
      kind: "baseline",
      changeCount: 0,
      worthALookCount: 0,
    });
    expect(m.getRemovalNoticeRows).not.toHaveBeenCalled();
    expect(m.upsertScanChangeSet.mock.calls[0][1]).toMatchObject({
      kind: "baseline",
      baselineScanId: null,
      rows: [],
    });
  });

  it("a baseline manifest whose scan is gone or unusable: a baseline check", async () => {
    m.getScanForChangeLog.mockImplementation(async (id: string) =>
      id === AFTER_SCAN_ID ? dbRow(SCANS[AFTER_SCAN_ID]) : null,
    );
    await expect(run()).resolves.toMatchObject({ kind: "baseline" });
  });

  it("no manifest for this scan: skipped, nothing written", async () => {
    m.getScanManifest.mockResolvedValue(null);
    await expect(run()).resolves.toEqual({ status: "skipped", reason: "no_manifest" });
    expect(m.upsertScanChangeSet).not.toHaveBeenCalled();
  });

  it("the scan is missing or did not succeed: skipped, nothing written", async () => {
    m.getScanForChangeLog.mockResolvedValue(null);
    await expect(run()).resolves.toEqual({ status: "skipped", reason: "scan_not_found" });
    expect(m.upsertScanChangeSet).not.toHaveBeenCalled();
  });

  it.each([
    ["MANUAL", "Professional", "manual"],
    ["AUTO_PUBLISH", "Professional", "publish"],
    ["SCHEDULED", "Standard", "monthly"],
  ])("origin %s on %s saves a %s check", async (origin, plan, checkKind) => {
    m.getScanForChangeLog.mockImplementation(async (id: string) =>
      dbRow(SCANS[id], { origin, shop: { plan } }),
    );
    await run();
    expect(m.upsertScanChangeSet.mock.calls[0][1].checkKind).toBe(checkKind);
  });

  it("a read or write error propagates (the worker step contains it)", async () => {
    m.upsertScanChangeSet.mockRejectedValue(new Error("db down"));
    await expect(run()).rejects.toThrow("db down");
    m.getRemovalNoticeRows.mockRejectedValue(new Error("read failed"));
    await expect(run()).rejects.toThrow("read failed");
  });
});

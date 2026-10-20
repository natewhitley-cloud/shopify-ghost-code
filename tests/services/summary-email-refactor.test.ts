/**
 * gc-rrh.4: computeFindingChanges now counts the lists of diffFindingLists
 * (app/services/change-log.server.ts), which the "What changed" log shares.
 * This pins that the summary email is unchanged by that refactor: the
 * pre-refactor implementation is inlined below, verbatim, and both must give
 * the same result and the same rendered email (text and HTML, byte for byte)
 * over a matrix of the cases the old code handled (ignores, ignored malicious
 * code, advisories with the flag on and off, coverage gaps, newly live types,
 * unversioned scans).
 */
import { FindingType } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../app/db.server", () => ({ default: {} }));
vi.mock("../../app/models/merchant-alert.server", () => ({
  recordMerchantAlert: vi.fn(),
  ensureUnsubscribeToken: vi.fn(),
}));
vi.mock("../../app/services/shop-alert-email.server", () => ({ refreshShopContact: vi.fn() }));

import type { ShopIgnores } from "../../app/models/ignored-finding.server";
import { filterIgnoredExceptMalicious } from "../../app/services/finding-aggregation.server";
import {
  type DiffableFinding,
  diffScans,
  fingerprintFinding,
  parseLiveFindingTypes,
  restrictToLiveInBoth,
  type ScanCoverage,
  scanDiffOptions,
} from "../../app/services/scan-differ.server";
import {
  buildSummaryHash,
  buildSummaryHtml,
  buildSummaryText,
  computeFindingChanges,
} from "../../app/services/summary-email.server";
import { afterScan, beforeScan, finding } from "../fixtures/change-log-scans";

// --- The implementation before gc-rrh.4, verbatim ------------------------
type BaselineScan = ScanCoverage & { findings: DiffableFinding[]; liveFindingTypes: unknown };
function legacyComputeFindingChanges(args: {
  currentFindings: DiffableFinding[];
  currentCoverage: ScanCoverage & { skippedFiles: readonly string[] };
  currentLiveFindingTypes: unknown;
  baseline: BaselineScan;
  ignores: ShopIgnores;
}):
  | { ok: true; newCount: number; fixedCount: number; openCount: number }
  | { ok: false; reason: "baseline_unversioned" | "current_unversioned" } {
  const baselineLive = parseLiveFindingTypes(args.baseline.liveFindingTypes);
  if (!baselineLive) return { ok: false, reason: "baseline_unversioned" };
  const currentLive = parseLiveFindingTypes(args.currentLiveFindingTypes);
  if (!currentLive) return { ok: false, reason: "current_unversioned" };

  const emailed = <T extends DiffableFinding>(findings: T[]): T[] =>
    findings.filter((f) => f.findingType !== "APP_INCIDENT_ADVISORY");
  const current = filterIgnoredExceptMalicious(emailed(args.currentFindings), args.ignores).shown;
  const diff = diffScans(
    current,
    filterIgnoredExceptMalicious(emailed(args.baseline.findings), args.ignores).shown,
    scanDiffOptions(args.currentCoverage, args.baseline),
  );
  return {
    ok: true,
    newCount: restrictToLiveInBoth(diff.newFindings, baselineLive, currentLive).length,
    fixedCount: restrictToLiveInBoth(diff.resolvedFindings, baselineLive, currentLive).length,
    openCount: current.length,
  };
}
// ---------------------------------------------------------------------------

const ALL = Object.values(FindingType) as string[];
const NONE: ShopIgnores = { fingerprints: new Set(), appNames: new Set() };
const fp = (f: DiffableFinding) =>
  fingerprintFinding(f.filename, f.findingType, f.codeSnippet, f.lineNumber);

const malicious = finding({
  filename: "layout/theme.liquid",
  findingType: FindingType.MALICIOUS_SCRIPT,
  severity: "HIGH",
  codeSnippet: '<script src="https://bad.example/skim.js"></script>',
});
const advisory = finding({
  filename: "layout/theme.liquid",
  findingType: FindingType.APP_INCIDENT_ADVISORY,
  appName: "Klaviyo",
});
const oldAdvisory = finding({
  filename: "snippets/price.liquid",
  findingType: FindingType.APP_INCIDENT_ADVISORY,
  appName: "Klaviyo",
});
const product = finding({
  filename: "products/gid://shopify/Product/7",
  findingType: FindingType.GHOST_TAG,
  lineNumber: 0,
  codeSnippet: "old-tag",
});

type Case = {
  name: string;
  current: DiffableFinding[];
  baseline: DiffableFinding[];
  currentCoverage?: Partial<ScanCoverage & { skippedFiles: string[] }>;
  baselineCoverage?: Partial<ScanCoverage>;
  ignores?: ShopIgnores;
  advisoriesShown?: boolean;
};

const after = afterScan();
const before = beforeScan();
const CASES: Case[] = [
  { name: "fixture week", current: after.findings, baseline: before.findings },
  {
    name: "all live both sides",
    current: after.findings,
    baseline: before.findings,
    baselineCoverage: { liveFindingTypes: ALL },
    currentCoverage: { liveFindingTypes: ALL },
  },
  { name: "everything fixed", current: [], baseline: [...before.findings, product] },
  { name: "nothing before", current: [...after.findings, product], baseline: [] },
  {
    name: "instance and app ignores",
    current: [...after.findings, product],
    baseline: before.findings,
    ignores: { fingerprints: new Set([fp(product)]), appNames: new Set(["PushOwl"]) },
  },
  {
    name: "ignored known malicious code still counts",
    current: [...after.findings, malicious],
    baseline: before.findings,
    ignores: { fingerprints: new Set([fp(malicious)]), appNames: new Set() },
  },
  {
    name: "advisories, flag on",
    current: [...after.findings, advisory],
    baseline: [...before.findings, oldAdvisory],
    currentCoverage: { liveFindingTypes: ALL },
    baselineCoverage: { liveFindingTypes: ALL },
    advisoriesShown: true,
  },
  {
    name: "advisories, flag off",
    current: [...after.findings, advisory],
    baseline: [...before.findings, oldAdvisory],
    currentCoverage: { liveFindingTypes: ALL },
    baselineCoverage: { liveFindingTypes: ALL },
  },
  {
    name: "current skipped a category",
    current: [],
    baseline: before.findings,
    currentCoverage: { skippedCategories: [FindingType.GHOST_SCRIPT] },
  },
  {
    name: "baseline capped a category",
    current: after.findings,
    baseline: before.findings,
    baselineCoverage: { cappedCategories: [FindingType.GHOST_STYLE] },
  },
  {
    name: "oversized file skipped",
    current: [],
    baseline: before.findings,
    currentCoverage: { skippedFiles: ["snippets/pushowl.liquid"] },
  },
  {
    name: "unversioned baseline",
    current: after.findings,
    baseline: before.findings,
    baselineCoverage: { liveFindingTypes: null },
  },
  {
    name: "unversioned current",
    current: after.findings,
    baseline: before.findings,
    currentCoverage: { liveFindingTypes: undefined },
  },
];

function argsFor(c: Case) {
  const currentCoverage = { ...after.coverage, ...c.currentCoverage };
  return {
    currentFindings: c.current,
    currentCoverage,
    currentLiveFindingTypes: currentCoverage.liveFindingTypes,
    baseline: { ...before.coverage, ...c.baselineCoverage, findings: c.baseline },
    ignores: c.ignores ?? NONE,
  } as Parameters<typeof legacyComputeFindingChanges>[0];
}

afterEach(() => {
  delete process.env.APP_INCIDENT_ADVISORY_LIVE_ENABLED;
});

describe("computeFindingChanges is unchanged by the gc-rrh.4 refactor", () => {
  it.each(CASES)("$name: same result as before", (c) => {
    if (c.advisoriesShown) process.env.APP_INCIDENT_ADVISORY_LIVE_ENABLED = "true";
    const args = argsFor(c);
    expect(computeFindingChanges(args)).toEqual(legacyComputeFindingChanges(args));
  });

  it("the matrix is not vacuous: it covers new, fixed, open and both unversioned reasons", () => {
    const results = CASES.map((c) => {
      if (c.advisoriesShown) process.env.APP_INCIDENT_ADVISORY_LIVE_ENABLED = "true";
      const r = legacyComputeFindingChanges(argsFor(c));
      delete process.env.APP_INCIDENT_ADVISORY_LIVE_ENABLED;
      return r;
    });
    expect(results.some((r) => r.ok && r.newCount > 0)).toBe(true);
    expect(results.some((r) => r.ok && r.fixedCount > 0)).toBe(true);
    expect(results.some((r) => r.ok && r.openCount > 0)).toBe(true);
    expect(results).toContainEqual({ ok: false, reason: "baseline_unversioned" });
    expect(results).toContainEqual({ ok: false, reason: "current_unversioned" });
  });

  it.each(CASES)("$name: the rendered email and its hash are byte-identical", (c) => {
    if (c.advisoriesShown) process.env.APP_INCIDENT_ADVISORY_LIVE_ENABLED = "true";
    const args = argsFor(c);
    const now = computeFindingChanges(args);
    const then = legacyComputeFindingChanges(args);
    if (!now.ok || !then.ok) {
      expect(now).toEqual(then);
      return;
    }
    const render = (r: { newCount: number; fixedCount: number; openCount: number }) => {
      const changes = {
        newCount: r.newCount,
        fixedCount: r.fixedCount,
        openCount: r.openCount,
        inactiveApps: [{ appName: "PushOwl", leftoverCount: 2 }],
        cleanedApps: [],
      };
      const opts = {
        storeName: "Paw Naturals",
        shopDomain: "paw.myshopify.com",
        cadence: "weekly" as const,
        changes,
        baseline: "previous_scan" as const,
        scanUrl: "https://admin.shopify.com/store/paw/apps/ghost-code/app/scans/s1",
        unsubscribeUrl: "https://app.example.com/unsubscribe#t=tok",
      };
      return {
        text: buildSummaryText(opts),
        html: buildSummaryHtml(opts),
        hash: buildSummaryHash(changes),
      };
    };
    expect(render(now)).toEqual(render(then));
  });
});

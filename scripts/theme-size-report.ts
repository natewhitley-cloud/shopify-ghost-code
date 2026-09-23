// READ-ONLY operator script: calibrate MAX_THEME_TOTAL_TEXT_BYTES against real
// theme-size data (gc-d4e). Reads scan_signal OpsEvent rows and prints
// count, max/p95/median of totalTextBytes and largestFileBytes, the ratio of
// the observed max to the current cap, and how many scans aborted over the cap.
// Run: npx tsx --env-file=.env scripts/theme-size-report.ts
// No writes. Safe against prod.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { PrismaClient } from "@prisma/client";

import { MAX_THEME_TOTAL_TEXT_BYTES } from "../app/services/theme-fetcher.server";

const prisma = new PrismaClient();

/** A completed scan's size fields from scan_signal metadata. */
export interface ThemeSizeSample {
  kind: "completed";
  totalTextBytes: number;
  largestFileBytes: number;
}

/**
 * A scan aborted over MAX_THEME_TOTAL_TEXT_BYTES (gc-d4e follow-up). Its
 * scan_signal carries `aborted: "theme_too_large"` and the cumulative text
 * length at abort — a LOWER bound on that theme's true size.
 */
export interface AbortedThemeSample {
  kind: "aborted";
  bytesAtAbort: number;
  maxTotalBytes: number;
}

/**
 * Classify a scan_signal row's metadata as a completed sample, an aborted
 * over-cap sample, or null when the row predates the size fields (gc-d4e) or
 * the fields are malformed. Pure — no I/O — so it's unit-testable without a DB.
 */
export function parseThemeSizeSample(
  metadata: unknown,
): ThemeSizeSample | AbortedThemeSample | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  const { totalTextBytes, largestFileBytes, aborted, bytesAtAbort, maxTotalBytes } =
    metadata as Record<string, unknown>;
  if (aborted !== undefined) {
    if (aborted !== "theme_too_large") return null;
    if (typeof bytesAtAbort !== "number" || typeof maxTotalBytes !== "number") return null;
    return { kind: "aborted", bytesAtAbort, maxTotalBytes };
  }
  if (typeof totalTextBytes !== "number" || typeof largestFileBytes !== "number") return null;
  return { kind: "completed", totalTextBytes, largestFileBytes };
}

/** Rollup of all scan_signal rows for the report. Pure, unit-testable. */
export interface ScanSignalSummary {
  completed: ThemeSizeSample[];
  abortedCount: number;
  maxBytesAtAbort: number;
  skipped: number;
}

export function summarizeScanSignals(metadatas: unknown[]): ScanSignalSummary {
  const summary: ScanSignalSummary = {
    completed: [],
    abortedCount: 0,
    maxBytesAtAbort: 0,
    skipped: 0,
  };
  for (const metadata of metadatas) {
    const sample = parseThemeSizeSample(metadata);
    if (sample === null) {
      summary.skipped += 1;
    } else if (sample.kind === "aborted") {
      summary.abortedCount += 1;
      summary.maxBytesAtAbort = Math.max(summary.maxBytesAtAbort, sample.bytesAtAbort);
    } else {
      summary.completed.push(sample);
    }
  }
  return summary;
}

/** Aggregate stats over a numeric sample. Pure, unit-testable. */
export interface SampleStats {
  count: number;
  max: number;
  p95: number;
  median: number;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

/**
 * Compute count/max/p95/median over a set of values. Returns all-zero stats
 * for an empty input rather than throwing — an empty sample (no rows with the
 * new fields yet) is an expected, reportable state, not an error.
 */
export function computeStats(values: number[]): SampleStats {
  if (values.length === 0) {
    return { count: 0, max: 0, p95: 0, median: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    max: sorted[sorted.length - 1],
    p95: percentile(sorted, 95),
    median: percentile(sorted, 50),
  };
}

function fmtBytes(n: number): string {
  return `${n.toLocaleString()} (${(n / 1_000_000).toFixed(1)}MB)`;
}

async function main() {
  const rows = await prisma.opsEvent.findMany({
    where: { eventType: "scan_signal" },
    select: { metadata: true },
  });

  const {
    completed: samples,
    abortedCount,
    maxBytesAtAbort,
    skipped,
  } = summarizeScanSignals(rows.map((row) => row.metadata));

  const totalStats = computeStats(samples.map((s) => s.totalTextBytes));
  const largestStats = computeStats(samples.map((s) => s.largestFileBytes));

  console.log(
    `\n=== Theme size report (${samples.length} scan_signal rows, ${skipped} skipped — predate totalTextBytes) ===`,
  );
  console.log(`\ntotalTextBytes:`);
  console.log(
    `  count=${totalStats.count}  max=${fmtBytes(totalStats.max)}  p95=${fmtBytes(totalStats.p95)}  median=${fmtBytes(totalStats.median)}`,
  );
  console.log(`\nlargestFileBytes:`);
  console.log(
    `  count=${largestStats.count}  max=${fmtBytes(largestStats.max)}  p95=${fmtBytes(largestStats.p95)}  median=${fmtBytes(largestStats.median)}`,
  );
  console.log(`\nMAX_THEME_TOTAL_TEXT_BYTES = ${fmtBytes(MAX_THEME_TOTAL_TEXT_BYTES)}`);
  if (totalStats.count > 0) {
    console.log(
      `  observed max / cap = ${(totalStats.max / MAX_THEME_TOTAL_TEXT_BYTES).toFixed(4)}`,
    );
  } else {
    console.log(`  no samples yet — cannot compute ratio`);
  }
  console.log(`\nAborted over the cap (theme_too_large): ${abortedCount}`);
  if (abortedCount > 0) {
    console.log(
      `  max bytesAtAbort = ${fmtBytes(maxBytesAtAbort)} (a lower bound — the fetch stopped there)`,
    );
  }
}

/**
 * True when `argv1` (process.argv[1]) is the module at `metaUrl`. Resolves
 * symlinks and URL-encodes the path, so a checkout under a path with spaces
 * or a symlinked dir (macOS /tmp -> /private/tmp) still matches — the naive
 * `file://${argv1}` string compare silently skipped main() there.
 */
export function isMainModule(metaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  try {
    return pathToFileURL(realpathSync(argv1)).href === metaUrl;
  } catch {
    // argv[1] does not resolve to a file (e.g. deleted) — cannot be this module.
    return false;
  }
}

// Only run when executed directly (`npx tsx scripts/theme-size-report.ts`),
// not when the pure helpers above are imported by unit tests.
if (isMainModule(import.meta.url, process.argv[1])) {
  main()
    .then(() => prisma.$disconnect())
    .catch(async (e) => {
      console.error(e);
      await prisma.$disconnect();
      process.exit(1);
    });
}

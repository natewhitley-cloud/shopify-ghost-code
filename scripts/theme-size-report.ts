// READ-ONLY operator script: calibrate MAX_THEME_TOTAL_TEXT_BYTES against real
// theme-size data (gc-d4e). Reads scan_signal OpsEvent rows and prints
// count, max/p95/median of totalTextBytes and largestFileBytes, plus the
// ratio of the observed max to the current cap.
// Run: npx tsx --env-file=.env scripts/theme-size-report.ts
// No writes. Safe against prod.
import { PrismaClient } from "@prisma/client";

import { MAX_THEME_TOTAL_TEXT_BYTES } from "../app/services/theme-fetcher.server";

const prisma = new PrismaClient();

/** The subset of scan_signal metadata this report reads. */
export interface ThemeSizeSample {
  totalTextBytes: number;
  largestFileBytes: number;
}

/**
 * Extract a ThemeSizeSample from a scan_signal row's metadata, or null when
 * the row predates the totalTextBytes/largestFileBytes fields (gc-d4e) or the
 * fields are malformed. Pure — no I/O — so it's unit-testable without a DB.
 */
export function parseThemeSizeSample(metadata: unknown): ThemeSizeSample | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  const { totalTextBytes, largestFileBytes } = metadata as Record<string, unknown>;
  if (typeof totalTextBytes !== "number" || typeof largestFileBytes !== "number") return null;
  return { totalTextBytes, largestFileBytes };
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

  const samples: ThemeSizeSample[] = [];
  let skipped = 0;
  for (const row of rows) {
    const sample = parseThemeSizeSample(row.metadata);
    if (sample) {
      samples.push(sample);
    } else {
      skipped += 1;
    }
  }

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
}

// Only run when executed directly (`npx tsx scripts/theme-size-report.ts`),
// not when the pure helpers above are imported by unit tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(() => prisma.$disconnect())
    .catch(async (e) => {
      console.error(e);
      await prisma.$disconnect();
      process.exit(1);
    });
}

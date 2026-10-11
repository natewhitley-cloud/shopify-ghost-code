/**
 * The store speed report is fully decoupled from the theme scan (gc-wt3y,
 * Nathan 2026-10-11):
 *   - the scan pipeline (scan-theme worker, poll-check-shop, weekly/monthly
 *     scan coordinators, scan engine/differ, summary email) never imports,
 *     calls or waits on any speed-report / PageSpeed module, so a PageSpeed
 *     hang or failure cannot delay or fail a scan, or show up in its
 *     skipped/unreachable categories;
 *   - Home and the scan results page render with no dependency on speed data;
 *   - the speed report is triggered by its OWN cron, not chained off a scan
 *     (no step.invoke / waitForEvent / scan event).
 *
 * Proof 1 (static, transitive): walk every relative import (static and
 * dynamic `import("...")`) from each scan-side entry point and assert no
 * speed module is reachable.
 * Proof 2 (runtime): with the PageSpeed client and speed services mocked to
 * THROW on any use, the scan-side modules still load.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { describe, it, expect, vi } from "vitest";

const ROOT = join(__dirname, "..", "..");

const SPEED_MODULES = [
  "app/services/pagespeed-client.server.ts",
  "app/services/speed-attribution.server.ts",
  "app/services/speed-report.server.ts",
  "app/services/speed-report-config.server.ts",
  "app/models/speed-report.server.ts",
  "app/lib/speed-report.ts",
  "inngest/functions/speed-report.ts",
];

const SCAN_ENTRY_POINTS = [
  "inngest/functions/scan-theme.ts",
  "inngest/functions/poll-check-shop.ts",
  "inngest/functions/weekly-scan.ts",
  "inngest/functions/monthly-scan.ts",
  "inngest/functions/check-scan-stale.ts",
  "app/services/scan-engine.server.ts",
  "app/services/scan-differ.server.ts",
  "app/services/summary-email.server.ts",
  "app/services/scan-dispatch.server.ts",
  "app/routes/app._index.tsx",
  "app/routes/app.scans.$scanId.tsx",
];

const IMPORT_RE =
  /(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;

function resolveRelative(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate) && candidate.match(/\.(ts|tsx)$/)) return candidate;
  }
  return null;
}

/** Every local module reachable from `entry` (relative imports only). */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [join(ROOT, entry)];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(IMPORT_RE)) {
      const next = resolveRelative(file, m[1] ?? m[2] ?? m[3]);
      if (next && !seen.has(next)) stack.push(next);
    }
  }
  return new Set([...seen].map((f) => relative(ROOT, f)));
}

describe("scan pipeline never depends on the speed report (static)", () => {
  it("the import walker sees real edges (sanity: the speed worker reaches the PageSpeed client)", () => {
    const graph = reachable("inngest/functions/speed-report.ts");
    expect(graph).toContain("app/services/pagespeed-client.server.ts");
    expect(graph).toContain("app/services/speed-report.server.ts");
  });

  it.each(SCAN_ENTRY_POINTS)("%s reaches no speed module", (entry) => {
    const graph = reachable(entry);
    expect(graph.size).toBeGreaterThan(1);
    for (const mod of SPEED_MODULES) expect(graph).not.toContain(mod);
  });

  it("the speed report is its own cron, never chained off a scan", () => {
    const worker = readFileSync(join(ROOT, "inngest/functions/speed-report.ts"), "utf8");
    expect(worker).toMatch(/\{ cron: SPEED_REPORT_CRON \}/);
    expect(worker).toMatch(/\{ event: "speed-report\/requested" \}/);
    expect(worker).not.toMatch(/step\.(invoke|waitForEvent)\(/);
    // No scan-side code sends the speed event.
    for (const entry of SCAN_ENTRY_POINTS) {
      expect(readFileSync(join(ROOT, entry), "utf8")).not.toContain("speed-report/requested");
    }
  });
});

// Runtime: any use of the PageSpeed client or the speed services throws.
const explode = () => {
  throw new Error("speed report used from the scan path");
};
vi.mock("../../app/services/pagespeed-client.server", () => ({
  callPageSpeed: vi.fn(explode),
  buildPageSpeedRequestUrl: vi.fn(explode),
}));
vi.mock("../../app/services/speed-report.server", () => ({
  prepareSpeedReportRun: vi.fn(explode),
  runPageSpeedAttempt: vi.fn(explode),
  finalizeSpeedReport: vi.fn(explode),
  requestSpeedReportRunNow: vi.fn(explode),
}));
vi.mock("../../app/db.server", () => ({ default: {} }));
vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: vi.fn() },
  unauthenticated: { admin: vi.fn() },
}));

describe("scan pipeline never depends on the speed report (runtime)", () => {
  it("scan worker, scan engine and the scan/Home routes load with PageSpeed rigged to throw", async () => {
    const mods = await Promise.all([
      import("../../inngest/functions/scan-theme"),
      import("../../inngest/functions/poll-check-shop"),
      import("../../app/services/scan-engine.server"),
      import("../../app/routes/app._index"),
      import("../../app/routes/app.scans.$scanId"),
    ]);
    for (const m of mods) expect(m).toBeTruthy();
    const { callPageSpeed } = await import("../../app/services/pagespeed-client.server");
    expect(callPageSpeed).not.toHaveBeenCalled();
  });
});

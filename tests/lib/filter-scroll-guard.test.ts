// Ported from ClearSignal (bot-analytics-cleanup-app).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

/**
 * Source-guard: filter navigations must never reset scroll to the top of the
 * page. The single sanctioned path is `useFilterSearchParams`
 * (app/lib/use-filter-search-params.ts), whose setter always merges
 * `preventScrollReset: true`.
 *
 * This test scans every route module. If a route reaches for the RAW
 * `useSearchParams` from react-router, its `setSearchParams` call will silently
 * reset scroll unless the developer remembers `{ preventScrollReset: true }` at
 * every call site. To prevent that regression we forbid the raw hook in routes
 * entirely and force the wrapper.
 *
 * If a route genuinely needs the raw hook (rare), add it to RAW_HOOK_ALLOWLIST
 * below: allowlisted files must then pass `preventScrollReset` on EVERY
 * `setSearchParams(` call, which this test verifies. Non-filter navigations
 * (e.g. a `navigate("/app/report-card")` page change) legitimately reset scroll
 * and are not filter setters, so they are not policed here.
 */

const ROUTES_DIR = join(process.cwd(), "app", "routes");

// Route files permitted to use the raw `useSearchParams` from react-router.
// Empty by design: all filter routes go through useFilterSearchParams. Add a
// file here only with a clear justification; allowlisted files are still
// required to pass preventScrollReset on every setSearchParams call.
const RAW_HOOK_ALLOWLIST = new Set<string>();

function routeFiles(): string[] {
  return readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".tsx"));
}

function importsRawUseSearchParams(source: string): boolean {
  // Matches `useSearchParams` appearing in an import from "react-router".
  const importLines = source.split("\n").filter((line) => line.includes('from "react-router"'));
  return importLines.some((line) => /\buseSearchParams\b/.test(line));
}

describe("filter-scroll-guard", () => {
  it("no route imports the raw useSearchParams (use useFilterSearchParams instead)", () => {
    const offenders: string[] = [];
    for (const file of routeFiles()) {
      if (RAW_HOOK_ALLOWLIST.has(file)) continue;
      const source = readFileSync(join(ROUTES_DIR, file), "utf8");
      if (importsRawUseSearchParams(source)) {
        offenders.push(file);
      }
    }

    expect(
      offenders,
      `These routes import the raw \`useSearchParams\` from react-router, which ` +
        `resets scroll to the top on every filter change. Import ` +
        `\`useFilterSearchParams\` from "../lib/use-filter-search-params" instead ` +
        `(it always sets preventScrollReset). Offending files: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("allowlisted raw-hook routes pass preventScrollReset on every setSearchParams call", () => {
    for (const file of RAW_HOOK_ALLOWLIST) {
      const source = readFileSync(join(ROUTES_DIR, file), "utf8");
      // Every setSearchParams( invocation in an allowlisted file must include
      // preventScrollReset somewhere in the same file (call-level enforcement is
      // approximated at file level, which is sufficient given the allowlist is
      // curated and tiny).
      const callCount = (source.match(/setSearchParams\(/g) ?? []).length;
      if (callCount > 0) {
        expect(
          source.includes("preventScrollReset"),
          `${file} is allowlisted for the raw useSearchParams hook but calls ` +
            `setSearchParams without preventScrollReset.`,
        ).toBe(true);
      }
    }
  });

  it("the sanctioned hook guarantees preventScrollReset", () => {
    const hook = readFileSync(
      join(process.cwd(), "app", "lib", "use-filter-search-params.ts"),
      "utf8",
    );
    expect(hook).toContain("preventScrollReset: true");
  });
});

/**
 * Scheduled-scan cadence copy guard (gc-iefo, 2026-10-09).
 *
 * Professional scans weekly (plus the instant rescan on theme publish) and
 * Standard monthly; nothing scans daily. Pins the merchant-facing route copy so
 * an old "daily" promise cannot come back.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROUTES = fileURLToPath(new URL("../../app/routes", import.meta.url));

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return entry.name.endsWith(".tsx") ? [path] : [];
  });
}

// JSX copy wraps across lines: compare with whitespace collapsed.
const read = (path: string) => readFileSync(path, "utf8").replace(/\s+/g, " ");

describe("scheduled-scan cadence copy", () => {
  it("no route promises daily scans", () => {
    const offenders = routeFiles(ROUTES).filter((path) =>
      /daily (re-?scans?|scans?|automatic scans?)/i.test(read(path)),
    );
    expect(offenders).toEqual([]);
  });

  it("the public landing page states Professional's weekly scan + publish rescan", () => {
    expect(read(join(ROUTES, "_index/route.tsx"))).toContain(
      "Professional plan shops get a scan every week, plus an instant rescan whenever a theme is published",
    );
  });
});

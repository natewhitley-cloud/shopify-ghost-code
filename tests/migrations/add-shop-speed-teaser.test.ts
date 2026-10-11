/**
 * Guard test for the gc-iirv migration (20261014120000_add_shop_speed_teaser).
 *
 * Tests never touch a database (.env points at prod), so this pins the reviewed
 * SQL text: one additive ALTER TABLE on Shop, three nullable timestamps, and
 * nothing else.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

const ROOT = join(__dirname, "..", "..");
const SQL = readFileSync(
  join(ROOT, "prisma/migrations/20261014120000_add_shop_speed_teaser/migration.sql"),
  "utf8",
);
const SCHEMA = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");

/** The executable SQL only (comment lines stripped), whitespace-collapsed. */
const CODE = SQL.split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join(" ")
  .replace(/\s+/g, " ")
  .trim();

const TIMESTAMPS = ["speedTeaserClickedAt", "speedTeaserConvertedAt", "speedTeaserShownAt"];

describe("add_shop_speed_teaser migration (gc-iirv)", () => {
  it("is exactly one additive ALTER TABLE with no backfill, drop or rename", () => {
    expect(CODE).toBe(
      'ALTER TABLE "Shop" ADD COLUMN "speedTeaserClickedAt" TIMESTAMP(3), ' +
        'ADD COLUMN "speedTeaserConvertedAt" TIMESTAMP(3), ' +
        'ADD COLUMN "speedTeaserShownAt" TIMESTAMP(3);',
    );
  });

  it("matches the Prisma schema (optional DateTimes)", () => {
    for (const column of TIMESTAMPS) {
      expect(SCHEMA).toMatch(new RegExp(`\\n\\s+${column}\\s+DateTime\\?\\n`));
    }
  });

  it("sorts after the previous latest migration", () => {
    const dirs = readdirSync(join(ROOT, "prisma/migrations"))
      .filter((d) => /^\d{14}_/.test(d))
      .sort();
    const self = dirs.indexOf("20261014120000_add_shop_speed_teaser");
    const previous = dirs.indexOf("20261013120002_speed_report_run_tracking");
    // Both must exist: a missing name (-1) must fail, not pass vacuously.
    expect(self).toBeGreaterThanOrEqual(0);
    expect(previous).toBeGreaterThanOrEqual(0);
    expect(self).toBeGreaterThan(previous);
  });
});

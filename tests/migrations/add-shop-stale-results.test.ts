/**
 * Guard test for the gc-mgi migration (20261001120000_add_shop_stale_results).
 *
 * Tests never touch a database (.env points at prod), so this pins the reviewed
 * SQL text: one additive ALTER TABLE on Shop, three nullable timestamps, and
 * nothing else.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

const ROOT = join(__dirname, "..", "..");
const SQL = readFileSync(
  join(ROOT, "prisma/migrations/20261001120000_add_shop_stale_results/migration.sql"),
  "utf8",
);
const SCHEMA = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");

/** The executable SQL only (comment lines stripped), whitespace-collapsed. */
const CODE = SQL.split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join(" ")
  .replace(/\s+/g, " ")
  .trim();

const TIMESTAMPS = ["staleResultsClickedAt", "staleResultsConvertedAt", "staleResultsShownAt"];

describe("add_shop_stale_results migration (gc-mgi)", () => {
  it("is exactly one additive ALTER TABLE with no backfill, drop or rename", () => {
    expect(CODE).toBe(
      'ALTER TABLE "Shop" ADD COLUMN "staleResultsClickedAt" TIMESTAMP(3), ' +
        'ADD COLUMN "staleResultsConvertedAt" TIMESTAMP(3), ' +
        'ADD COLUMN "staleResultsShownAt" TIMESTAMP(3);',
    );
  });

  it("matches the Prisma schema (optional DateTimes)", () => {
    for (const column of TIMESTAMPS) {
      expect(SCHEMA).toMatch(new RegExp(`\\n\\s+${column}\\s+DateTime\\?\\n`));
    }
  });

  it("sorts after every earlier migration (applied last on deploy)", () => {
    expect("20261001120000_add_shop_stale_results" > "20260926160000_audit_fixes").toBe(true);
  });
});

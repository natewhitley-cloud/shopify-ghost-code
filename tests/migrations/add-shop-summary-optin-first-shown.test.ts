/**
 * Guard test for the gc-rxq0 migration
 * (20261016120000_add_shop_summary_optin_first_shown).
 *
 * Tests never touch a database (.env points at prod), so this pins the reviewed
 * SQL text: one additive ALTER TABLE on Shop, one nullable timestamp, no
 * default and no backfill (every existing shop's 14-day offer starts at its
 * next render).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

const ROOT = join(__dirname, "..", "..");
const NAME = "20261016120000_add_shop_summary_optin_first_shown";
const SQL = readFileSync(join(ROOT, "prisma/migrations", NAME, "migration.sql"), "utf8");
const SCHEMA = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");

/** The executable SQL only (comment lines stripped), whitespace-collapsed. */
const CODE = SQL.split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join(" ")
  .replace(/\s+/g, " ")
  .trim();

describe("add_shop_summary_optin_first_shown migration (gc-rxq0)", () => {
  it("is exactly one additive ALTER TABLE: a nullable timestamp, no default, no backfill", () => {
    expect(CODE).toBe('ALTER TABLE "Shop" ADD COLUMN "summaryOptInFirstShownAt" TIMESTAMP(3);');
  });

  it("documents the rollback", () => {
    expect(SQL).toContain('ALTER TABLE "Shop" DROP COLUMN "summaryOptInFirstShownAt";');
  });

  it("matches the Prisma schema (optional DateTime on Shop)", () => {
    expect(SCHEMA).toMatch(/model Shop \{[\s\S]*?\n\s+summaryOptInFirstShownAt\s+DateTime\?\n/);
  });

  it("sorts after gc-xorg's decline column (the free speed test column follows it)", () => {
    const dirs = readdirSync(join(ROOT, "prisma/migrations"))
      .filter((d) => /^\d{14}_/.test(d))
      .sort();
    const self = dirs.indexOf(NAME);
    const previous = dirs.indexOf("20261015120000_add_shop_summary_optin_declined");
    // Both must exist: a missing name (-1) must fail, not pass vacuously.
    expect(self).toBeGreaterThanOrEqual(0);
    expect(previous).toBeGreaterThanOrEqual(0);
    expect(self).toBe(previous + 1);
  });
});

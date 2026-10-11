/**
 * Guard test for the gc-xorg migration
 * (20261015120000_add_shop_summary_optin_declined).
 *
 * Tests never touch a database (.env points at prod), so this pins the reviewed
 * SQL text: one additive ALTER TABLE on Shop, one nullable timestamp, no
 * default and no backfill (every existing shop starts undecided).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

const ROOT = join(__dirname, "..", "..");
const NAME = "20261015120000_add_shop_summary_optin_declined";
const SQL = readFileSync(join(ROOT, "prisma/migrations", NAME, "migration.sql"), "utf8");
const SCHEMA = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");

/** The executable SQL only (comment lines stripped), whitespace-collapsed. */
const CODE = SQL.split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join(" ")
  .replace(/\s+/g, " ")
  .trim();

describe("add_shop_summary_optin_declined migration (gc-xorg)", () => {
  it("is exactly one additive ALTER TABLE: a nullable timestamp, no default, no backfill", () => {
    expect(CODE).toBe('ALTER TABLE "Shop" ADD COLUMN "summaryOptInDeclinedAt" TIMESTAMP(3);');
  });

  it("documents the rollback", () => {
    expect(SQL).toContain('ALTER TABLE "Shop" DROP COLUMN "summaryOptInDeclinedAt";');
  });

  it("matches the Prisma schema (optional DateTime on Shop)", () => {
    expect(SCHEMA).toMatch(/model Shop \{[\s\S]*?\n\s+summaryOptInDeclinedAt\s+DateTime\?\n/);
  });

  it("is the latest migration (applied last on deploy)", () => {
    const dirs = readdirSync(join(ROOT, "prisma/migrations")).filter((d) => /^\d{14}_/.test(d));
    expect(dirs.sort().at(-1)).toBe(NAME);
  });
});

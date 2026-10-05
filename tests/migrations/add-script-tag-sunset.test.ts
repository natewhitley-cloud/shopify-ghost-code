/**
 * Guard test for the script-tag sunset migration
 * (20261005120000_add_script_tag_sunset).
 *
 * Tests never touch a database (.env points at prod), so this pins the reviewed
 * SQL text: one additive enum value and one defaulted, non-null String[] column
 * on Scan (existing rows read as "nothing unreachable"), matching the schema.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

const ROOT = join(__dirname, "..", "..");
const NAME = "20261005120000_add_script_tag_sunset";
const SQL = readFileSync(join(ROOT, "prisma/migrations", NAME, "migration.sql"), "utf8");
const SCHEMA = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");

const CODE = SQL.split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join(" ")
  .replace(/\s+/g, " ")
  .trim();

describe("add_script_tag_sunset migration", () => {
  it("adds exactly the enum value and the defaulted column", () => {
    expect(CODE).toBe(
      `ALTER TYPE "FindingType" ADD VALUE IF NOT EXISTS 'SCRIPT_TAG_SUNSET'; ` +
        `ALTER TABLE "Scan" ADD COLUMN "unreachableCategories" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];`,
    );
  });

  it("is destructive-free", () => {
    expect(CODE).not.toMatch(/\b(DROP|DELETE|UPDATE|RENAME|TRUNCATE)\b/i);
  });

  it("matches the Prisma schema", () => {
    expect(SCHEMA).toMatch(
      /model Scan \{[\s\S]*?\n\s+unreachableCategories\s+String\[\]\s+@default\(\[\]\)\n/,
    );
    expect(SCHEMA).toMatch(/enum FindingType \{[\s\S]*?\n\s+SCRIPT_TAG_SUNSET\n\}/);
  });

  it("is the latest migration", () => {
    const dirs = readdirSync(join(ROOT, "prisma/migrations")).filter((d) => /^\d{14}_/.test(d));
    expect(dirs.sort().at(-1)).toBe(NAME);
  });
});

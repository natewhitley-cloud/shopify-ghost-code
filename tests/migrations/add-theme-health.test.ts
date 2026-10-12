/**
 * Guard test for the theme health migration (20261018120000_add_theme_health).
 *
 * Tests never touch a database (.env points at prod), so this pins the reviewed
 * SQL text: one additive enum value and one nullable JSONB column on Scan, no
 * default and no backfill, matching the schema.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

const ROOT = join(__dirname, "..", "..");
const NAME = "20261018120000_add_theme_health";
const SQL = readFileSync(join(ROOT, "prisma/migrations", NAME, "migration.sql"), "utf8");
const SCHEMA = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");

/** The executable SQL only (comment lines stripped), whitespace-collapsed. */
const CODE = SQL.split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join(" ")
  .replace(/\s+/g, " ")
  .trim();

describe("add_theme_health migration (gc-i6du)", () => {
  it("adds exactly the enum value and a nullable JSONB column", () => {
    expect(CODE).toBe(
      `ALTER TYPE "FindingType" ADD VALUE IF NOT EXISTS 'LIQUID_ERROR_RENDERED'; ` +
        `ALTER TABLE "Scan" ADD COLUMN "themeInfo" JSONB;`,
    );
  });

  it("is destructive-free and documents the rollback", () => {
    expect(CODE).not.toMatch(/\b(DROP|DELETE|UPDATE|RENAME|TRUNCATE)\b/i);
    expect(SQL).toContain('ALTER TABLE "Scan" DROP COLUMN "themeInfo";');
  });

  it("matches the Prisma schema", () => {
    expect(SCHEMA).toMatch(/model Scan \{[\s\S]*?\n\s+themeInfo\s+Json\?\n/);
    expect(SCHEMA).toMatch(/enum FindingType \{[\s\S]*?\n\s+LIQUID_ERROR_RENDERED\n\}/);
  });

  it("is the latest migration (applied last on deploy), after the free speed test column", () => {
    const dirs = readdirSync(join(ROOT, "prisma/migrations"))
      .filter((d) => /^\d{14}_/.test(d))
      .sort();
    expect(dirs.at(-1)).toBe(NAME);
    expect(dirs.at(-2)).toBe("20261017120000_add_shop_free_speed_test_used");
  });
});

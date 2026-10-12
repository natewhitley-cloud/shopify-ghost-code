/**
 * Guard test for the free speed test migration
 * (20261017120000_add_shop_free_speed_test_used).
 *
 * Tests never touch a database (.env points at prod), so this pins the reviewed
 * SQL text: one additive ALTER TABLE on Shop, one nullable timestamp, no
 * default and no backfill (no shop has used the free test yet).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

const ROOT = join(__dirname, "..", "..");
const NAME = "20261017120000_add_shop_free_speed_test_used";
const SQL = readFileSync(join(ROOT, "prisma/migrations", NAME, "migration.sql"), "utf8");
const SCHEMA = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");

/** The executable SQL only (comment lines stripped), whitespace-collapsed. */
const CODE = SQL.split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join(" ")
  .replace(/\s+/g, " ")
  .trim();

describe("add_shop_free_speed_test_used migration (free speed test)", () => {
  it("is exactly one additive ALTER TABLE: a nullable timestamp, no default, no backfill", () => {
    expect(CODE).toBe('ALTER TABLE "Shop" ADD COLUMN "freeSpeedTestUsedAt" TIMESTAMP(3);');
  });

  it("documents the rollback", () => {
    expect(SQL).toContain('ALTER TABLE "Shop" DROP COLUMN "freeSpeedTestUsedAt";');
  });

  it("matches the Prisma schema (optional DateTime on Shop)", () => {
    expect(SCHEMA).toMatch(/model Shop \{[\s\S]*?\n\s+freeSpeedTestUsedAt\s+DateTime\?\n/);
  });

  it("sorts right after gc-rxq0's first-shown column and before theme health", () => {
    const dirs = readdirSync(join(ROOT, "prisma/migrations"))
      .filter((d) => /^\d{14}_/.test(d))
      .sort();
    const self = dirs.indexOf(NAME);
    expect(self).toBeGreaterThan(0);
    expect(dirs[self - 1]).toBe("20261016120000_add_shop_summary_optin_first_shown");
    expect(dirs[self + 1]).toBe("20261018120000_add_theme_health");
  });
});

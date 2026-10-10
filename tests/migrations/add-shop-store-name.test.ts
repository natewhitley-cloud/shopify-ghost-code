/**
 * Guard test for the gc-ol95 migration (20261012120000_add_shop_store_name).
 *
 * Tests never touch a database (.env points at prod), so this pins the reviewed
 * SQL text: one nullable Shop.storeName column, no default, no backfill.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

const ROOT = join(__dirname, "..", "..");
const NAME = "20261012120000_add_shop_store_name";
const SQL = readFileSync(join(ROOT, "prisma/migrations", NAME, "migration.sql"), "utf8");
const SCHEMA = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");

const CODE = SQL.split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join(" ")
  .replace(/\s+/g, " ")
  .trim();

describe("add_shop_store_name migration (gc-ol95)", () => {
  it("adds Shop.storeName as nullable TEXT and nothing else", () => {
    expect(CODE).toBe('ALTER TABLE "Shop" ADD COLUMN "storeName" TEXT;');
  });

  it("has no default, NOT NULL or backfill", () => {
    expect(CODE).not.toMatch(/\b(DEFAULT|NOT NULL|UPDATE)\b/i);
  });

  it("is destructive-free: no DROP/DELETE/UPDATE/RENAME/TRUNCATE in executable SQL", () => {
    expect(CODE).not.toMatch(/\b(DROP|DELETE|UPDATE|RENAME|TRUNCATE)\b/i);
  });

  it("documents a manual rollback", () => {
    expect(SQL).toMatch(/-- Manual rollback:/);
    expect(SQL).toContain('ALTER TABLE "Shop" DROP COLUMN "storeName";');
  });

  it("matches the Prisma schema", () => {
    expect(SCHEMA).toMatch(/model Shop \{[\s\S]*?\n\s+storeName\s+String\?\n/);
  });

  it("is the latest migration", () => {
    const dirs = readdirSync(join(ROOT, "prisma/migrations")).filter((d) => /^\d{14}_/.test(d));
    expect(dirs.sort().at(-1)).toBe(NAME);
  });
});

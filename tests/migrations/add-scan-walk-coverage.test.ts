/**
 * Guard test for the gc-747u migration (20261013120000_add_scan_walk_coverage).
 *
 * Tests never touch a database (.env points at prod), so this pins the reviewed
 * SQL text: one nullable, undefaulted column on Scan (NULL = legacy scan), no
 * backfill, matching the Prisma schema.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

const ROOT = join(__dirname, "..", "..");
const SQL = readFileSync(
  join(ROOT, "prisma/migrations/20261013120000_add_scan_walk_coverage/migration.sql"),
  "utf8",
);
const SCHEMA = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");

const CODE = SQL.split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join(" ")
  .replace(/\s+/g, " ")
  .trim();

describe("add_scan_walk_coverage migration (gc-747u)", () => {
  it("adds exactly one nullable JSONB column with no default (legacy rows stay NULL)", () => {
    expect(CODE).toBe('ALTER TABLE "Scan" ADD COLUMN "walkCoverage" JSONB;');
  });

  it("is destructive-free and does not backfill", () => {
    expect(CODE).not.toMatch(/\b(DROP|DELETE|UPDATE|RENAME|TRUNCATE|DEFAULT|NOT NULL)\b/i);
  });

  it("matches the Prisma schema (Json?, on Scan)", () => {
    expect(SCHEMA).toMatch(/model Scan \{[\s\S]*?\n\s+walkCoverage\s+Json\?\n/);
  });

  it("is the latest migration", () => {
    const dirs = readdirSync(join(ROOT, "prisma/migrations")).filter((d) => /^\d{14}_/.test(d));
    expect(dirs.sort().at(-1)).toBe("20261013120000_add_scan_walk_coverage");
  });
});

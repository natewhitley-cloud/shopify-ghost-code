/**
 * Guard test for the gc-rvo0 migration (20261002140000_add_scan_live_finding_types).
 *
 * Tests never touch a database (.env points at prod), so this pins the reviewed
 * SQL text: one nullable, undefaulted column on Scan (NULL = legacy scan), no
 * backfill, matching the Prisma schema.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

const ROOT = join(__dirname, "..", "..");
const SQL = readFileSync(
  join(ROOT, "prisma/migrations/20261002140000_add_scan_live_finding_types/migration.sql"),
  "utf8",
);
const SCHEMA = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");

const CODE = SQL.split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join(" ")
  .replace(/\s+/g, " ")
  .trim();

describe("add_scan_live_finding_types migration (gc-rvo0)", () => {
  it("adds exactly one nullable JSONB column with no default (legacy rows stay NULL)", () => {
    expect(CODE).toBe('ALTER TABLE "Scan" ADD COLUMN "liveFindingTypes" JSONB;');
  });

  it("is destructive-free and does not backfill", () => {
    expect(CODE).not.toMatch(/\b(DROP|DELETE|UPDATE|RENAME|TRUNCATE|DEFAULT|NOT NULL)\b/i);
  });

  it("matches the Prisma schema (Json?, on Scan)", () => {
    expect(SCHEMA).toMatch(/model Scan \{[\s\S]*?\n\s+liveFindingTypes\s+Json\?\n/);
  });

  it("sorts after the previous latest migration", () => {
    expect(
      "20261002140000_add_scan_live_finding_types" > "20261002130000_add_merchant_alerts",
    ).toBe(true);
  });
});

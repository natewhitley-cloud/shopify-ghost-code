/**
 * Guard test for the scan start-source + results-view telemetry migration
 * (20261009120000_add_scan_source_telemetry).
 *
 * Tests never touch a database (.env points at prod), so this pins the reviewed
 * SQL text: four additive, nullable Scan columns with no default and no
 * backfill (pre-existing rows read as "not recorded"), matching the schema.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

const ROOT = join(__dirname, "..", "..");
const NAME = "20261009120000_add_scan_source_telemetry";
const SQL = readFileSync(join(ROOT, "prisma/migrations", NAME, "migration.sql"), "utf8");
const SCHEMA = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");

const CODE = SQL.split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join(" ")
  .replace(/\s+/g, " ")
  .trim();

describe("add_scan_source_telemetry migration", () => {
  it("adds exactly the four nullable Scan columns, no defaults", () => {
    expect(CODE).toBe(
      'ALTER TABLE "Scan" ADD COLUMN "requestedFrom" TEXT, ' +
        'ADD COLUMN "shopScanNumber" INTEGER, ' +
        'ADD COLUMN "viewedOnHomeAt" TIMESTAMP(3), ' +
        'ADD COLUMN "viewedOnScanPageAt" TIMESTAMP(3);',
    );
  });

  it("is destructive-free and does not backfill", () => {
    expect(CODE).not.toMatch(/\b(DROP|DELETE|UPDATE|RENAME|TRUNCATE|DEFAULT|NOT NULL)\b/i);
  });

  it("documents a manual rollback", () => {
    expect(SQL).toMatch(/-- Manual rollback:/);
    expect(SQL).toContain('DROP COLUMN "requestedFrom"');
  });

  it("matches the Prisma schema", () => {
    expect(SCHEMA).toMatch(/model Scan \{[\s\S]*?\n\s+requestedFrom\s+String\?\n/);
    expect(SCHEMA).toMatch(/model Scan \{[\s\S]*?\n\s+shopScanNumber\s+Int\?\n/);
    expect(SCHEMA).toMatch(/model Scan \{[\s\S]*?\n\s+viewedOnHomeAt\s+DateTime\?\n/);
    expect(SCHEMA).toMatch(/model Scan \{[\s\S]*?\n\s+viewedOnScanPageAt\s+DateTime\?\n/);
  });

  it("sorts after the previous latest migration", () => {
    const dirs = readdirSync(join(ROOT, "prisma/migrations")).filter((d) => /^\d{14}_/.test(d));
    expect(dirs).toContain(NAME);
    expect(NAME > "20261005120000_add_script_tag_sunset").toBe(true);
  });
});

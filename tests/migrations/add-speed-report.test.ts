/**
 * Guard test for the gc-wt3y migration (20261013120001_add_speed_report).
 *
 * Tests never touch a database (.env points at prod), so this pins the reviewed
 * SQL text: additive only (a nullable Shop column, the SpeedReport table with a
 * cascading Shop FK so shop/redact removes the rows, and the global
 * PageSpeedDailyUsage counter), matching the schema.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

const ROOT = join(__dirname, "..", "..");
const NAME = "20261013120001_add_speed_report";
const SQL = readFileSync(join(ROOT, "prisma/migrations", NAME, "migration.sql"), "utf8");
const SCHEMA = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");

const CODE = SQL.split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join(" ")
  .replace(/\s+/g, " ")
  .trim();

describe("add_speed_report migration (gc-wt3y)", () => {
  it("adds Shop.speedReportRequestedAt as a nullable timestamp, no default", () => {
    expect(CODE).toContain('ALTER TABLE "Shop" ADD COLUMN "speedReportRequestedAt" TIMESTAMP(3);');
  });

  it("creates SpeedReport with plain-string origin/status, Json pages and a shop+date index", () => {
    expect(CODE).toContain('CREATE TABLE "SpeedReport"');
    expect(CODE).toContain('"origin" TEXT NOT NULL,');
    expect(CODE).toContain('"status" TEXT NOT NULL,');
    expect(CODE).toContain('"failureReason" TEXT,');
    expect(CODE).toContain('"pages" JSONB,');
    expect(CODE).toContain('"psiCalls" INTEGER NOT NULL DEFAULT 0,');
    expect(CODE).toContain('"completedAt" TIMESTAMP(3),');
    expect(CODE).toContain(
      'CREATE INDEX "SpeedReport_shopId_createdAt_idx" ON "SpeedReport"("shopId", "createdAt");',
    );
  });

  it("cascades SpeedReport from Shop (shop/redact deletes the Shop row, the FK takes these)", () => {
    expect(CODE).toContain(
      'ALTER TABLE "SpeedReport" ADD CONSTRAINT "SpeedReport_shopId_fkey" FOREIGN KEY ("shopId") ' +
        'REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
    );
  });

  it("creates the global PageSpeedDailyUsage counter keyed by UTC day, with no shop column", () => {
    expect(CODE).toContain('CREATE TABLE "PageSpeedDailyUsage"');
    expect(CODE).toContain('"day" TEXT NOT NULL,');
    expect(CODE).toContain('"calls" INTEGER NOT NULL DEFAULT 0,');
    expect(CODE).toContain('CONSTRAINT "PageSpeedDailyUsage_pkey" PRIMARY KEY ("day")');
    const usage = CODE.slice(CODE.indexOf('CREATE TABLE "PageSpeedDailyUsage"'));
    expect(usage.slice(0, usage.indexOf(");"))).not.toContain("shop");
  });

  it("is destructive-free: no DROP/DELETE/UPDATE/RENAME/TRUNCATE in executable SQL", () => {
    const statements = CODE.replace(/ON (DELETE|UPDATE) CASCADE/gi, "");
    expect(statements).not.toMatch(/\b(DROP|DELETE|UPDATE|RENAME|TRUNCATE)\b/i);
  });

  it("documents a manual rollback", () => {
    expect(SQL).toMatch(/-- Manual rollback:/);
    expect(SQL).toContain('DROP TABLE "SpeedReport";');
    expect(SQL).toContain('DROP TABLE "PageSpeedDailyUsage";');
    expect(SQL).toContain('ALTER TABLE "Shop" DROP COLUMN "speedReportRequestedAt";');
  });

  it("matches the Prisma schema (cascade on the Shop relation)", () => {
    expect(SCHEMA).toMatch(/model Shop \{[\s\S]*?\n\s+speedReportRequestedAt\s+DateTime\?\n/);
    expect(SCHEMA).toMatch(/model Shop \{[\s\S]*?\n\s+speedReports\s+SpeedReport\[\]\n/);
    expect(SCHEMA).toMatch(
      /model SpeedReport \{[\s\S]*?shop\s+Shop\s+@relation\(fields: \[shopId\], references: \[id\], onDelete: Cascade\)/,
    );
    expect(SCHEMA).toMatch(/model PageSpeedDailyUsage \{[\s\S]*?day\s+String\s+@id/);
  });

  it("is the latest migration", () => {
    const dirs = readdirSync(join(ROOT, "prisma/migrations")).filter((d) => /^\d{14}_/.test(d));
    expect(dirs.sort().at(-1)).toBe(NAME);
  });
});

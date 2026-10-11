/**
 * Guard test for the gc-wt3y follow-up migration
 * (20261013120002_speed_report_run_tracking).
 *
 * Tests never touch a database (.env points at prod), so this pins the reviewed
 * SQL text: two nullable SpeedReport columns (the owning Inngest run, unique,
 * and when the worker started it), additive only, matching the schema.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

const ROOT = join(__dirname, "..", "..");
const NAME = "20261013120002_speed_report_run_tracking";
const SQL = readFileSync(join(ROOT, "prisma/migrations", NAME, "migration.sql"), "utf8");
const SCHEMA = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");

const CODE = SQL.split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join(" ")
  .replace(/\s+/g, " ")
  .trim();

describe("speed_report_run_tracking migration (gc-wt3y #2/#3/#8)", () => {
  it("adds nullable SpeedReport.runId and SpeedReport.startedAt, no default", () => {
    expect(CODE).toContain(
      'ALTER TABLE "SpeedReport" ADD COLUMN "runId" TEXT, ADD COLUMN "startedAt" TIMESTAMP(3);',
    );
  });

  it("makes runId unique (a retried prepare finds its run's row)", () => {
    expect(CODE).toContain(
      'CREATE UNIQUE INDEX "SpeedReport_runId_key" ON "SpeedReport"("runId");',
    );
  });

  it("is destructive-free: no DROP/DELETE/UPDATE/RENAME/TRUNCATE", () => {
    expect(CODE).not.toMatch(/\b(DROP|DELETE|UPDATE|RENAME|TRUNCATE)\b/i);
  });

  it("documents a manual rollback", () => {
    expect(SQL).toMatch(/-- Manual rollback:/);
    expect(SQL).toContain('--   DROP INDEX "SpeedReport_runId_key";');
    expect(SQL).toContain(
      '--   ALTER TABLE "SpeedReport" DROP COLUMN "runId", DROP COLUMN "startedAt";',
    );
  });

  it("matches the Prisma schema", () => {
    expect(SCHEMA).toMatch(/model SpeedReport \{[\s\S]*?\n\s+runId\s+String\?\s+@unique\n/);
    expect(SCHEMA).toMatch(/model SpeedReport \{[\s\S]*?\n\s+startedAt\s+DateTime\?\n/);
  });

  it("is the latest migration", () => {
    const dirs = readdirSync(join(ROOT, "prisma/migrations")).filter((d) => /^\d{14}_/.test(d));
    expect(dirs.sort().at(-1)).toBe(NAME);
  });
});

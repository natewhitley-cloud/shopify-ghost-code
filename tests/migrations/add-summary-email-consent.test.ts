/**
 * Guard test for the gc-ol95 migration (20261011120000_add_summary_email_consent).
 *
 * Tests never touch a database (.env points at prod), so this pins the reviewed
 * SQL text: three nullable Shop consent timestamps with no default and no
 * backfill (a shop already paid before this shipped must stay ineligible), the
 * ledger's summary counts (default 0) and the one-summary-per-scan unique key.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

const ROOT = join(__dirname, "..", "..");
const NAME = "20261011120000_add_summary_email_consent";
const SQL = readFileSync(join(ROOT, "prisma/migrations", NAME, "migration.sql"), "utf8");
const SCHEMA = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");

const CODE = SQL.split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join(" ")
  .replace(/\s+/g, " ")
  .trim();

describe("add_summary_email_consent migration (gc-ol95)", () => {
  it("adds the three Shop consent timestamps as nullable, no default", () => {
    expect(CODE).toContain(
      'ALTER TABLE "Shop" ADD COLUMN "summaryNoticePendingAt" TIMESTAMP(3), ' +
        'ADD COLUMN "summaryNoticeShownAt" TIMESTAMP(3), ' +
        'ADD COLUMN "summaryOptedInAt" TIMESTAMP(3);',
    );
  });

  it("never backfills consent: no UPDATE and no default on any Shop column", () => {
    const shopStatement = CODE.match(/ALTER TABLE "Shop"[^;]*;/)?.[0] ?? "";
    expect(shopStatement).not.toMatch(/\b(DEFAULT|NOT NULL)\b/i);
    expect(CODE).not.toMatch(/\bUPDATE "/i);
  });

  it("adds the ledger counts as NOT NULL DEFAULT 0", () => {
    expect(CODE).toContain(
      'ALTER TABLE "MerchantAlert" ADD COLUMN "cleanedAppCount" INTEGER NOT NULL DEFAULT 0, ' +
        'ADD COLUMN "fixedCount" INTEGER NOT NULL DEFAULT 0, ' +
        'ADD COLUMN "inactiveAppCount" INTEGER NOT NULL DEFAULT 0;',
    );
  });

  it("adds the one-summary-per-scan unique index", () => {
    expect(CODE).toContain(
      'CREATE UNIQUE INDEX "MerchantAlert_shopId_scanId_key" ON "MerchantAlert"("shopId", "scanId");',
    );
  });

  it("is destructive-free: no DROP/DELETE/UPDATE/RENAME/TRUNCATE in executable SQL", () => {
    expect(CODE).not.toMatch(/\b(DROP|DELETE|UPDATE|RENAME|TRUNCATE)\b/i);
  });

  it("documents a manual rollback", () => {
    expect(SQL).toMatch(/-- Manual rollback:/);
    expect(SQL).toContain('DROP INDEX "MerchantAlert_shopId_scanId_key"');
    expect(SQL).toContain('DROP COLUMN "summaryOptedInAt"');
    expect(SQL).toContain('DROP COLUMN "fixedCount"');
  });

  it("matches the Prisma schema", () => {
    for (const col of ["summaryNoticePendingAt", "summaryNoticeShownAt", "summaryOptedInAt"]) {
      expect(SCHEMA).toMatch(new RegExp(`model Shop \\{[\\s\\S]*?\\n\\s+${col}\\s+DateTime\\?\\n`));
    }
    for (const col of ["fixedCount", "inactiveAppCount", "cleanedAppCount"]) {
      expect(SCHEMA).toMatch(
        new RegExp(`model MerchantAlert \\{[\\s\\S]*?\\n\\s+${col}\\s+Int\\s+@default\\(0\\)\\n`),
      );
    }
    expect(SCHEMA).toMatch(/model MerchantAlert \{[\s\S]*?@@unique\(\[shopId, scanId\]\)/);
  });

  it("is the latest migration", () => {
    const dirs = readdirSync(join(ROOT, "prisma/migrations")).filter((d) => /^\d{14}_/.test(d));
    expect(dirs.sort().at(-1)).toBe(NAME);
  });
});

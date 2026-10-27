/**
 * Guard test for the checkout guard migration (20261027200000_storefront_guard,
 * gc-1q1s.4 + gc-1q1s.7). Tests never touch a database, so this pins the SQL:
 * additive only (two new tables cascading from Shop, two nullable Shop
 * timestamps), matching the schema, with a documented manual rollback.
 * Deploys self-migrate, so anything destructive here would run on live data.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

const ROOT = join(__dirname, "..", "..");
const NAME = "20261027200000_storefront_guard";
const SQL = readFileSync(join(ROOT, "prisma/migrations", NAME, "migration.sql"), "utf8");
const SCHEMA = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");
const CODE = SQL.split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join(" ")
  .replace(/\s+/g, " ")
  .trim();

describe("storefront_guard migration (gc-1q1s.4)", () => {
  it("adds the two nullable Shop consent stamps", () => {
    expect(CODE).toContain(
      'ALTER TABLE "Shop" ADD COLUMN "guardEmailNoticeShownAt" TIMESTAMP(3), ' +
        'ADD COLUMN "guardEmailOffAt" TIMESTAMP(3);',
    );
  });

  it("creates both tables, keyed and indexed as the schema says", () => {
    expect(CODE).toContain('CONSTRAINT "StorefrontGuardState_pkey" PRIMARY KEY ("shopId")');
    expect(CODE).toContain(`"baselineHosts" JSONB NOT NULL DEFAULT '{}'`);
    expect(CODE).toContain(`"recentHostSets" JSONB NOT NULL DEFAULT '[]'`);
    expect(CODE).toContain('"version" INTEGER NOT NULL DEFAULT 0');
    expect(CODE).toContain(
      'CREATE UNIQUE INDEX "StorefrontIncident_shopId_fingerprint_key" ON ' +
        '"StorefrontIncident"("shopId", "fingerprint");',
    );
    expect(CODE).toContain(
      'CREATE INDEX "StorefrontIncident_shopId_state_idx" ON "StorefrontIncident"("shopId", "state");',
    );
  });

  it("cascades both tables from Shop (shop/redact)", () => {
    for (const table of ["StorefrontGuardState", "StorefrontIncident"]) {
      expect(CODE).toContain(
        `ALTER TABLE "${table}" ADD CONSTRAINT "${table}_shopId_fkey" FOREIGN KEY ("shopId") ` +
          'REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
      );
    }
    expect(CODE.match(/FOREIGN KEY/g)).toHaveLength(2);
  });

  it("is destructive-free and has no backfill", () => {
    const statements = CODE.replace(/ON (DELETE|UPDATE) CASCADE/gi, "");
    expect(statements).not.toMatch(/\b(DROP|DELETE|UPDATE|RENAME|TRUNCATE)\b/i);
    expect(statements).not.toMatch(/\b(INSERT|SELECT)\b/i);
  });

  it("documents a manual rollback for every object it adds", () => {
    for (const stmt of [
      'DROP TABLE "StorefrontIncident";',
      'DROP TABLE "StorefrontGuardState";',
      'ALTER TABLE "Shop" DROP COLUMN "guardEmailNoticeShownAt";',
      'ALTER TABLE "Shop" DROP COLUMN "guardEmailOffAt";',
    ]) {
      expect(SQL).toContain(`--   ${stmt}`);
    }
  });

  it("matches the Prisma schema", () => {
    for (const column of ["guardEmailNoticeShownAt", "guardEmailOffAt"]) {
      expect(SCHEMA).toMatch(new RegExp(`\\n\\s+${column}\\s+DateTime\\?\\n`));
    }
    expect(SCHEMA).toContain("model StorefrontGuardState {");
    expect(SCHEMA).toContain("model StorefrontIncident {");
  });

  it("sorts after the change log migration", () => {
    const dirs = readdirSync(join(ROOT, "prisma/migrations"))
      .filter((d) => /^\d{14}_/.test(d))
      .sort();
    expect(dirs.indexOf(NAME)).toBeGreaterThan(dirs.indexOf("20261020120000_add_change_log"));
  });
});

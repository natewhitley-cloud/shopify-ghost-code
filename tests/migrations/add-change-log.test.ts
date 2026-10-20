/**
 * Guard test for the "What changed" migration (20261020120000_add_change_log,
 * gc-rrh.4 + gc-qafb).
 *
 * Tests never touch a database, so this pins the reviewed SQL text: additive
 * only (two new tables that cascade from Scan, one constant-default column on
 * MerchantAlert, three nullable Shop timestamps), matching the schema, with a
 * documented manual rollback. Deploys self-migrate, so anything destructive
 * here would run on the live database.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

const ROOT = join(__dirname, "..", "..");
const NAME = "20261020120000_add_change_log";
const SQL = readFileSync(join(ROOT, "prisma/migrations", NAME, "migration.sql"), "utf8");
const SCHEMA = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");

/** The executable SQL only (comment lines stripped), whitespace-collapsed. */
const CODE = SQL.split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join(" ")
  .replace(/\s+/g, " ")
  .trim();

/** One model's body from the schema. */
function model(name: string): string {
  const start = SCHEMA.indexOf(`model ${name} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = SCHEMA.slice(start);
  return rest.slice(0, rest.indexOf("\n}"));
}

describe("add_change_log migration (gc-rrh.4)", () => {
  it("adds the three nullable Shop teaser stamps and MerchantAlert.kind with a constant default", () => {
    expect(CODE).toContain(
      'ALTER TABLE "Shop" ADD COLUMN "changesTeaserClickedAt" TIMESTAMP(3), ' +
        'ADD COLUMN "changesTeaserConvertedAt" TIMESTAMP(3), ' +
        'ADD COLUMN "changesTeaserShownAt" TIMESTAMP(3);',
    );
    expect(CODE).toContain(
      `ALTER TABLE "MerchantAlert" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'summary';`,
    );
  });

  it("creates ScanManifest keyed by scanId with Json entries and nullable appBlocks", () => {
    expect(CODE).toContain(
      'CREATE TABLE "ScanManifest" ( "scanId" TEXT NOT NULL, "shopId" TEXT NOT NULL, ' +
        '"themeId" TEXT NOT NULL, "version" INTEGER NOT NULL DEFAULT 1, ' +
        '"fileCount" INTEGER NOT NULL, "entries" JSONB NOT NULL, "appBlocks" JSONB, ' +
        '"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, ' +
        'CONSTRAINT "ScanManifest_pkey" PRIMARY KEY ("scanId") );',
    );
    expect(CODE).toContain(
      'CREATE INDEX "ScanManifest_shopId_themeId_createdAt_idx" ON ' +
        '"ScanManifest"("shopId", "themeId", "createdAt");',
    );
  });

  it("creates ScanChangeSet keyed by scanId with the published-theme index", () => {
    expect(CODE).toContain('CREATE TABLE "ScanChangeSet"');
    for (const column of [
      '"baselineScanId" TEXT,',
      '"kind" TEXT NOT NULL,',
      '"checkKind" TEXT NOT NULL,',
      '"onPublishedTheme" BOOLEAN NOT NULL,',
      '"changeCount" INTEGER NOT NULL DEFAULT 0,',
      '"worthALookCount" INTEGER NOT NULL DEFAULT 0,',
      '"checksRan" INTEGER NOT NULL DEFAULT 0,',
      '"counts" JSONB NOT NULL,',
      '"rows" JSONB NOT NULL,',
      '"footnotes" JSONB NOT NULL,',
      'CONSTRAINT "ScanChangeSet_pkey" PRIMARY KEY ("scanId")',
    ]) {
      expect(CODE).toContain(column);
    }
    expect(CODE).toContain(
      'CREATE INDEX "ScanChangeSet_shopId_onPublishedTheme_createdAt_idx" ON ' +
        '"ScanChangeSet"("shopId", "onPublishedTheme", "createdAt");',
    );
  });

  it("cascades both tables from Scan (shop/redact deletes Shop -> Scan -> these)", () => {
    for (const table of ["ScanManifest", "ScanChangeSet"]) {
      expect(CODE).toContain(
        `ALTER TABLE "${table}" ADD CONSTRAINT "${table}_scanId_fkey" FOREIGN KEY ("scanId") ` +
          'REFERENCES "Scan"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
      );
    }
    // Exactly those two foreign keys: no FK to Shop (shopId is a plain id).
    expect(CODE.match(/FOREIGN KEY/g)).toHaveLength(2);
  });

  it("is destructive-free: no DROP/DELETE/UPDATE/RENAME/TRUNCATE in executable SQL", () => {
    const statements = CODE.replace(/ON (DELETE|UPDATE) CASCADE/gi, "");
    expect(statements).not.toMatch(/\b(DROP|DELETE|UPDATE|RENAME|TRUNCATE)\b/i);
    // No backfill: nothing reads or rewrites existing rows.
    expect(statements).not.toMatch(/\b(INSERT|SELECT)\b/i);
  });

  it("documents a manual rollback for every object it adds", () => {
    expect(SQL).toMatch(/-- Manual rollback:/);
    for (const stmt of [
      'DROP TABLE "ScanChangeSet";',
      'DROP TABLE "ScanManifest";',
      'ALTER TABLE "MerchantAlert" DROP COLUMN "kind";',
      'ALTER TABLE "Shop" DROP COLUMN "changesTeaserShownAt";',
      'ALTER TABLE "Shop" DROP COLUMN "changesTeaserClickedAt";',
      'ALTER TABLE "Shop" DROP COLUMN "changesTeaserConvertedAt";',
    ]) {
      expect(SQL).toContain(`--   ${stmt}`);
    }
  });

  it("matches the Prisma schema", () => {
    const scan = model("Scan");
    expect(scan).toMatch(/\n\s+manifest\s+ScanManifest\?\n/);
    expect(scan).toMatch(/\n\s+changeSet\s+ScanChangeSet\?\n/);
    for (const name of ["ScanManifest", "ScanChangeSet"]) {
      const body = model(name);
      expect(body).toMatch(/\n\s+scanId\s+String\s+@id\n/);
      expect(body).toMatch(
        /scan\s+Scan\s+@relation\(fields: \[scanId\], references: \[id\], onDelete: Cascade\)/,
      );
      expect(body).not.toMatch(/\bShop\b\s+@relation/);
    }
    expect(model("ScanManifest")).toMatch(/\n\s+appBlocks\s+Json\?\n/);
    expect(model("MerchantAlert")).toMatch(/\n\s+kind\s+String\s+@default\("summary"\)\n/);
    for (const column of [
      "changesTeaserShownAt",
      "changesTeaserClickedAt",
      "changesTeaserConvertedAt",
    ]) {
      expect(model("Shop")).toMatch(new RegExp(`\\n\\s+${column}\\s+DateTime\\?\\n`));
    }
  });

  it("is the latest migration (applied last on deploy), right after the advisory type", () => {
    const dirs = readdirSync(join(ROOT, "prisma/migrations"))
      .filter((d) => /^\d{14}_/.test(d))
      .sort();
    expect(dirs.at(-1)).toBe(NAME);
    expect(dirs.at(-2)).toBe("20261019120000_add_app_incident_advisory_finding_type");
  });
});

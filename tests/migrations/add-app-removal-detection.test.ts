/**
 * Guard test for the gc-frda migration (20261010120000_add_app_removal_detection).
 *
 * Tests never touch a database (.env points at prod), so this pins the reviewed
 * SQL text: additive only (a nullable Scan column, a new enum and table with a
 * cascading Shop FK so shop/redact removes the rows), matching the schema.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

const ROOT = join(__dirname, "..", "..");
const NAME = "20261010120000_add_app_removal_detection";
const SQL = readFileSync(join(ROOT, "prisma/migrations", NAME, "migration.sql"), "utf8");
const SCHEMA = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");

const CODE = SQL.split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join(" ")
  .replace(/\s+/g, " ")
  .trim();

describe("add_app_removal_detection migration (gc-frda)", () => {
  it("adds Scan.appSignatureFingerprints and Scan.liveAppHooks as nullable JSONB, no default", () => {
    expect(CODE).toContain(
      'ALTER TABLE "Scan" ADD COLUMN "appSignatureFingerprints" JSONB, ' +
        'ADD COLUMN "liveAppHooks" JSONB;',
    );
  });

  it("creates the AppRemovalState enum", () => {
    expect(CODE).toContain(
      "CREATE TYPE \"AppRemovalState\" AS ENUM ('REMOVED', 'CLEANED', 'REINSTALLED');",
    );
  });

  it("creates AppRemoval with the idempotency key, the shop+date index and a CASCADE Shop FK", () => {
    expect(CODE).toContain('CREATE TABLE "AppRemoval"');
    expect(CODE).toContain('"state" "AppRemovalState" NOT NULL DEFAULT \'REMOVED\'');
    expect(CODE).toContain('"stateChangedAt" TIMESTAMP(3),');
    expect(CODE).toContain(
      'CREATE UNIQUE INDEX "AppRemoval_shopId_themeId_appName_detectedScanId_key" ON ' +
        '"AppRemoval"("shopId", "themeId", "appName", "detectedScanId");',
    );
    expect(CODE).toContain(
      'CREATE INDEX "AppRemoval_shopId_detectedAt_idx" ON "AppRemoval"("shopId", "detectedAt");',
    );
    // shop/redact deletes the Shop row (deleteShopData); the cascade takes these.
    expect(CODE).toContain(
      'FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE',
    );
  });

  it("is destructive-free: no DROP/DELETE/UPDATE statements in executable SQL", () => {
    const statements = CODE.replace(/ON (DELETE|UPDATE) CASCADE/gi, "");
    expect(statements).not.toMatch(/\b(DROP|DELETE|UPDATE|RENAME|TRUNCATE)\b/i);
  });

  it("documents a manual rollback", () => {
    expect(SQL).toMatch(/-- Manual rollback:/);
    expect(SQL).toContain('DROP TABLE "AppRemoval"');
    expect(SQL).toContain('DROP COLUMN "liveAppHooks"');
  });

  it("matches the Prisma schema (cascade on the Shop relation)", () => {
    expect(SCHEMA).toMatch(/model Scan \{[\s\S]*?\n\s+appSignatureFingerprints\s+Json\?\n/);
    expect(SCHEMA).toMatch(/model Scan \{[\s\S]*?\n\s+liveAppHooks\s+Json\?\n/);
    expect(SCHEMA).toMatch(
      /model AppRemoval \{[\s\S]*?shop\s+Shop\s+@relation\(fields: \[shopId\], references: \[id\], onDelete: Cascade\)/,
    );
    expect(SCHEMA).toMatch(
      /model AppRemoval \{[\s\S]*?@@unique\(\[shopId, themeId, appName, detectedScanId\]\)/,
    );
    expect(SCHEMA).toMatch(/model AppRemoval \{[\s\S]*?@@index\(\[shopId, detectedAt\]\)/);
  });

  it("is the latest migration", () => {
    const dirs = readdirSync(join(ROOT, "prisma/migrations")).filter((d) => /^\d{14}_/.test(d));
    expect(dirs.sort().at(-1)).toBe(NAME);
  });
});

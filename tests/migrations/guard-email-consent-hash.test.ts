/**
 * Guard test for 20261027300000_guard_email_consent_hash (gc-1q1s.7 audit
 * fix). Tests never touch a database, so this pins the SQL: one nullable Shop
 * column, additive only, matching the schema, with a documented rollback.
 * Deploys self-migrate, so anything destructive here would run on live data.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

const ROOT = join(__dirname, "..", "..");
const NAME = "20261027300000_guard_email_consent_hash";
const SQL = readFileSync(join(ROOT, "prisma/migrations", NAME, "migration.sql"), "utf8");
const SCHEMA = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");
const CODE = SQL.split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join(" ")
  .replace(/\s+/g, " ")
  .trim();

describe("guard_email_consent_hash migration", () => {
  it("adds exactly one nullable Shop column", () => {
    expect(CODE).toBe('ALTER TABLE "Shop" ADD COLUMN "guardEmailConsentHash" TEXT;');
  });

  it("documents the manual rollback", () => {
    expect(SQL).toContain('--   ALTER TABLE "Shop" DROP COLUMN "guardEmailConsentHash";');
  });

  it("matches the Prisma schema", () => {
    expect(SCHEMA).toMatch(/\n\s+guardEmailConsentHash\s+String\?\n/);
  });

  it("sorts after the storefront guard migration", () => {
    const dirs = readdirSync(join(ROOT, "prisma/migrations"))
      .filter((d) => /^\d{14}_/.test(d))
      .sort();
    expect(dirs.indexOf(NAME)).toBeGreaterThan(dirs.indexOf("20261027200000_storefront_guard"));
  });
});

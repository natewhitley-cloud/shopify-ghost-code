/**
 * Guard test for the gc-syz.1 migration (20261002130000_add_merchant_alerts).
 *
 * Tests never touch a database (.env points at prod), so this pins the reviewed
 * SQL text: additive only (defaulted/nullable columns, a new table), matching
 * the Prisma schema.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

const ROOT = join(__dirname, "..", "..");
const SQL = readFileSync(
  join(ROOT, "prisma/migrations/20261002130000_add_merchant_alerts/migration.sql"),
  "utf8",
);
const SCHEMA = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");

const CODE = SQL.split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join(" ")
  .replace(/\s+/g, " ")
  .trim();

describe("add_merchant_alerts migration (gc-syz.1)", () => {
  it("adds the three Shop columns additively (default true / nullable, no backfill)", () => {
    expect(CODE).toContain(
      'ALTER TABLE "Shop" ADD COLUMN "alertsEnabled" BOOLEAN NOT NULL DEFAULT true, ' +
        'ADD COLUMN "alertEmail" TEXT, ADD COLUMN "alertUnsubscribeToken" TEXT;',
    );
  });

  it("creates MerchantAlert with a cascading Shop FK, the unique token index and the shopId+sentAt index", () => {
    expect(CODE).toContain('CREATE TABLE "MerchantAlert"');
    expect(CODE).toContain('"sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP');
    expect(CODE).toContain(
      'CREATE UNIQUE INDEX "Shop_alertUnsubscribeToken_key" ON "Shop"("alertUnsubscribeToken");',
    );
    expect(CODE).toContain(
      'CREATE INDEX "MerchantAlert_shopId_sentAt_idx" ON "MerchantAlert"("shopId", "sentAt");',
    );
    expect(CODE).toContain('FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE');
  });

  it("is destructive-free: no DROP/DELETE/UPDATE statements in executable SQL", () => {
    // The FK's own `ON DELETE/UPDATE CASCADE` clause is not a statement.
    const statements = CODE.replace(/ON (DELETE|UPDATE) CASCADE/gi, "");
    expect(statements).not.toMatch(/\b(DROP|DELETE|UPDATE|RENAME|TRUNCATE)\b/i);
  });

  it("matches the Prisma schema", () => {
    expect(SCHEMA).toMatch(/\n\s+alertsEnabled\s+Boolean\s+@default\(true\)\n/);
    expect(SCHEMA).toMatch(/\n\s+alertEmail\s+String\?\n/);
    expect(SCHEMA).toMatch(/\n\s+alertUnsubscribeToken\s+String\?\s+@unique\n/);
    expect(SCHEMA).toMatch(/model MerchantAlert \{[\s\S]*@@index\(\[shopId, sentAt\]\)/);
  });

  it("sorts after the previous latest migration", () => {
    expect(
      "20261002130000_add_merchant_alerts" > "20261002120000_add_app_embed_finding_types",
    ).toBe(true);
  });
});

/**
 * GDPR + data-minimisation coverage for the clean-copy tables (gc-tib slice 3).
 *
 * FixRun / FixItem hold theme ids, filenames, offsets and hashes only. They
 * have no explicit deleteShopData clause (same as ScanManifest): FixRun
 * cascades from Shop and FixItem from FixRun, and deleteShopData deletes the
 * Shop row in its transaction (pinned in change-log-gdpr.test.ts). Each link
 * of the chain is pinned here in both the schema and the migration SQL.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const SCHEMA = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");
const MIGRATION = readFileSync(
  join(ROOT, "prisma/migrations/20261110200000_gc_tib_clean_copy/migration.sql"),
  "utf8",
).replace(/\s+/g, " ");

function model(name: string): string {
  const rest = SCHEMA.slice(SCHEMA.indexOf(`model ${name} {`));
  return rest.slice(0, rest.indexOf("\n}"));
}

describe("clean-copy tables: shop/redact and data minimisation", () => {
  it("FixRun cascades from Shop (schema + migration)", () => {
    expect(model("FixRun")).toMatch(
      /shop\s+Shop\s+@relation\(fields: \[shopId\], references: \[id\], onDelete: Cascade\)/,
    );
    expect(MIGRATION).toContain(
      'ALTER TABLE "FixRun" ADD CONSTRAINT "FixRun_shopId_fkey" FOREIGN KEY ("shopId") ' +
        'REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
    );
  });

  it("FixItem cascades from FixRun (schema + migration)", () => {
    expect(model("FixItem")).toMatch(
      /fixRun\s+FixRun\s+@relation\(fields: \[fixRunId\], references: \[id\], onDelete: Cascade\)/,
    );
    expect(MIGRATION).toContain(
      'ALTER TABLE "FixItem" ADD CONSTRAINT "FixItem_fixRunId_fkey" FOREIGN KEY ("fixRunId") ' +
        'REFERENCES "FixRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
    );
  });

  it("no clean-copy column stores code text or personal data (spike D6, privacy :111)", () => {
    for (const name of ["FixRun", "FixItem"]) {
      expect(model(name)).not.toMatch(/\b(content|code|body|email|recipient|snippet)\w*\s+String/i);
    }
    // Finding gains offsets + a hash only.
    expect(model("Finding")).toMatch(/spanStart\s+Int\?/);
    expect(model("Finding")).toMatch(/spanEnd\s+Int\?/);
    expect(model("Finding")).toMatch(/spanSha256\s+String\?/);
  });

  it("the migration is additive only (no drops, renames or NOT NULL on existing tables)", () => {
    expect(MIGRATION).not.toMatch(/\bDROP\b|\bRENAME\b|ALTER COLUMN/i);
    expect(MIGRATION).toMatch(
      /ALTER TABLE "Finding" ADD COLUMN "spanEnd" INTEGER, ADD COLUMN "spanSha256" TEXT, ADD COLUMN "spanStart" INTEGER;/,
    );
  });
});

/**
 * Guard test for the gc-3twe migration (20261028100000_help_page_install_source).
 *
 * Tests never touch a database (.env points at prod), so this pins the reviewed
 * SQL text: additive columns on MerchantFeedback (a defaulted topic, so old
 * survey rows read as "feedback") and Shop, plus csat made optional.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

const ROOT = join(__dirname, "..", "..");
const NAME = "20261028100000_help_page_install_source";
const SQL = readFileSync(join(ROOT, "prisma/migrations", NAME, "migration.sql"), "utf8");
const SCHEMA = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");

/** The executable SQL only (comment lines stripped), whitespace-collapsed. */
const CODE = SQL.split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join(" ")
  .replace(/\s+/g, " ")
  .trim();

describe("help_page_install_source migration (gc-3twe)", () => {
  it("is additive only: new columns, a defaulted topic, csat made optional, no backfill", () => {
    expect(CODE).toBe(
      [
        `ALTER TABLE "MerchantFeedback" ADD COLUMN "topic" TEXT NOT NULL DEFAULT 'feedback';`,
        `ALTER TABLE "MerchantFeedback" ADD COLUMN "message" TEXT;`,
        `ALTER TABLE "MerchantFeedback" ADD COLUMN "contactConsentAt" TIMESTAMP(3);`,
        `ALTER TABLE "MerchantFeedback" ADD COLUMN "context" TEXT;`,
        `ALTER TABLE "MerchantFeedback" ALTER COLUMN "csat" DROP NOT NULL;`,
        `ALTER TABLE "Shop" ADD COLUMN "installSource" TEXT;`,
        `ALTER TABLE "Shop" ADD COLUMN "installSourceOther" TEXT;`,
        `ALTER TABLE "Shop" ADD COLUMN "installSourceShownAt" TIMESTAMP(3);`,
        `ALTER TABLE "Shop" ADD COLUMN "installSourceAnsweredAt" TIMESTAMP(3);`,
        `ALTER TABLE "Shop" ADD COLUMN "installSourceSkippedAt" TIMESTAMP(3);`,
      ].join(" "),
    );
    expect(CODE).not.toMatch(/\b(UPDATE|DELETE|DROP COLUMN|DROP TABLE)\b/);
  });

  it("documents the rollback", () => {
    expect(SQL).toContain('ALTER TABLE "MerchantFeedback" ALTER COLUMN "csat" SET NOT NULL;');
    expect(SQL).toContain('ALTER TABLE "Shop" DROP COLUMN "installSource"');
  });

  it("matches the Prisma schema", () => {
    const shop = SCHEMA.slice(SCHEMA.indexOf("model Shop {"));
    for (const col of [
      "installSourceShownAt",
      "installSourceAnsweredAt",
      "installSourceSkippedAt",
    ]) {
      expect(shop).toMatch(new RegExp(`\\n\\s+${col}\\s+DateTime\\?\\n`));
    }
    expect(shop).toMatch(/\n\s+installSource\s+String\?\n/);
    expect(shop).toMatch(/\n\s+installSourceOther\s+String\?\n/);
    const fb = SCHEMA.slice(SCHEMA.indexOf("model MerchantFeedback {"));
    expect(fb).toMatch(/\n\s+topic\s+String\s+@default\("feedback"\)\n/);
    expect(fb).toMatch(/\n\s+csat\s+Int\?\n/);
    expect(fb).toMatch(/\n\s+contactConsentAt\s+DateTime\?\n/);
  });

  it("sorts right after the guard email consent hash column", () => {
    const dirs = readdirSync(join(ROOT, "prisma/migrations"))
      .filter((d) => /^\d{14}_/.test(d))
      .sort();
    const self = dirs.indexOf(NAME);
    const previous = dirs.indexOf("20261027300000_guard_email_consent_hash");
    // Both must exist: a missing name (-1) must fail, not pass vacuously.
    expect(self).toBeGreaterThanOrEqual(0);
    expect(previous).toBeGreaterThanOrEqual(0);
    expect(self).toBe(previous + 1);
  });
});

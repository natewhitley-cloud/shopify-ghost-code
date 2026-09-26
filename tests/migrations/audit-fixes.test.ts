/**
 * Guard test for the batch-E audit-fixes migration (20260926160000_audit_fixes).
 *
 * Tests never touch a database (.env points at prod), so this pins the reviewed
 * SQL text: additive ALTER TABLE statements on Shop only, and nothing else.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

const ROOT = join(__dirname, "..", "..");
const SQL = readFileSync(
  join(ROOT, "prisma/migrations/20260926160000_audit_fixes/migration.sql"),
  "utf8",
);
const SCHEMA = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");

/** The executable SQL only (comment lines stripped), whitespace-collapsed. */
const CODE = SQL.split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join(" ")
  .replace(/\s+/g, " ")
  .trim();

describe("audit_fixes migration", () => {
  it("sorts after the last migration it builds on", () => {
    expect("20260926160000_audit_fixes" > "20260926150000_add_shop_upgrade_return").toBe(true);
  });

  it("adds the review popup columns (gc-97k.7) in one additive ALTER TABLE", () => {
    expect(CODE).toContain(
      'ALTER TABLE "Shop" ADD COLUMN "reviewPopupAttemptCount" INTEGER NOT NULL DEFAULT 0, ' +
        'ADD COLUMN "reviewPopupLastAttemptAt" TIMESTAMP(3), ' +
        'ADD COLUMN "reviewPopupLastResult" TEXT, ' +
        'ADD COLUMN "reviewPopupRetryAfter" TIMESTAMP(3);',
    );
  });

  it("never drops, renames, or touches another table's structure", () => {
    expect(CODE).not.toMatch(/\bDROP\b/i);
    expect(CODE).not.toMatch(/\bRENAME\b/i);
    expect(CODE).not.toMatch(/ALTER TABLE "(?!Shop")/);
  });

  it("matches the Prisma schema", () => {
    expect(SCHEMA).toMatch(/\n\s+reviewPopupRetryAfter\s+DateTime\?\n/);
    expect(SCHEMA).toMatch(/\n\s+reviewPopupAttemptCount\s+Int\s+@default\(0\)\n/);
    expect(SCHEMA).toMatch(/\n\s+reviewPopupLastAttemptAt\s+DateTime\?\n/);
    expect(SCHEMA).toMatch(/\n\s+reviewPopupLastResult\s+String\?\n/);
  });

  it("keeps the retired hasSeenReviewPrompt column (owner decision 2A: never drop)", () => {
    expect(SCHEMA).toMatch(/\n\s+hasSeenReviewPrompt\s+Boolean\s+@default\(false\)\n/);
  });
});

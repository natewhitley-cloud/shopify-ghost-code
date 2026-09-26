/**
 * Guard test for the gc-97k.6 migration (20260926130000_add_shop_prompt_cap).
 *
 * Tests never touch a database (.env points at prod), so this pins the reviewed
 * SQL text: two additive, nullable columns on Shop and nothing else.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

const ROOT = join(__dirname, "..", "..");
const SQL = readFileSync(
  join(ROOT, "prisma/migrations/20260926130000_add_shop_prompt_cap/migration.sql"),
  "utf8",
);
const SCHEMA = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");

/** The executable SQL only (comment lines stripped), whitespace-collapsed. */
const CODE = SQL.split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join(" ")
  .replace(/\s+/g, " ")
  .trim();

describe("add_shop_prompt_cap migration (gc-97k.6)", () => {
  it("is exactly one ALTER TABLE adding both nullable columns, with no backfill", () => {
    expect(CODE).toBe(
      'ALTER TABLE "Shop" ADD COLUMN "lastPromptKey" TEXT, ADD COLUMN "lastPromptShownAt" TIMESTAMP(3);',
    );
  });

  it("matches the Prisma schema (optional String and DateTime on Shop)", () => {
    expect(SCHEMA).toMatch(/\n\s+lastPromptKey\s+String\?\n/);
    expect(SCHEMA).toMatch(/\n\s+lastPromptShownAt\s+DateTime\?\n/);
  });
});

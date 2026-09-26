/**
 * Guard test for the gc-97k.9 migration (20260926150000_add_shop_upgrade_return).
 *
 * Tests never touch a database (.env points at prod), so this pins the reviewed
 * SQL text: one additive ALTER TABLE on Shop, six nullable timestamps and one
 * NOT NULL DEFAULT 0 counter, and nothing else.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

const ROOT = join(__dirname, "..", "..");
const SQL = readFileSync(
  join(ROOT, "prisma/migrations/20260926150000_add_shop_upgrade_return/migration.sql"),
  "utf8",
);
const SCHEMA = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");

/** The executable SQL only (comment lines stripped), whitespace-collapsed. */
const CODE = SQL.split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join(" ")
  .replace(/\s+/g, " ")
  .trim();

const TIMESTAMPS = [
  "upgradeReturnClickedAt",
  "upgradeReturnConvertedAt",
  "upgradeReturnDismissedAt",
  "upgradeReturnLastDismissedAt",
  "upgradeReturnLastShownAt",
  "upgradeReturnShownAt",
];

describe("add_shop_upgrade_return migration (gc-97k.9)", () => {
  it("is exactly one additive ALTER TABLE with no backfill, drop or rename", () => {
    expect(CODE).toBe(
      'ALTER TABLE "Shop" ADD COLUMN "upgradeReturnClickedAt" TIMESTAMP(3), ' +
        'ADD COLUMN "upgradeReturnConvertedAt" TIMESTAMP(3), ' +
        'ADD COLUMN "upgradeReturnDismissCount" INTEGER NOT NULL DEFAULT 0, ' +
        'ADD COLUMN "upgradeReturnDismissedAt" TIMESTAMP(3), ' +
        'ADD COLUMN "upgradeReturnLastDismissedAt" TIMESTAMP(3), ' +
        'ADD COLUMN "upgradeReturnLastShownAt" TIMESTAMP(3), ' +
        'ADD COLUMN "upgradeReturnShownAt" TIMESTAMP(3);',
    );
  });

  it("matches the Prisma schema (optional DateTimes, Int default 0)", () => {
    for (const column of TIMESTAMPS) {
      expect(SCHEMA).toMatch(new RegExp(`\\n\\s+${column}\\s+DateTime\\?\\n`));
    }
    expect(SCHEMA).toMatch(/\n\s+upgradeReturnDismissCount\s+Int\s+@default\(0\)\n/);
  });
});

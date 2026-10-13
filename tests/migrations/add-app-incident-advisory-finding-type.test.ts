/**
 * Guard test for the affected-app advisory migration
 * (20261019120000_add_app_incident_advisory_finding_type, gc-14x5).
 *
 * Tests never touch a database (.env points at prod), so this pins the reviewed
 * SQL text: exactly one additive, idempotent enum value, matching the schema.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

const ROOT = join(__dirname, "..", "..");
const NAME = "20261019120000_add_app_incident_advisory_finding_type";
const SQL = readFileSync(join(ROOT, "prisma/migrations", NAME, "migration.sql"), "utf8");
const SCHEMA = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");

/** The executable SQL only (comment lines stripped), whitespace-collapsed. */
const CODE = SQL.split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join(" ")
  .replace(/\s+/g, " ")
  .trim();

describe("add_app_incident_advisory_finding_type migration (gc-14x5)", () => {
  it("adds exactly the one enum value, idempotently", () => {
    expect(CODE).toBe(`ALTER TYPE "FindingType" ADD VALUE IF NOT EXISTS 'APP_INCIDENT_ADVISORY';`);
  });

  it("is destructive-free and touches no table", () => {
    expect(CODE).not.toMatch(/\b(DROP|DELETE|UPDATE|RENAME|TRUNCATE|TABLE|COLUMN)\b/i);
  });

  it("documents that the enum value stays on a manual rollback", () => {
    expect(SQL).toMatch(/Enum values cannot be dropped in Postgres/);
  });

  it("matches the Prisma schema (the enum's last value)", () => {
    expect(SCHEMA).toMatch(/enum FindingType \{[^}]*?\n\s+APP_INCIDENT_ADVISORY\n\}/);
  });

  it("is the latest migration (applied last on deploy), right after theme health", () => {
    const dirs = readdirSync(join(ROOT, "prisma/migrations"))
      .filter((d) => /^\d{14}_/.test(d))
      .sort();
    expect(dirs.at(-1)).toBe(NAME);
    expect(dirs.at(-2)).toBe("20261018120000_add_theme_health");
  });
});

/**
 * Guard test for the gc-dpm.1 migration (20260926120000_add_shop_journey_milestones).
 *
 * The repo has no migration-execution harness (and tests must never touch a
 * database: .env points at prod), so this pins the reviewed SQL text: the
 * additive columns, and each backfill's exact sources and NULL-only guard. A
 * later edit that drops a clause (e.g. the IS NULL guard, or the scan-detail
 * path filter) fails here instead of silently shipping.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

const ROOT = join(__dirname, "..", "..");
const SQL = readFileSync(
  join(ROOT, "prisma/migrations/20260926120000_add_shop_journey_milestones/migration.sql"),
  "utf8",
);
const SCHEMA = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");

/** The executable SQL only (comment lines stripped), whitespace-collapsed. */
const CODE = SQL.split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join(" ")
  .replace(/\s+/g, " ")
  .trim();

/** The body of one UPDATE statement, from `SET "<column>"` to its `;`. */
function updateFor(column: string): string {
  const start = CODE.indexOf(`SET "${column}"`);
  expect(start, `no UPDATE sets ${column}`).toBeGreaterThan(-1);
  return CODE.slice(start, CODE.indexOf(";", start));
}

describe("add_shop_journey_milestones migration (gc-dpm.1)", () => {
  it("adds both milestone columns as nullable TIMESTAMP(3) in one ALTER TABLE", () => {
    expect(CODE).toContain(
      'ALTER TABLE "Shop" ADD COLUMN "firstOpenedAt" TIMESTAMP(3), ADD COLUMN "firstResultsViewedAt" TIMESTAMP(3);',
    );
    expect(CODE).not.toMatch(/NOT NULL|DEFAULT/);
  });

  it("matches the Prisma schema (both columns are optional DateTime on Shop)", () => {
    expect(SCHEMA).toMatch(/\n\s+firstOpenedAt\s+DateTime\?\n/);
    expect(SCHEMA).toMatch(/\n\s+firstResultsViewedAt\s+DateTime\?\n/);
  });

  it("only ALTERs and UPDATEs Shop (no deletes, drops or other tables written)", () => {
    const statements = CODE.split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements).toHaveLength(3);
    expect(statements[0]).toMatch(/^ALTER TABLE "Shop" ADD COLUMN/);
    expect(statements[1]).toMatch(/^UPDATE "Shop" AS s SET "firstOpenedAt"/);
    expect(statements[2]).toMatch(/^UPDATE "Shop" AS s SET "firstResultsViewedAt"/);
    expect(CODE).not.toMatch(/\b(DELETE|DROP|TRUNCATE|INSERT)\b/);
  });

  describe("firstOpenedAt backfill", () => {
    it("takes the LEAST of first page_visit, lastSeenAt and first scan", () => {
      const u = updateFor("firstOpenedAt");
      expect(u).toMatch(/= LEAST\(/);
      expect(u).toContain(
        `(SELECT MIN(e."createdAt") FROM "OpsEvent" AS e WHERE e."eventType" = 'page_visit' AND e."key" = s."domain")`,
      );
      expect(u).toContain('s."lastSeenAt"');
      expect(u).toContain(
        `(SELECT MIN(sc."createdAt") FROM "Scan" AS sc WHERE sc."shopId" = s."id")`,
      );
    });

    it("fills only NULL columns", () => {
      expect(updateFor("firstOpenedAt")).toMatch(/WHERE s\."firstOpenedAt" IS NULL$/);
    });
  });

  describe("firstResultsViewedAt backfill", () => {
    it("takes the first page_visit to a scan DETAIL path for the shop's domain", () => {
      const u = updateFor("firstResultsViewedAt");
      expect(u).toContain(`SELECT MIN(e."createdAt") FROM "OpsEvent" AS e`);
      expect(u).toContain(`e."eventType" = 'page_visit'`);
      expect(u).toContain(`e."key" = s."domain"`);
      // JSONB text extraction of metadata.path (metadata is a JSONB column).
      expect(u).toContain(`e."metadata"->>'path' LIKE '/app/scans/_%'`);
    });

    it("fills only NULL columns", () => {
      expect(updateFor("firstResultsViewedAt")).toMatch(/WHERE s\."firstResultsViewedAt" IS NULL$/);
    });

    // Mirror of the SQL LIKE '/app/scans/_%' ('_' = exactly one character,
    // '%' = any run) so the path semantics are pinned by example.
    const likeScanDetail = (path: string) => /^\/app\/scans\/.[\s\S]*$/.test(path);

    it.each([
      ["/app/scans/abc123", true],
      ["/app/scans/abc123/diff", true],
      ["/app/scans/abc123/export", true],
      ["/app/scans", false],
      ["/app/scans/", false],
      ["/app", false],
      ["/app/settings", false],
      ["/app/scansx/abc", false],
    ])("path %s counts as a results view: %s", (path, expected) => {
      expect(likeScanDetail(path)).toBe(expected);
    });
  });

  it("documents the 14-day page_visit retention limitation", () => {
    expect(SQL).toMatch(/pruned after 14 days/);
    expect(SQL).toMatch(/stays NULL \(unknown, not "never"\)/);
  });
});

/**
 * GDPR coverage for the "What changed" tables (gc-rrh.4, spec 1.6).
 *
 * shop/redact -> deleteShopData must remove every ScanManifest and
 * ScanChangeSet row of the shop. Neither table has a Shop FK or its own delete
 * clause: both cascade from Scan, which cascades from Shop, and deleteShopData
 * deletes the Shop row inside its transaction. Tests never touch a database,
 * so each link of that chain is pinned here:
 *   1. deleteShopData deletes the Shop row (the cascade's trigger);
 *   2. Scan cascades from Shop (schema);
 *   3. ScanManifest / ScanChangeSet cascade from Scan (schema AND the
 *      migration SQL Postgres actually runs).
 * app/uninstalled deliberately keeps scan data until shop/redact (gc-grd), so
 * the uninstall path has nothing to add.
 *
 * customers/data_request + customers/redact: neither table holds customer data
 * (theme file paths, hashes, app names and public hostnames only).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = vi.hoisted(() => ({
  shop: { findUnique: vi.fn(), delete: vi.fn() },
  session: { deleteMany: vi.fn() },
  opsEvent: { deleteMany: vi.fn() },
  merchantFeedback: { deleteMany: vi.fn() },
  merchantAlert: { deleteMany: vi.fn() },
  scanManifest: { deleteMany: vi.fn() },
  scanChangeSet: { deleteMany: vi.fn() },
  $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
}));
vi.mock("../../app/db.server", () => ({ default: mockDb }));
vi.mock("../../inngest/client", () => ({ inngest: { send: vi.fn() } }));

import { deleteShopData } from "../../app/models/shop.server";

const ROOT = join(__dirname, "..", "..");
const SCHEMA = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");
const MIGRATION = readFileSync(
  join(ROOT, "prisma/migrations/20261020120000_add_change_log/migration.sql"),
  "utf8",
);

function model(name: string): string {
  const rest = SCHEMA.slice(SCHEMA.indexOf(`model ${name} {`));
  return rest.slice(0, rest.indexOf("\n}"));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("shop/redact removes change-log data", () => {
  it("deleteShopData deletes the Shop row in its transaction (the cascade's trigger)", async () => {
    const shop = { id: "shop-cl", domain: "delete-me.myshopify.com", plan: "Professional" };
    mockDb.shop.findUnique.mockResolvedValue(shop);
    mockDb.session.deleteMany.mockResolvedValue({ count: 0 });
    mockDb.opsEvent.deleteMany.mockResolvedValue({ count: 0 });
    mockDb.shop.delete.mockResolvedValue(shop);

    await deleteShopData(shop.domain);

    expect(mockDb.$transaction).toHaveBeenCalledOnce();
    expect(mockDb.shop.delete).toHaveBeenCalledWith({ where: { domain: shop.domain } });
    // No explicit clause: the rows go with the cascade, inside the same
    // transaction, so they cannot outlive the Shop row.
    expect(mockDb.scanManifest.deleteMany).not.toHaveBeenCalled();
    expect(mockDb.scanChangeSet.deleteMany).not.toHaveBeenCalled();
  });

  it("Scan cascades from Shop", () => {
    expect(model("Scan")).toMatch(
      /shop\s+Shop\s+@relation\(fields: \[shopId\], references: \[id\], onDelete: Cascade\)/,
    );
  });

  it.each(["ScanManifest", "ScanChangeSet"])("%s cascades from Scan in the schema", (name) => {
    expect(model(name)).toMatch(
      /scan\s+Scan\s+@relation\(fields: \[scanId\], references: \[id\], onDelete: Cascade\)/,
    );
  });

  it.each(["ScanManifest", "ScanChangeSet"])(
    "%s cascades from Scan in the migration SQL that runs on deploy",
    (name) => {
      expect(MIGRATION.replace(/\s+/g, " ")).toContain(
        `ALTER TABLE "${name}" ADD CONSTRAINT "${name}_scanId_fkey" FOREIGN KEY ("scanId") ` +
          'REFERENCES "Scan"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
      );
    },
  );

  it("neither table stores file content or personal data columns", () => {
    for (const name of ["ScanManifest", "ScanChangeSet"]) {
      expect(model(name)).not.toMatch(/\b(content|code|email|recipient|snippet)\b\s+String/i);
    }
  });
});

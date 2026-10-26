/**
 * GDPR coverage for the checkout guard (gc-1q1s.4).
 *
 * shop/redact -> deleteShopData must remove everything the guard stores:
 *   - StorefrontGuardState and StorefrontIncident cascade from the Shop FK
 *     (pinned here from the schema so a dropped cascade fails this test) AND
 *     are deleted explicitly in deleteShopData's transaction.
 *   - The consent stamps live on the Shop row itself.
 *   - No guard OpsEvent type exists, so no new redact predicate is needed.
 *
 * customers/data_request + customers/redact: the guard stores hostnames and
 * timestamps only, no customer data.
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
  storefrontIncident: { deleteMany: vi.fn() },
  storefrontGuardState: { deleteMany: vi.fn() },
  $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
}));
vi.mock("../../app/db.server", () => ({ default: mockDb }));

import { deleteShopData } from "../../app/models/shop.server";

const SCHEMA = readFileSync(join(__dirname, "..", "..", "prisma/schema.prisma"), "utf8");

function modelBody(name: string): string {
  const model = SCHEMA.slice(SCHEMA.indexOf(`model ${name} {`));
  return model.slice(0, model.indexOf("\n}"));
}

beforeEach(() => vi.clearAllMocks());

describe("shop/redact removes checkout guard data", () => {
  it.each(["StorefrontGuardState", "StorefrontIncident"])("%s cascades from Shop", (name) => {
    expect(modelBody(name)).toMatch(
      /shop\s+Shop\s+@relation\(fields: \[shopId\], references: \[id\], onDelete: Cascade\)/,
    );
  });

  it("neither table has a column that could hold an email or page text", () => {
    for (const name of ["StorefrontGuardState", "StorefrontIncident"]) {
      const columns = modelBody(name)
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .map((line) => line.trim().split(/\s+/)[0]);
      // emailedOpenedAt is a timestamp of when an email went out, not an address.
      const named = columns.filter((c) => /email|recipient|html|snippet|^path$/i.test(c));
      expect(named).toEqual(name === "StorefrontIncident" ? ["emailedOpenedAt"] : []);
    }
  });

  it("deleteShopData deletes both tables for the shop inside its one transaction", async () => {
    const shop = { id: "shop-g", domain: "redact-me.myshopify.com", plan: "Standard" };
    mockDb.shop.findUnique.mockResolvedValue(shop);
    mockDb.shop.delete.mockResolvedValue(shop);

    await deleteShopData(shop.domain);

    expect(mockDb.$transaction).toHaveBeenCalledOnce();
    expect(mockDb.storefrontIncident.deleteMany).toHaveBeenCalledWith({
      where: { shopId: "shop-g" },
    });
    expect(mockDb.storefrontGuardState.deleteMany).toHaveBeenCalledWith({
      where: { shopId: "shop-g" },
    });
    expect(mockDb.shop.delete).toHaveBeenCalledWith({ where: { domain: shop.domain } });
  });

  it("an unknown shop deletes nothing", async () => {
    mockDb.shop.findUnique.mockResolvedValue(null);
    expect(await deleteShopData("ghost.myshopify.com")).toBeNull();
    expect(mockDb.storefrontIncident.deleteMany).not.toHaveBeenCalled();
  });
});

/**
 * GDPR coverage for the store speed report (gc-wt3y).
 *
 * shop/redact -> deleteShopData must remove everything the feature stores for
 * the shop:
 *   - SpeedReport rows: cascade from the Shop FK (deleteShopData deletes the
 *     Shop row inside its transaction). Pinned here from the schema so a future
 *     edit that drops the cascade fails this test.
 *   - speed_report OpsEvents: written with key = shop domain, which
 *     deleteShopData's `key: domain` clause reaches. Bound here through the REAL
 *     writer (recordSpeedReportEvent) so a change of key shape fails this test.
 *   - Shop.speedReportRequestedAt lives on the Shop row itself.
 *   - PageSpeedDailyUsage holds no shop data (global per-day counter).
 *
 * customers/data_request + customers/redact: a speed report holds no customer
 * data (public storefront URLs, timings and app names only), so those handlers
 * correctly have nothing to add (see SpeedPageResult in app/lib/speed-report.ts).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = vi.hoisted(() => ({
  shop: { findUnique: vi.fn(), delete: vi.fn() },
  session: { deleteMany: vi.fn() },
  opsEvent: { create: vi.fn(), deleteMany: vi.fn() },
  merchantFeedback: { deleteMany: vi.fn() },
  merchantAlert: { deleteMany: vi.fn() },
  storefrontIncident: { deleteMany: vi.fn() },
  storefrontGuardState: { deleteMany: vi.fn() },
  speedReport: { deleteMany: vi.fn() },
  $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
}));
vi.mock("../../app/db.server", () => ({ default: mockDb }));
vi.mock("../../inngest/client", () => ({ inngest: { send: vi.fn() } }));

import { deleteShopData } from "../../app/models/shop.server";
import { recordSpeedReportEvent } from "../../app/services/speed-report.server";

const ROOT = join(__dirname, "..", "..");
const SCHEMA = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("shop/redact removes speed report data", () => {
  it("SpeedReport cascades from Shop, so deleting the Shop row deletes the reports", () => {
    const model = SCHEMA.slice(SCHEMA.indexOf("model SpeedReport {"));
    const body = model.slice(0, model.indexOf("\n}"));
    expect(body).toMatch(
      /shop\s+Shop\s+@relation\(fields: \[shopId\], references: \[id\], onDelete: Cascade\)/,
    );
    expect(body).toMatch(/shopId\s+String\n/);
  });

  it("the global PageSpeedDailyUsage counter has no shop column", () => {
    const model = SCHEMA.slice(SCHEMA.indexOf("model PageSpeedDailyUsage {"));
    const body = model.slice(0, model.indexOf("\n}"));
    expect(body).not.toMatch(/shop/i);
  });

  it("deleteShopData deletes the Shop row in its transaction (the cascade's trigger)", async () => {
    const shop = { id: "shop-sr", domain: "delete-me.myshopify.com", plan: "Professional" };
    mockDb.shop.findUnique.mockResolvedValue(shop);
    mockDb.session.deleteMany.mockResolvedValue({ count: 0 });
    mockDb.opsEvent.deleteMany.mockResolvedValue({ count: 0 });
    mockDb.shop.delete.mockResolvedValue(shop);

    await deleteShopData(shop.domain);

    expect(mockDb.$transaction).toHaveBeenCalledOnce();
    expect(mockDb.shop.delete).toHaveBeenCalledWith({ where: { domain: shop.domain } });
  });

  it("speed_report OpsEvents written by the real writer are reached by the redact predicate; other shops' are not", async () => {
    const target = "delete-me.myshopify.com";
    const other = "keep-me.myshopify.com";
    for (const domain of [target, other]) {
      await recordSpeedReportEvent(domain, {
        status: "COMPLETED",
        origin: "SCHEDULED",
        calls: 6,
        durationMs: 1000,
      });
      await recordSpeedReportEvent(domain, {
        status: "FAILED",
        origin: "MANUAL",
        calls: 0,
        durationMs: 0,
        reason: "not_configured",
      });
    }
    const written = mockDb.opsEvent.create.mock.calls.map(
      (c) => c[0].data as { eventType: string; key: string; metadata: Record<string, unknown> },
    );
    expect(written).toHaveLength(4);
    expect(written.every((w) => w.eventType === "speed_report")).toBe(true);

    mockDb.shop.findUnique.mockResolvedValue({
      id: "shop-x",
      domain: target,
      plan: "Professional",
    });
    mockDb.session.deleteMany.mockResolvedValue({ count: 0 });
    mockDb.opsEvent.deleteMany.mockResolvedValue({ count: 2 });
    mockDb.shop.delete.mockResolvedValue({});
    await deleteShopData(target);

    type Clause = { key?: string; metadata?: { path: string[]; equals: string } };
    const where = mockDb.opsEvent.deleteMany.mock.calls[0][0].where as { OR: Clause[] };
    const reached = (row: (typeof written)[number]) =>
      where.OR.some((c) =>
        c.key !== undefined
          ? row.key === c.key
          : c.metadata !== undefined && row.metadata?.[c.metadata.path[0]] === c.metadata.equals,
      );
    expect(written.filter((w) => w.key === target).every(reached)).toBe(true);
    expect(written.filter((w) => w.key === other).some(reached)).toBe(false);
  });
});

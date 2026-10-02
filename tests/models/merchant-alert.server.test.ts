/**
 * Tests for app/models/merchant-alert.server.ts (gc-syz.1). Prisma is mocked;
 * tests never touch a database (.env points at prod).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = vi.hoisted(() => ({
  shop: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  merchantAlert: { findFirst: vi.fn(), create: vi.fn() },
}));

vi.mock("../../app/db.server", () => ({ default: mockDb }));

import {
  disableAlertsByToken,
  ensureUnsubscribeToken,
  generateUnsubscribeToken,
  getLatestMerchantAlert,
  recordMerchantAlert,
  setShopAlertEmail,
  setShopAlertEmailByDomain,
  setShopAlertsEnabled,
} from "../../app/models/merchant-alert.server";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("generateUnsubscribeToken", () => {
  it("is url-safe base64 of >= 128 bits (256 here)", () => {
    const token = generateUnsubscribeToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
  });

  it("is unique across many calls", () => {
    const tokens = new Set(Array.from({ length: 1000 }, generateUnsubscribeToken));
    expect(tokens.size).toBe(1000);
  });
});

describe("ledger helpers", () => {
  it("getLatestMerchantAlert reads the newest row for the shop", async () => {
    const row = { id: "a1" };
    mockDb.merchantAlert.findFirst.mockResolvedValue(row);
    await expect(getLatestMerchantAlert("s1")).resolves.toBe(row);
    expect(mockDb.merchantAlert.findFirst).toHaveBeenCalledWith({
      where: { shopId: "s1" },
      orderBy: { sentAt: "desc" },
    });
  });

  it("getLatestMerchantAlert returns null when none sent", async () => {
    mockDb.merchantAlert.findFirst.mockResolvedValue(null);
    await expect(getLatestMerchantAlert("s1")).resolves.toBeNull();
  });

  it("recordMerchantAlert inserts exactly the given fields", async () => {
    const input = {
      shopId: "s1",
      scanId: "scan1",
      findingSetHash: "abc",
      newCount: 3,
      recipient: "owner@example.com",
    };
    mockDb.merchantAlert.create.mockResolvedValue({ id: "a1", ...input });
    await recordMerchantAlert(input);
    expect(mockDb.merchantAlert.create).toHaveBeenCalledWith({ data: input });
  });
});

describe("shop preference helpers", () => {
  it("setShopAlertEmail writes the email, and null clears it", async () => {
    await setShopAlertEmail("s1", "o@example.com");
    expect(mockDb.shop.update).toHaveBeenLastCalledWith({
      where: { id: "s1" },
      data: { alertEmail: "o@example.com" },
    });
    await setShopAlertEmail("s1", null);
    expect(mockDb.shop.update).toHaveBeenLastCalledWith({
      where: { id: "s1" },
      data: { alertEmail: null },
    });
  });

  it("setShopAlertsEnabled toggles the flag", async () => {
    await setShopAlertsEnabled("s1", false);
    expect(mockDb.shop.update).toHaveBeenCalledWith({
      where: { id: "s1" },
      data: { alertsEnabled: false },
    });
  });

  it("setShopAlertEmailByDomain only writes when the value differs, including NULL", async () => {
    await setShopAlertEmailByDomain("a.myshopify.com", "o@example.com");
    expect(mockDb.shop.updateMany).toHaveBeenCalledWith({
      where: {
        domain: "a.myshopify.com",
        OR: [{ alertEmail: null }, { alertEmail: { not: "o@example.com" } }],
      },
      data: { alertEmail: "o@example.com" },
    });
  });
});

describe("ensureUnsubscribeToken", () => {
  it("returns null for an unknown shop and writes nothing", async () => {
    mockDb.shop.findUnique.mockResolvedValue(null);
    await expect(ensureUnsubscribeToken("nope")).resolves.toBeNull();
    expect(mockDb.shop.updateMany).not.toHaveBeenCalled();
  });

  it("returns the existing token without writing", async () => {
    mockDb.shop.findUnique.mockResolvedValue({ alertUnsubscribeToken: "existing" });
    await expect(ensureUnsubscribeToken("s1")).resolves.toBe("existing");
    expect(mockDb.shop.updateMany).not.toHaveBeenCalled();
  });

  it("mints a url-safe token with a write guarded on the column still being NULL", async () => {
    mockDb.shop.findUnique
      .mockResolvedValueOnce({ alertUnsubscribeToken: null })
      .mockImplementationOnce(async () => ({
        alertUnsubscribeToken: mockDb.shop.updateMany.mock.calls[0][0].data.alertUnsubscribeToken,
      }));
    mockDb.shop.updateMany.mockResolvedValue({ count: 1 });

    const token = await ensureUnsubscribeToken("s1");

    const call = mockDb.shop.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: "s1", alertUnsubscribeToken: null });
    expect(token).toBe(call.data.alertUnsubscribeToken);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("on a lost race returns the winner's token, not its own", async () => {
    mockDb.shop.findUnique
      .mockResolvedValueOnce({ alertUnsubscribeToken: null })
      .mockResolvedValueOnce({ alertUnsubscribeToken: "winner" });
    mockDb.shop.updateMany.mockResolvedValue({ count: 0 });
    await expect(ensureUnsubscribeToken("s1")).resolves.toBe("winner");
  });
});

describe("disableAlertsByToken", () => {
  it("disables and returns true when a shop holds the token", async () => {
    mockDb.shop.updateMany.mockResolvedValue({ count: 1 });
    await expect(disableAlertsByToken("tok")).resolves.toBe(true);
    expect(mockDb.shop.updateMany).toHaveBeenCalledWith({
      where: { alertUnsubscribeToken: "tok" },
      data: { alertsEnabled: false },
    });
  });

  it("returns false when no shop matches", async () => {
    mockDb.shop.updateMany.mockResolvedValue({ count: 0 });
    await expect(disableAlertsByToken("unknown")).resolves.toBe(false);
  });

  it.each([
    ["empty", ""],
    ["oversized", "x".repeat(129)],
    ["undefined", undefined as unknown as string],
    ["null", null as unknown as string],
    ["object", { not: "" } as unknown as string],
  ])("%s token changes nothing", async (_label, token) => {
    await expect(disableAlertsByToken(token)).resolves.toBe(false);
    expect(mockDb.shop.updateMany).not.toHaveBeenCalled();
  });
});

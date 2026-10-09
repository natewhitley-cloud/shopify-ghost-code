/**
 * Tests for app/models/merchant-alert.server.ts (gc-syz.1, gc-ol95). Prisma is mocked;
 * tests never touch a database (.env points at prod).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = vi.hoisted(() => ({
  shop: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  merchantAlert: { findFirst: vi.fn(), create: vi.fn() },
}));

vi.mock("../../app/db.server", () => ({ default: mockDb }));

import {
  claimSummaryNoticeShown,
  disableAlertsByToken,
  dismissSummaryNotice,
  ensureUnsubscribeToken,
  generateUnsubscribeToken,
  getLatestMerchantAlert,
  markSummaryNoticePending,
  recordMerchantAlert,
  setShopAlertEmail,
  setShopAlertEmailByDomain,
  setSummaryEmailsEnabled,
} from "../../app/models/merchant-alert.server";
import { summaryShopSkipReason } from "../../app/services/summary-email.server";

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
      fixedCount: 1,
      inactiveAppCount: 2,
      cleanedAppCount: 0,
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

  it("setSummaryEmailsEnabled(false) turns the toggle off and clears nothing else", async () => {
    await setSummaryEmailsEnabled("s1", false, { sendingLive: true, noticeShown: false });
    expect(mockDb.shop.update).toHaveBeenCalledWith({
      where: { id: "s1" },
      data: { alertsEnabled: false },
    });
  });

  it("opting in while sending is LIVE records consent (summaryOptedInAt), no notice owed", async () => {
    await setSummaryEmailsEnabled("s1", true, { sendingLive: true, noticeShown: false });
    const data = mockDb.shop.update.mock.calls[0][0].data;
    expect(data.alertsEnabled).toBe(true);
    expect(data.summaryOptedInAt).toBeInstanceOf(Date);
    expect(data).not.toHaveProperty("summaryNoticePendingAt");
  });

  it("opting in while DARK is not consent: toggle on + Home notice owed, no summaryOptedInAt (Q9=9A)", async () => {
    await setSummaryEmailsEnabled("s1", true, { sendingLive: false, noticeShown: false });
    const data = mockDb.shop.update.mock.calls[0][0].data;
    expect(data.alertsEnabled).toBe(true);
    expect(data.summaryNoticePendingAt).toBeInstanceOf(Date);
    expect(data).not.toHaveProperty("summaryOptedInAt");
  });

  it("opting in while dark after the notice was already shown only turns the toggle on", async () => {
    await setSummaryEmailsEnabled("s1", true, { sendingLive: false, noticeShown: true });
    expect(mockDb.shop.update.mock.calls[0][0].data).toEqual({ alertsEnabled: true });
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
      // Rotates: the used token is nulled so a logged token is already dead.
      data: { alertsEnabled: false, alertUnsubscribeToken: null },
    });
  });

  it("a rotated (nulled) token is re-minted by the next ensureUnsubscribeToken", async () => {
    mockDb.shop.findUnique
      .mockResolvedValueOnce({ alertUnsubscribeToken: null })
      .mockImplementationOnce(async () => ({
        alertUnsubscribeToken: mockDb.shop.updateMany.mock.calls[0][0].data.alertUnsubscribeToken,
      }));
    mockDb.shop.updateMany.mockResolvedValue({ count: 1 });
    await expect(ensureUnsubscribeToken("s1")).resolves.toMatch(/^[A-Za-z0-9_-]{43}$/);
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

describe("summary notice consent stamps (gc-ol95)", () => {
  it("markSummaryNoticePending claims once, only for a shop never told and never opted in", async () => {
    mockDb.shop.updateMany.mockResolvedValue({ count: 1 });
    await expect(markSummaryNoticePending("a.myshopify.com")).resolves.toBe(true);
    const call = mockDb.shop.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({
      domain: "a.myshopify.com",
      summaryNoticePendingAt: null,
      summaryNoticeShownAt: null,
      summaryOptedInAt: null,
    });
    expect(call.data.summaryNoticePendingAt).toBeInstanceOf(Date);
  });

  it("markSummaryNoticePending reports false when the claim matched no row", async () => {
    mockDb.shop.updateMany.mockResolvedValue({ count: 0 });
    await expect(markSummaryNoticePending("a.myshopify.com")).resolves.toBe(false);
  });

  it("claimSummaryNoticeShown stamps shown once, only while the notice is pending", async () => {
    mockDb.shop.updateMany.mockResolvedValue({ count: 1 });
    await expect(claimSummaryNoticeShown("a.myshopify.com")).resolves.toBe(true);
    const call = mockDb.shop.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({
      domain: "a.myshopify.com",
      summaryNoticeShownAt: null,
      summaryNoticePendingAt: { not: null },
    });
    expect(call.data.summaryNoticeShownAt).toBeInstanceOf(Date);
  });

  it("claimSummaryNoticeShown loses a concurrent claim (count 0)", async () => {
    mockDb.shop.updateMany.mockResolvedValue({ count: 0 });
    await expect(claimSummaryNoticeShown("a.myshopify.com")).resolves.toBe(false);
  });

  it("dismissSummaryNotice clears the pending flag for the shop only", async () => {
    await dismissSummaryNotice("s1");
    expect(mockDb.shop.updateMany).toHaveBeenCalledWith({
      where: { id: "s1" },
      data: { summaryNoticePendingAt: null },
    });
  });
});

describe("Settings opt-in -> summary eligibility (gc-ol95, Nathan Q9=9A)", () => {
  /** A paid shop that was never told and never opted in, as stored. */
  const BASE = {
    id: "s1",
    domain: "a.myshopify.com",
    plan: "Professional",
    alertsEnabled: false,
    alertEmail: "o@example.com",
    uninstalledAt: null,
    summaryNoticePendingAt: null as Date | null,
    summaryNoticeShownAt: null as Date | null,
    summaryOptedInAt: null as Date | null,
  };
  /** Apply what setSummaryEmailsEnabled wrote to the stored row. */
  async function optIn(sendingLive: boolean) {
    await setSummaryEmailsEnabled("s1", true, { sendingLive, noticeShown: false });
    return { ...BASE, ...mockDb.shop.update.mock.calls.at(-1)![0].data };
  }

  it("dark opt-in is NOT eligible until Home's notice is shown", async () => {
    const row = await optIn(false);
    expect(summaryShopSkipReason(row)).toBe("no_consent");
    // Home renders the notice (claimSummaryNoticeShown stamps it): now eligible.
    expect(summaryShopSkipReason({ ...row, summaryNoticeShownAt: new Date() })).toBeNull();
  });

  it("live opt-in is eligible immediately", async () => {
    expect(summaryShopSkipReason(await optIn(true))).toBeNull();
  });
});

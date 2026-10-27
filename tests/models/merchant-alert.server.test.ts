/**
 * Tests for app/models/merchant-alert.server.ts (gc-syz.1, gc-ol95). Prisma is mocked;
 * tests never touch a database (.env points at prod).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = vi.hoisted(() => ({
  shop: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  merchantAlert: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn(),
    count: vi.fn(),
    deleteMany: vi.fn(),
  },
  $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
}));

vi.mock("../../app/db.server", () => ({ default: mockDb }));

import {
  claimGuardEmailNoticeShown,
  resetGuardEmailNotice,
  countGuardAlertsSince,
  turnOffGuardEmail,
  enableGuardEmail,
  claimSummaryNoticeShown,
  claimSummaryOptInFirstShown,
  declineSummaryOptIn,
  emailedGuardIncidentKeys,
  GUARD_INCIDENT_LEDGER_RETENTION_MS,
  guardIncidentLedgerKey,
  pruneGuardIncidentLedger,
  recordGuardIncidentsEmailed,
  disableAlertsByToken,
  dismissSummaryNotice,
  ensureUnsubscribeToken,
  generateUnsubscribeToken,
  getLatestMerchantAlert,
  markSummaryNoticePending,
  recordMerchantAlert,
  setShopAlertEmail,
  setShopContactByDomain,
  setSummaryEmailsEnabled,
} from "../../app/models/merchant-alert.server";
import { summaryShopSkipReason } from "../../app/services/summary-email.server";
import { installFakeShopRow } from "../mocks/fake-shop-row";

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

describe("per-episode guard ledger (wave 3 B5)", () => {
  const key = guardIncidentLedgerKey({ id: "i1", openedAt: new Date("2026-10-27T00:00:00Z") });

  it("reads which episode keys are already in the ledger (none asked: no query)", async () => {
    expect(await emailedGuardIncidentKeys("s1", [])).toEqual(new Set());
    expect(mockDb.merchantAlert.findMany).not.toHaveBeenCalled();
    mockDb.merchantAlert.findMany.mockResolvedValue([{ scanId: key }]);
    expect(await emailedGuardIncidentKeys("s1", [key, "other"])).toEqual(new Set([key]));
    expect(mockDb.merchantAlert.findMany).toHaveBeenCalledWith({
      where: { shopId: "s1", kind: "checkout_guard_incident", scanId: { in: [key, "other"] } },
      select: { scanId: true },
    });
  });

  it("records one row per episode, keeping rows already there", async () => {
    await recordGuardIncidentsEmailed("s1", [key], "o@example.com");
    expect(mockDb.merchantAlert.createMany).toHaveBeenCalledWith({
      data: [
        {
          shopId: "s1",
          scanId: key,
          findingSetHash: key,
          newCount: 1,
          recipient: "o@example.com",
          kind: "checkout_guard_incident",
        },
      ],
      skipDuplicates: true,
    });
    await recordGuardIncidentsEmailed("s1", [], "o@example.com");
    expect(mockDb.merchantAlert.createMany).toHaveBeenCalledTimes(1);
  });
});

describe("per-episode guard ledger: bounded writes and retention (wave 4 M2)", () => {
  const keys = Array.from({ length: 2500 }, (_, i) => `guard-incident:i${i}:x`);

  it("reads and records 2,500 episode keys in chunks of at most 1,000", async () => {
    mockDb.merchantAlert.findMany.mockImplementation(
      async (args: { where: { scanId: { in: string[] } } }) => [
        { scanId: args.where.scanId.in[0] },
      ],
    );
    expect(await emailedGuardIncidentKeys("s1", keys)).toEqual(
      new Set([keys[0], keys[1000], keys[2000]]),
    );
    expect(
      mockDb.merchantAlert.findMany.mock.calls.map(
        (c) => (c[0] as { where: { scanId: { in: string[] } } }).where.scanId.in.length,
      ),
    ).toEqual([1000, 1000, 500]);
    await recordGuardIncidentsEmailed("s1", keys, "o@example.com");
    const writes = mockDb.merchantAlert.createMany.mock.calls.map(
      (c) => c[0] as { data: Array<{ scanId: string }>; skipDuplicates: boolean },
    );
    expect(writes.map((w) => w.data.length)).toEqual([1000, 1000, 500]);
    expect(writes.every((w) => w.skipDuplicates)).toBe(true);
    expect(writes.flatMap((w) => w.data.map((d) => d.scanId))).toEqual(keys);
  });

  it("prunes every shop's episode rows older than the retention (90 days), nothing else", async () => {
    mockDb.merchantAlert.deleteMany.mockResolvedValue({ count: 4 });
    const now = new Date("2026-10-27T00:00:00Z");
    expect(GUARD_INCIDENT_LEDGER_RETENTION_MS).toBe(90 * 24 * 60 * 60 * 1000);
    expect(await pruneGuardIncidentLedger(now)).toBe(4);
    expect(mockDb.merchantAlert.deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        kind: "checkout_guard_incident",
        sentAt: { lt: new Date(now.getTime() - GUARD_INCIDENT_LEDGER_RETENTION_MS) },
      },
    });
  });
});

describe("ledger helpers", () => {
  it("getLatestMerchantAlert reads the newest row for the shop, never a checkout guard email (gc-1q1s.7)", async () => {
    const row = { id: "a1" };
    mockDb.merchantAlert.findFirst.mockResolvedValue(row);
    await expect(getLatestMerchantAlert("s1")).resolves.toBe(row);
    // A guard incident email must never throttle or re-baseline the summary.
    expect(mockDb.merchantAlert.findFirst).toHaveBeenCalledWith({
      where: { shopId: "s1", kind: { notIn: ["checkout_guard", "checkout_guard_incident"] } },
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

  it("setSummaryEmailsEnabled(false) turns mail off and withdraws guard email consent (wave 3 U1)", async () => {
    await setSummaryEmailsEnabled("s1", false, { sendingLive: true, noticeShown: false });
    expect(mockDb.shop.update).toHaveBeenCalledWith({
      where: { id: "s1" },
      data: { alertsEnabled: false },
    });
    // Wave 4: the turn-off time is set only when none is stored (an earlier
    // turn-off keeps its time), in the same transaction as the mail switch.
    expect(mockDb.shop.updateMany).toHaveBeenCalledWith({
      where: { id: "s1", guardEmailOffAt: null },
      data: { guardEmailOffAt: expect.any(Date) },
    });
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
    for (const call of mockDb.shop.update.mock.calls) {
      expect(call[0].data).not.toHaveProperty("guardEmailOffAt");
    }
  });

  it("turning summaries back on never turns guard email back on (wave 3 U1)", async () => {
    for (const opts of [
      { sendingLive: true, noticeShown: false },
      { sendingLive: false, noticeShown: true },
      { sendingLive: false, noticeShown: false },
    ]) {
      mockDb.shop.update.mockClear();
      await setSummaryEmailsEnabled("s1", true, opts);
      const data = mockDb.shop.update.mock.calls[0][0].data;
      expect(data).not.toHaveProperty("guardEmailOffAt");
      expect(data).not.toHaveProperty("guardEmailNoticeShownAt");
    }
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

  it("setShopContactByDomain writes both fields only when either differs, including NULL", async () => {
    await setShopContactByDomain("a.myshopify.com", {
      email: "o@example.com",
      storeName: "Paw Naturals",
    });
    expect(mockDb.shop.updateMany).toHaveBeenCalledWith({
      where: {
        domain: "a.myshopify.com",
        OR: [
          { alertEmail: null },
          { alertEmail: { not: "o@example.com" } },
          { storeName: null },
          { storeName: { not: "Paw Naturals" } },
        ],
      },
      data: { alertEmail: "o@example.com", storeName: "Paw Naturals" },
    });
  });

  it("setShopContactByDomain never clears a cached field it could not read", async () => {
    await setShopContactByDomain("a.myshopify.com", { email: null, storeName: "Paw Naturals" });
    expect(mockDb.shop.updateMany).toHaveBeenCalledWith({
      where: {
        domain: "a.myshopify.com",
        OR: [{ storeName: null }, { storeName: { not: "Paw Naturals" } }],
      },
      data: { storeName: "Paw Naturals" },
    });
    vi.mocked(mockDb.shop.updateMany).mockClear();
    await setShopContactByDomain("a.myshopify.com", { email: "o@example.com", storeName: null });
    expect(mockDb.shop.updateMany.mock.calls[0][0].data).toEqual({ alertEmail: "o@example.com" });
  });

  it("setShopContactByDomain with nothing read writes nothing", async () => {
    await setShopContactByDomain("a.myshopify.com", { email: null, storeName: null });
    expect(mockDb.shop.updateMany).not.toHaveBeenCalled();
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
  it("disables, rotates the token, withdraws guard consent, and returns true", async () => {
    const row = installFakeShopRow(mockDb.shop, {
      alertsEnabled: true,
      alertUnsubscribeToken: "tok",
      guardEmailOffAt: null,
    });
    await expect(disableAlertsByToken("tok")).resolves.toBe(true);
    // Rotates: the used token is nulled so a logged token is already dead.
    expect(row.alertsEnabled).toBe(false);
    expect(row.alertUnsubscribeToken).toBeNull();
    // Wave 3 U1: also withdraws checkout guard email consent.
    expect(row.guardEmailOffAt).toBeInstanceOf(Date);
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
  });

  it("keeps an existing guard turn-off time (the first no wins)", async () => {
    const firstNo = new Date("2026-01-02T03:04:05Z");
    const row = installFakeShopRow(mockDb.shop, {
      alertsEnabled: true,
      alertUnsubscribeToken: "tok",
      guardEmailOffAt: firstNo,
    });
    await expect(disableAlertsByToken("tok")).resolves.toBe(true);
    expect(row.guardEmailOffAt).toEqual(firstNo);
    expect(row.alertsEnabled).toBe(false);
    expect(row.alertUnsubscribeToken).toBeNull();
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
  it("markSummaryNoticePending claims once, only for a shop never told, never opted in, never declined", async () => {
    mockDb.shop.updateMany.mockResolvedValue({ count: 1 });
    await expect(markSummaryNoticePending("a.myshopify.com")).resolves.toBe(true);
    const call = mockDb.shop.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({
      domain: "a.myshopify.com",
      summaryNoticePendingAt: null,
      summaryNoticeShownAt: null,
      summaryOptedInAt: null,
      summaryOptInDeclinedAt: null,
    });
    expect(call.data.summaryNoticePendingAt).toBeInstanceOf(Date);
  });

  it("markSummaryNoticePending respects a No thanks (gc-xorg): declined, dropped to Free, upgraded again -> no notice owed", async () => {
    const row = installFakeShopRow(
      { updateMany: mockDb.shop.updateMany },
      {
        domain: "a.myshopify.com",
        summaryNoticePendingAt: null,
        summaryNoticeShownAt: null,
        summaryOptedInAt: null,
        summaryOptInDeclinedAt: new Date("2026-10-01T00:00:00Z"),
      },
    );
    await expect(markSummaryNoticePending("a.myshopify.com")).resolves.toBe(false);
    expect(row.summaryNoticePendingAt).toBeNull();

    // Control: the same shop without the decline IS owed the notice.
    row.summaryOptInDeclinedAt = null;
    await expect(markSummaryNoticePending("a.myshopify.com")).resolves.toBe(true);
    expect(row.summaryNoticePendingAt).toBeInstanceOf(Date);
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

describe("declineSummaryOptIn (gc-xorg)", () => {
  it("stamps summaryOptInDeclinedAt once, keyed on the domain and the column IS NULL", async () => {
    mockDb.shop.updateMany.mockResolvedValue({ count: 1 });
    await expect(declineSummaryOptIn("a.myshopify.com")).resolves.toBe(true);
    expect(mockDb.shop.updateMany).toHaveBeenCalledTimes(1);
    const call = mockDb.shop.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ domain: "a.myshopify.com", summaryOptInDeclinedAt: null });
    // Only the decline stamp: alertsEnabled and the consent stamps are untouched.
    expect(Object.keys(call.data)).toEqual(["summaryOptInDeclinedAt"]);
    expect(call.data.summaryOptInDeclinedAt).toBeInstanceOf(Date);
  });

  it("a repeat (already stamped) matches no row: false, the first answer is kept", async () => {
    mockDb.shop.updateMany.mockResolvedValue({ count: 0 });
    await expect(declineSummaryOptIn("a.myshopify.com")).resolves.toBe(false);
  });

  it("concurrent declines: exactly one stamps (real compare-and-set on one row)", async () => {
    const row = installFakeShopRow(
      { updateMany: mockDb.shop.updateMany },
      { domain: "a.myshopify.com", summaryOptInDeclinedAt: null, alertsEnabled: true },
    );
    const results = await Promise.all([
      declineSummaryOptIn("a.myshopify.com"),
      declineSummaryOptIn("a.myshopify.com"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const first = row.summaryOptInDeclinedAt;
    expect(first).toBeInstanceOf(Date);
    await expect(declineSummaryOptIn("a.myshopify.com")).resolves.toBe(false);
    expect(row.summaryOptInDeclinedAt).toBe(first);
    expect(row.alertsEnabled).toBe(true);
  });

  it("another shop's domain never matches", async () => {
    installFakeShopRow(
      { updateMany: mockDb.shop.updateMany },
      { domain: "a.myshopify.com", summaryOptInDeclinedAt: null },
    );
    await expect(declineSummaryOptIn("b.myshopify.com")).resolves.toBe(false);
  });
});

describe("claimSummaryOptInFirstShown (gc-rxq0)", () => {
  it("stamps summaryOptInFirstShownAt only, keyed on the domain and the column IS NULL", async () => {
    mockDb.shop.updateMany.mockResolvedValue({ count: 1 });
    await expect(claimSummaryOptInFirstShown("a.myshopify.com")).resolves.toBe(true);
    expect(mockDb.shop.updateMany).toHaveBeenCalledTimes(1);
    const call = mockDb.shop.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ domain: "a.myshopify.com", summaryOptInFirstShownAt: null });
    expect(Object.keys(call.data)).toEqual(["summaryOptInFirstShownAt"]);
    expect(call.data.summaryOptInFirstShownAt).toBeInstanceOf(Date);
  });

  it("never overwrites: a later or concurrent claim keeps the first stamp", async () => {
    const row = installFakeShopRow(
      { updateMany: mockDb.shop.updateMany },
      { domain: "a.myshopify.com", summaryOptInFirstShownAt: null, alertsEnabled: true },
    );
    const results = await Promise.all([
      claimSummaryOptInFirstShown("a.myshopify.com"),
      claimSummaryOptInFirstShown("a.myshopify.com"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const first = row.summaryOptInFirstShownAt;
    expect(first).toBeInstanceOf(Date);
    await expect(claimSummaryOptInFirstShown("a.myshopify.com")).resolves.toBe(false);
    expect(row.summaryOptInFirstShownAt).toBe(first);
    expect(row.alertsEnabled).toBe(true);
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

describe("checkout guard email helpers (gc-1q1s.7)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("claimGuardEmailNoticeShown stamps once, never after Turn off", async () => {
    mockDb.shop.updateMany.mockResolvedValue({ count: 1 });
    await expect(claimGuardEmailNoticeShown("a.myshopify.com", "h1")).resolves.toBe(true);
    const { where, data } = mockDb.shop.updateMany.mock.calls[0][0];
    expect(where).toEqual({
      domain: "a.myshopify.com",
      guardEmailNoticeShownAt: null,
      guardEmailOffAt: null,
    });
    // The consented address's hash is stamped with the consent (audit fix).
    expect(data).toEqual({
      guardEmailNoticeShownAt: expect.any(Date),
      guardEmailConsentHash: "h1",
    });
    mockDb.shop.updateMany.mockResolvedValue({ count: 0 });
    await expect(claimGuardEmailNoticeShown("a.myshopify.com", null)).resolves.toBe(false);
  });

  it("resetGuardEmailNotice clears the consent so Home asks again, unless turned off", async () => {
    mockDb.shop.updateMany.mockResolvedValue({ count: 1 });
    await resetGuardEmailNotice("shop-1");
    expect(mockDb.shop.updateMany).toHaveBeenCalledWith({
      where: { id: "shop-1", guardEmailOffAt: null },
      data: { guardEmailNoticeShownAt: null, guardEmailConsentHash: null },
    });
  });

  it("turnOffGuardEmail stamps only an unset column (first answer kept)", async () => {
    mockDb.shop.updateMany.mockResolvedValue({ count: 1 });
    await turnOffGuardEmail("shop-1");
    expect(mockDb.shop.updateMany).toHaveBeenCalledWith({
      where: { id: "shop-1", guardEmailOffAt: null },
      data: { guardEmailOffAt: expect.any(Date) },
    });
  });

  it("enableGuardEmail stamps consent with the hash and clears Turn off, only when not already on", async () => {
    mockDb.shop.updateMany.mockResolvedValue({ count: 1 });
    await expect(enableGuardEmail("shop-1", "hash-1")).resolves.toBe(true);
    expect(mockDb.shop.updateMany).toHaveBeenCalledWith({
      where: {
        id: "shop-1",
        OR: [{ guardEmailOffAt: { not: null } }, { guardEmailNoticeShownAt: null }],
      },
      data: {
        guardEmailOffAt: null,
        guardEmailNoticeShownAt: expect.any(Date),
        guardEmailConsentHash: "hash-1",
      },
    });
    mockDb.shop.updateMany.mockResolvedValue({ count: 0 });
    await expect(enableGuardEmail("shop-1", null)).resolves.toBe(false);
  });

  it("enableGuardEmail on a shop already on re-stamps a stale hash to the address shown (wave 3 U5)", async () => {
    mockDb.shop.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    await expect(enableGuardEmail("shop-1", "hash-new")).resolves.toBe(false);
    expect(mockDb.shop.updateMany).toHaveBeenLastCalledWith({
      where: { id: "shop-1", guardEmailOffAt: null, guardEmailNoticeShownAt: { not: null } },
      data: { guardEmailConsentHash: "hash-new" },
    });
  });

  it("countGuardAlertsSince counts only guard emails for the shop", async () => {
    mockDb.merchantAlert.count.mockResolvedValue(2);
    const since = new Date("2026-10-26T00:00:00Z");
    await expect(countGuardAlertsSince("shop-1", since)).resolves.toBe(2);
    expect(mockDb.merchantAlert.count).toHaveBeenCalledWith({
      where: { shopId: "shop-1", kind: "checkout_guard", sentAt: { gte: since } },
    });
  });
});

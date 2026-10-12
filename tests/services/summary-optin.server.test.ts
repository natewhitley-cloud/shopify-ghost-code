/**
 * Tests for app/services/summary-optin.server.ts (gc-xorg) with the REAL
 * models (setSummaryEmailsEnabled, declineSummaryOptIn / claimShopStamp)
 * against one in-memory Shop row behind a mocked Prisma client, so what an
 * answer writes is what the summary sender's consent gate
 * (summaryShopSkipReason) then reads.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = vi.hoisted(() => ({
  shop: { update: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() },
}));
vi.mock("../../app/db.server", () => ({ default: mockDb }));

const mockConfigStatus = vi.hoisted(() => vi.fn());
vi.mock("../../app/services/merchant-alert.server", () => ({
  getMerchantAlertConfigStatus: mockConfigStatus,
}));

vi.mock("../../app/services/shop-alert-email.server", () => ({
  refreshShopAlertEmail: vi.fn(),
}));

vi.mock("../../app/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from "../../app/lib/logger.server";
import { SUMMARY_OPTIN_OFFER_MS } from "../../app/lib/summary-optin";
import { setSummaryEmailsEnabled } from "../../app/models/merchant-alert.server";
import type { ShopMetadata } from "../../app/models/shop.server";
import { refreshShopAlertEmail } from "../../app/services/shop-alert-email.server";
import { summaryShopSkipReason } from "../../app/services/summary-email.server";
import {
  acceptSummaryOptIn,
  declineSummaryOptInForHome,
  summaryOptInForHome,
} from "../../app/services/summary-optin.server";
import type { AdminApiContext } from "../../app/types/shopify";
import { installFakeShopRow } from "../mocks/fake-shop-row";
import type { FakeRow } from "../mocks/fake-shop-row";

const DOMAIN = "legacy.myshopify.com";
const ADMIN = { graphql: vi.fn() } as unknown as AdminApiContext;

/** A legacy paid shop as stored: toggle at its default ON, no consent stamp. */
const LEGACY = {
  id: "shop-1",
  domain: DOMAIN,
  plan: "Professional",
  alertsEnabled: true,
  alertEmail: "owner@example.com" as string | null,
  storeName: "Legacy Store",
  uninstalledAt: null as Date | null,
  summaryNoticePendingAt: null as Date | null,
  summaryNoticeShownAt: null as Date | null,
  summaryOptedInAt: null as Date | null,
  summaryOptInDeclinedAt: null as Date | null,
  summaryOptInFirstShownAt: null as Date | null,
};

const NOW = new Date("2026-10-11T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

let row: FakeRow;

/** The stored row, typed for the service and the sender gate. */
const stored = () => ({ ...row }) as unknown as typeof LEGACY & ShopMetadata;

beforeEach(() => {
  vi.resetAllMocks();
  mockConfigStatus.mockReturnValue({ configured: true });
  row = installFakeShopRow(mockDb.shop, { ...LEGACY });
  // setSummaryEmailsEnabled writes with update (by id): apply it to the same row.
  mockDb.shop.update.mockImplementation(async ({ where, data }) => {
    if (where.id === row.id) Object.assign(row, data);
    return { ...row };
  });
});

describe("acceptSummaryOptIn", () => {
  it("before: a legacy shop gets no summary (no consent)", () => {
    expect(summaryShopSkipReason(stored())).toBe("no_consent");
  });

  it("Turn on: alertsEnabled + summaryOptedInAt via the Settings path -> eligible for the next summary", async () => {
    await expect(acceptSummaryOptIn(stored(), NOW)).resolves.toBe(true);

    expect(mockDb.shop.update).toHaveBeenCalledTimes(1);
    expect(mockDb.shop.update.mock.calls[0][0].where).toEqual({ id: "shop-1" });
    expect(row.alertsEnabled).toBe(true);
    expect(row.summaryOptedInAt).toBeInstanceOf(Date);
    expect(row.summaryNoticePendingAt).toBeNull();
    expect(summaryShopSkipReason(stored())).toBeNull();
    expect(logger.info).toHaveBeenCalledWith("summary_optin_accepted", { shop: DOMAIN });
  });

  it("idempotent: a second accept writes nothing and keeps the first consent time", async () => {
    await acceptSummaryOptIn(stored(), NOW);
    const first = row.summaryOptedInAt;
    await expect(acceptSummaryOptIn(stored(), NOW)).resolves.toBe(true);
    expect(mockDb.shop.update).toHaveBeenCalledTimes(1);
    expect(row.summaryOptedInAt).toBe(first);
    expect(
      vi.mocked(logger.info).mock.calls.filter(([e]) => e === "summary_optin_accepted"),
    ).toHaveLength(1);
  });

  it("alerts turned off / unsubscribed: ignored, nothing written (a stale tab never undoes it)", async () => {
    row.alertsEnabled = false;
    await expect(acceptSummaryOptIn(stored(), NOW)).resolves.toBe(false);
    expect(mockDb.shop.update).not.toHaveBeenCalled();
    expect(row.alertsEnabled).toBe(false);
    expect(row.summaryOptedInAt).toBeNull();
    expect(summaryShopSkipReason(stored())).toBe("shop_opted_out");
  });

  it.each<[string, Partial<typeof LEGACY>]>([
    ["Free plan", { plan: "free" }],
    ["declined (No thanks)", { summaryOptInDeclinedAt: new Date("2026-10-01T00:00:00Z") }],
    [
      "the Free -> paid notice is pending",
      { summaryNoticePendingAt: new Date("2026-10-01T00:00:00Z") },
    ],
    [
      "the notice was shown (never offered the prompt)",
      { summaryNoticeShownAt: new Date("2026-10-01T00:00:00Z") },
    ],
    ["uninstalled", { uninstalledAt: new Date("2026-10-01T00:00:00Z") }],
  ])("ineligible (%s): false, nothing written", async (_l, shop) => {
    Object.assign(row, shop);
    const before = { ...row };
    await expect(acceptSummaryOptIn(stored(), NOW)).resolves.toBe(false);
    expect(mockDb.shop.update).not.toHaveBeenCalled();
    expect(mockDb.shop.updateMany).not.toHaveBeenCalled();
    expect(row).toEqual(before);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("offer retired (first shown 14 days ago, gc-rxq0): a stale-tab Turn on is ignored, nothing written", async () => {
    row.summaryOptInFirstShownAt = new Date(NOW.getTime() - SUMMARY_OPTIN_OFFER_MS);
    const before = { ...row };
    await expect(acceptSummaryOptIn(stored(), NOW)).resolves.toBe(false);
    expect(mockDb.shop.update).not.toHaveBeenCalled();
    expect(mockDb.shop.updateMany).not.toHaveBeenCalled();
    expect(row).toEqual(before);
    expect(summaryShopSkipReason(stored())).toBe("no_consent");
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("offer still open (first shown 14 days minus 1 ms ago): Turn on works", async () => {
    row.summaryOptInFirstShownAt = new Date(NOW.getTime() - SUMMARY_OPTIN_OFFER_MS + 1);
    await expect(acceptSummaryOptIn(stored(), NOW)).resolves.toBe(true);
    expect(row.summaryOptedInAt).toBeInstanceOf(Date);
  });

  it("sending not configured (never the dark 'we'll tell you first' case): false, nothing written", async () => {
    mockConfigStatus.mockReturnValue({ configured: false, reason: "disabled" });
    await expect(acceptSummaryOptIn(stored(), NOW)).resolves.toBe(false);
    expect(mockDb.shop.update).not.toHaveBeenCalled();
    expect(row.summaryOptedInAt).toBeNull();
  });

  it("already consented: true with no write, whatever else the row says", async () => {
    Object.assign(row, {
      summaryOptedInAt: new Date("2026-10-01T00:00:00Z"),
      summaryOptInDeclinedAt: new Date("2026-09-01T00:00:00Z"),
    });
    mockConfigStatus.mockReturnValue({ configured: false, reason: "disabled" });
    await expect(acceptSummaryOptIn(stored(), NOW)).resolves.toBe(true);
    expect(mockDb.shop.update).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });
});

describe("declineSummaryOptInForHome", () => {
  it("No thanks: stamps the decline only; still no summary; alertsEnabled untouched", async () => {
    await declineSummaryOptInForHome(DOMAIN);

    expect(row.summaryOptInDeclinedAt).toBeInstanceOf(Date);
    expect(row.alertsEnabled).toBe(true);
    expect(row.summaryOptedInAt).toBeNull();
    expect(mockDb.shop.update).not.toHaveBeenCalled();
    expect(summaryShopSkipReason(stored())).toBe("no_consent");
    expect(logger.info).toHaveBeenCalledWith("summary_optin_declined", { shop: DOMAIN });
  });

  it("idempotent: the first answer is kept and logged once", async () => {
    await declineSummaryOptInForHome(DOMAIN);
    const first = row.summaryOptInDeclinedAt;
    await declineSummaryOptInForHome(DOMAIN);
    expect(row.summaryOptInDeclinedAt).toBe(first);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it("after a decline, Turn on from a stale tab is ignored; the Settings toggle still works", async () => {
    await declineSummaryOptInForHome(DOMAIN);
    await expect(acceptSummaryOptIn(stored(), NOW)).resolves.toBe(false);
    expect(summaryShopSkipReason(stored())).toBe("no_consent");

    // Settings (sending live) is the way back in, and it is consent.
    await setSummaryEmailsEnabled(row.id as string, true, {
      sendingLive: true,
      noticeShown: false,
    });
    expect(summaryShopSkipReason(stored())).toBeNull();
  });
});

describe("summaryOptInForHome", () => {
  it("names the cached owner email and the plan cadence; logs shown on a new window only", async () => {
    await expect(summaryOptInForHome(stored(), ADMIN, true)).resolves.toEqual({
      email: "owner@example.com",
      cadence: "weekly",
    });
    expect(logger.info).toHaveBeenCalledExactlyOnceWith("summary_optin_shown", { shop: DOMAIN });
    expect(refreshShopAlertEmail).not.toHaveBeenCalled();

    await summaryOptInForHome({ ...stored(), plan: "Standard" }, ADMIN, false);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it("Standard: monthly", async () => {
    await expect(
      summaryOptInForHome({ ...stored(), plan: "Standard" }, ADMIN, true),
    ).resolves.toEqual({ email: "owner@example.com", cadence: "monthly" });
  });

  it("no cached email: reads it (and caches it) only on a new window", async () => {
    vi.mocked(refreshShopAlertEmail).mockResolvedValue("fresh@example.com");
    const noEmail = { ...stored(), alertEmail: null };

    await expect(summaryOptInForHome(noEmail, ADMIN, true)).resolves.toEqual({
      email: "fresh@example.com",
      cadence: "weekly",
    });
    expect(refreshShopAlertEmail).toHaveBeenCalledExactlyOnceWith(DOMAIN, ADMIN);

    await expect(summaryOptInForHome(noEmail, ADMIN, false)).resolves.toEqual({
      email: null,
      cadence: "weekly",
    });
    expect(refreshShopAlertEmail).toHaveBeenCalledTimes(1);
  });

  it("no admin context: null email, no read", async () => {
    await expect(
      summaryOptInForHome({ ...stored(), alertEmail: null }, null, true),
    ).resolves.toEqual({ email: null, cadence: "weekly" });
    expect(refreshShopAlertEmail).not.toHaveBeenCalled();
  });

  it("first render stamps summaryOptInFirstShownAt once; a later render never overwrites it (gc-rxq0)", async () => {
    await summaryOptInForHome(stored(), ADMIN, true);
    const first = row.summaryOptInFirstShownAt;
    expect(first).toBeInstanceOf(Date);
    expect(mockDb.shop.updateMany).toHaveBeenCalledTimes(1);
    expect(mockDb.shop.updateMany.mock.calls[0][0].where).toEqual({
      domain: DOMAIN,
      summaryOptInFirstShownAt: null,
    });

    // The next load reads the stamped row: the pre-check skips the write.
    await summaryOptInForHome(stored(), ADMIN, true);
    expect(mockDb.shop.updateMany).toHaveBeenCalledTimes(1);
    expect(row.summaryOptInFirstShownAt).toBe(first);

    // A stale row (read before the stamp landed) loses the conditional write.
    await summaryOptInForHome({ ...stored(), summaryOptInFirstShownAt: null }, ADMIN, false);
    expect(mockDb.shop.updateMany).toHaveBeenCalledTimes(2);
    expect(row.summaryOptInFirstShownAt).toBe(first);
  });

  it("stamps on a re-render inside the window too (a shop mid-window when this shipped)", async () => {
    await summaryOptInForHome(stored(), ADMIN, false);
    expect(row.summaryOptInFirstShownAt).toBeInstanceOf(Date);
  });

  it("the stamp touches nothing else: no decline, alertsEnabled and consent untouched", async () => {
    await summaryOptInForHome(stored(), ADMIN, true);
    expect(row.summaryOptInDeclinedAt).toBeNull();
    expect(row.alertsEnabled).toBe(true);
    expect(row.summaryOptedInAt).toBeNull();
    expect(Object.keys(mockDb.shop.updateMany.mock.calls[0][0].data)).toEqual([
      "summaryOptInFirstShownAt",
    ]);
  });

  it("a failed stamp is logged and never breaks Home", async () => {
    mockDb.shop.updateMany.mockRejectedValueOnce(new Error("db down"));
    await expect(summaryOptInForHome(stored(), ADMIN, true)).resolves.toEqual({
      email: "owner@example.com",
      cadence: "weekly",
    });
    expect(logger.error).toHaveBeenCalledWith("summary_optin_first_shown_stamp_failed", {
      shop: DOMAIN,
      error: "db down",
    });
  });

  it("a stamp 14+ days old is kept as is (retirement writes nothing)", async () => {
    const old = new Date(NOW.getTime() - 20 * DAY);
    row.summaryOptInFirstShownAt = old;
    await summaryOptInForHome(stored(), ADMIN, true);
    expect(mockDb.shop.updateMany).not.toHaveBeenCalled();
    expect(row.summaryOptInFirstShownAt).toBe(old);
  });

  it("a Free plan (unreachable via the cap): null, nothing logged", async () => {
    await expect(summaryOptInForHome({ ...stored(), plan: "free" }, ADMIN, true)).resolves.toBe(
      null,
    );
    expect(logger.info).not.toHaveBeenCalled();
  });
});

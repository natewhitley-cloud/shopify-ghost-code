/**
 * Checkout guard incident email + consent notice (gc-1q1s.7): every gate
 * (flags, transport, plan, consent, turn-off, unsubscribe, throttle), one
 * email per episode, batching, ledger, and the copy rules.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const alerts = vi.hoisted(() => ({
  getMerchantAlertConfigStatus: vi.fn(),
  sendMerchantAlert: vi.fn(),
}));
const ledger = vi.hoisted(() => ({
  claimGuardEmailNoticeShown: vi.fn(),
  countGuardAlertsSince: vi.fn(),
  ensureUnsubscribeToken: vi.fn(),
  recordMerchantAlert: vi.fn(),
}));
const guardModel = vi.hoisted(() => ({
  loadIncidentsToEmail: vi.fn(),
  markIncidentsEmailed: vi.fn(),
}));
const contact = vi.hoisted(() => ({
  refreshShopAlertEmail: vi.fn(),
  refreshShopContact: vi.fn(),
}));

vi.mock("../../app/services/merchant-alert.server", async (orig) => ({
  ...(await orig<typeof import("../../app/services/merchant-alert.server")>()),
  ...alerts,
}));
vi.mock("../../app/models/merchant-alert.server", async (orig) => ({
  ...(await orig<typeof import("../../app/models/merchant-alert.server")>()),
  ...ledger,
}));
vi.mock("../../app/models/storefront-guard.server", () => guardModel);
vi.mock("../../app/services/shop-alert-email.server", () => contact);
vi.mock("../../app/db.server", () => ({ default: {} }));
vi.mock("../../app/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { guardNoticeLead } from "../../app/lib/storefront-guard-copy";
import type { GuardIncident } from "../../app/lib/storefront-guard-state";
import {
  buildGuardEmailHtml,
  buildGuardEmailSubject,
  buildGuardEmailText,
  GUARD_EMAILS_PER_DAY,
  guardEmailShopSkipReason,
  guardLedgerKey,
  sendGuardIncidentEmail,
  type GuardEmailShop,
} from "../../app/services/storefront-guard-email.server";
import { toIncidentView } from "../../app/services/storefront-guard-home.server";
import { claimGuardEmailNoticeForHome } from "../../app/services/storefront-guard-notice.server";
import type { AdminApiContext } from "../../app/types/shopify";

const NOW = new Date("2026-10-27T05:17:30Z");
const OPENED = new Date("2026-10-27T05:17:10Z");

const SHOP: GuardEmailShop = {
  id: "shop-1",
  domain: "paw-naturals.myshopify.com",
  plan: "Standard",
  alertsEnabled: true,
  alertEmail: "owner@example.com",
  storeName: "Paw Naturals",
  uninstalledAt: null,
  guardEmailNoticeShownAt: new Date("2026-10-20T00:00:00Z"),
  guardEmailOffAt: null,
};

function incident(
  over: Partial<GuardIncident> = {},
): GuardIncident & { id: string; openedAt: Date } {
  return {
    id: "inc-1",
    kind: "KNOWN_MALICIOUS",
    fingerprint: "KNOWN_MALICIOUS:cartassure.top",
    host: "cartassure.top",
    page: "both",
    sourceLabel: "Named in JavaScript attached to an element in the page",
    state: "open",
    openedAt: OPENED,
    firstSeenAt: OPENED,
    lastSeenAt: OPENED,
    seenCount: 1,
    cleanStreak: 0,
    resolvedAt: null,
    resolution: null,
    acknowledgedAt: null,
    emailedOpenedAt: null,
    ...over,
  } as GuardIncident & { id: string; openedAt: Date };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STOREFRONT_GUARD_LIVE_ENABLED = "true";
  process.env.STOREFRONT_GUARD_EMAIL_ENABLED = "true";
  process.env.SHOPIFY_APP_URL = "https://app.example.com/";
  alerts.getMerchantAlertConfigStatus.mockReturnValue({ configured: true });
  alerts.sendMerchantAlert.mockResolvedValue({ sent: true, reason: "sent" });
  ledger.claimGuardEmailNoticeShown.mockResolvedValue(true);
  ledger.countGuardAlertsSince.mockResolvedValue(0);
  ledger.ensureUnsubscribeToken.mockResolvedValue("tok");
  ledger.recordMerchantAlert.mockResolvedValue({});
  guardModel.loadIncidentsToEmail.mockResolvedValue([incident()]);
  contact.refreshShopContact.mockResolvedValue({ email: null, storeName: null });
  contact.refreshShopAlertEmail.mockResolvedValue(null);
});
afterEach(() => {
  delete process.env.STOREFRONT_GUARD_LIVE_ENABLED;
  delete process.env.STOREFRONT_GUARD_EMAIL_ENABLED;
  delete process.env.SHOPIFY_APP_URL;
});

describe("claimGuardEmailNoticeForHome", () => {
  const noticeShop = { ...SHOP, guardEmailNoticeShownAt: null };

  it("claims once and names the owner email (Standard and Professional)", async () => {
    for (const plan of ["Standard", "Professional"]) {
      expect(await claimGuardEmailNoticeForHome({ ...noticeShop, plan }, null)).toEqual({
        email: "owner@example.com",
      });
    }
    expect(ledger.claimGuardEmailNoticeShown).toHaveBeenCalledWith(SHOP.domain);
  });

  it.each([
    ["Free", { plan: "free" }],
    ["already shown", { guardEmailNoticeShownAt: NOW }],
    ["turned off", { guardEmailOffAt: NOW }],
    ["unsubscribed", { alertsEnabled: false }],
  ])("is never shown (and never claimed) when %s", async (_label, over) => {
    expect(await claimGuardEmailNoticeForHome({ ...noticeShop, ...over }, null)).toBeNull();
    expect(ledger.claimGuardEmailNoticeShown).not.toHaveBeenCalled();
  });

  it("is not shown while the email flag or the transport is off", async () => {
    delete process.env.STOREFRONT_GUARD_EMAIL_ENABLED;
    expect(await claimGuardEmailNoticeForHome(noticeShop, null)).toBeNull();
    process.env.STOREFRONT_GUARD_EMAIL_ENABLED = "true";
    delete process.env.STOREFRONT_GUARD_LIVE_ENABLED;
    expect(await claimGuardEmailNoticeForHome(noticeShop, null)).toBeNull();
    process.env.STOREFRONT_GUARD_LIVE_ENABLED = "true";
    alerts.getMerchantAlertConfigStatus.mockReturnValue({ configured: false, reason: "disabled" });
    expect(await claimGuardEmailNoticeForHome(noticeShop, null)).toBeNull();
    expect(ledger.claimGuardEmailNoticeShown).not.toHaveBeenCalled();
  });

  it("a lost or failed claim shows nothing", async () => {
    ledger.claimGuardEmailNoticeShown.mockResolvedValueOnce(false);
    expect(await claimGuardEmailNoticeForHome(noticeShop, null)).toBeNull();
    ledger.claimGuardEmailNoticeShown.mockRejectedValueOnce(new Error("db"));
    expect(await claimGuardEmailNoticeForHome(noticeShop, null)).toBeNull();
  });

  it("reads the owner email when none is cached; generic copy when unknown", async () => {
    contact.refreshShopAlertEmail.mockResolvedValue("fresh@example.com");
    expect(
      await claimGuardEmailNoticeForHome(
        { ...noticeShop, alertEmail: null },
        {} as AdminApiContext,
      ),
    ).toEqual({ email: "fresh@example.com" });
    expect(guardNoticeLead(null)).toContain("your store's owner email address");
    expect(guardNoticeLead("a@b.co")).toMatch(
      /^Checkout guard alerts will be emailed to a@b\.co\./,
    );
  });
});

describe("guardEmailShopSkipReason", () => {
  it.each([
    ["shop_uninstalled", { uninstalledAt: NOW }],
    ["plan_not_eligible", { plan: "free" }],
    ["shop_opted_out", { alertsEnabled: false }],
    ["guard_email_off", { guardEmailOffAt: NOW }],
    ["no_consent", { guardEmailNoticeShownAt: null }],
  ])("%s", (reason, over) => {
    expect(guardEmailShopSkipReason({ ...SHOP, ...over })).toBe(reason);
  });
  it("null when every gate passes", () => {
    expect(guardEmailShopSkipReason(SHOP)).toBeNull();
  });
});

describe("sendGuardIncidentEmail", () => {
  const send = (over: Partial<GuardEmailShop> = {}, ids = ["inc-1"]) =>
    sendGuardIncidentEmail({ shop: { ...SHOP, ...over }, incidentIds: ids, admin: null, now: NOW });

  it("sends one email, records the ledger row and stamps the episode", async () => {
    expect(await send()).toEqual({ sent: true, reason: "sent", count: 1 });
    const mail = alerts.sendMerchantAlert.mock.calls[0][0];
    expect(mail.to).toBe("owner@example.com");
    expect(mail.subject).toBe("GhostCode checkout guard alert for Paw Naturals");
    expect(mail.idempotencyKey).toBe(`checkout-guard:${guardLedgerKey([incident()])}`);
    expect(mail.unsubscribeUrl).toBe("https://app.example.com/unsubscribe/tok");
    expect(ledger.recordMerchantAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        shopId: "shop-1",
        kind: "checkout_guard",
        scanId: guardLedgerKey([incident()]),
        newCount: 1,
        recipient: "owner@example.com",
      }),
    );
    expect(guardModel.markIncidentsEmailed).toHaveBeenCalledWith([incident()]);
  });

  it("batches every incident of the run into one email", async () => {
    guardModel.loadIncidentsToEmail.mockResolvedValue([
      incident(),
      incident({
        id: "inc-2",
        kind: "SCRIPT_LOADER",
        fingerprint: "SCRIPT_LOADER:pay.example",
        host: "pay.example",
        page: "cart",
      }),
    ]);
    expect(await send({}, ["inc-1", "inc-2"])).toMatchObject({ sent: true, count: 2 });
    expect(alerts.sendMerchantAlert).toHaveBeenCalledTimes(1);
    expect(alerts.sendMerchantAlert.mock.calls[0][0].text).toContain("pay.example");
  });

  it.each([
    ["dark", () => delete process.env.STOREFRONT_GUARD_EMAIL_ENABLED],
    [
      "disabled",
      () =>
        alerts.getMerchantAlertConfigStatus.mockReturnValue({
          configured: false,
          reason: "disabled",
        }),
    ],
    ["nothing_to_send", () => guardModel.loadIncidentsToEmail.mockResolvedValue([])],
    ["throttled", () => ledger.countGuardAlertsSince.mockResolvedValue(GUARD_EMAILS_PER_DAY)],
    ["no_unsubscribe_token", () => ledger.ensureUnsubscribeToken.mockResolvedValue(null)],
    ["no_app_url", () => delete process.env.SHOPIFY_APP_URL],
  ])("skips: %s (nothing sent, nothing stamped)", async (reason, arrange) => {
    arrange();
    expect(await send()).toEqual({ sent: false, reason });
    expect(alerts.sendMerchantAlert).not.toHaveBeenCalled();
    expect(guardModel.markIncidentsEmailed).not.toHaveBeenCalled();
  });

  it("never emails Free, an unconsented, turned-off or unsubscribed shop", async () => {
    for (const over of [
      { plan: "free" },
      { guardEmailNoticeShownAt: null },
      { guardEmailOffAt: NOW },
      { alertsEnabled: false },
    ]) {
      expect((await send(over)).sent).toBe(false);
    }
    expect(guardModel.loadIncidentsToEmail).not.toHaveBeenCalled();
    expect(alerts.sendMerchantAlert).not.toHaveBeenCalled();
  });

  it("throttle counts guard emails in the last 24 hours", async () => {
    await send();
    expect(ledger.countGuardAlertsSince).toHaveBeenCalledWith(
      "shop-1",
      new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
    );
  });

  it("no recipient: skips", async () => {
    expect(await send({ alertEmail: null })).toEqual({ sent: false, reason: "no_recipient" });
  });

  it("a failed send records nothing and stamps nothing (a later run may retry)", async () => {
    alerts.sendMerchantAlert.mockResolvedValue({ sent: false, reason: "http_error" });
    expect(await send()).toEqual({ sent: false, reason: "send_failed" });
    expect(ledger.recordMerchantAlert).not.toHaveBeenCalled();
    expect(guardModel.markIncidentsEmailed).not.toHaveBeenCalled();
  });

  it("an existing ledger row (retry) still counts as sent once", async () => {
    ledger.recordMerchantAlert.mockRejectedValue(
      Object.assign(new Error("dup"), { code: "P2002" }),
    );
    expect(await send()).toMatchObject({ sent: true, reason: "sent" });
  });

  it("a ledger failure after sending is reported, and the episode is still stamped", async () => {
    ledger.recordMerchantAlert.mockRejectedValue(new Error("db"));
    expect(await send()).toMatchObject({ sent: true, reason: "sent_not_recorded" });
    expect(guardModel.markIncidentsEmailed).toHaveBeenCalled();
  });

  it("never throws", async () => {
    guardModel.loadIncidentsToEmail.mockRejectedValue(new Error("db down"));
    expect(await send()).toEqual({ sent: false, reason: "exception" });
  });
});

describe("guardLedgerKey", () => {
  it("is stable and independent of order", () => {
    const a = incident();
    const b = incident({ id: "inc-2" });
    expect(guardLedgerKey([a, b])).toBe(guardLedgerKey([b, a]));
    expect(guardLedgerKey([a])).not.toBe(guardLedgerKey([a, b]));
    expect(guardLedgerKey([a])).toMatch(/^guard:/);
  });
  it("a new episode of the same incident is a new key", () => {
    expect(guardLedgerKey([incident()])).not.toBe(
      guardLedgerKey([incident({ openedAt: new Date("2026-11-10T00:00:00Z") })]),
    );
  });
});

describe("email copy", () => {
  const body = {
    storeName: "Paw <Naturals>",
    shopDomain: SHOP.domain,
    incidents: [toIncidentView(incident())],
    homeUrl: "https://admin.shopify.com/store/paw-naturals/apps/ghost-code/app",
    unsubscribeUrl: "https://app.example.com/unsubscribe#t=tok",
  };

  it("text: facts, steps, links, footer; no dashes, never hijacked", () => {
    const text = buildGuardEmailText(body);
    expect(text).toContain("Your live store loads code from cartassure.top");
    expect(text).toContain("Seen on your homepage and cart page");
    expect(text).toContain("Shopify may block shoppers");
    expect(text).toContain("What to check:");
    expect(text).toContain("shopify-app-compromised-checklist");
    expect(text).toContain("Unsubscribe: https://app.example.com/unsubscribe#t=tok");
    expect(text).not.toMatch(/[—–]/);
    expect(text).not.toMatch(/hijack/i);
  });

  it("html escapes every value", () => {
    const html = buildGuardEmailHtml(body);
    expect(html).toContain("Paw &lt;Naturals&gt;");
    expect(html).not.toContain("Paw <Naturals>");
  });

  it("subject falls back to the domain", () => {
    expect(buildGuardEmailSubject(null, SHOP.domain)).toBe(
      `GhostCode checkout guard alert for ${SHOP.domain}`,
    );
  });
});

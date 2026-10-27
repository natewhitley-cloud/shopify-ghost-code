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
  hasGuardAlert: vi.fn(),
  resetGuardEmailNotice: vi.fn(),
  emailedGuardIncidentKeys: vi.fn(),
  recordGuardIncidentsEmailed: vi.fn(),
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
const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../../app/lib/logger.server", () => ({ logger }));

import { guardNoticeLead } from "../../app/lib/storefront-guard-copy";
import type { GuardIncident } from "../../app/lib/storefront-guard-state";
import { guardIncidentLedgerKey } from "../../app/models/merchant-alert.server";
import {
  buildGuardEmailHtml,
  buildGuardEmailSubject,
  buildGuardEmailText,
  GUARD_EMAILS_PER_DAY,
  guardEmailShopSkipReason,
  MAX_EMAIL_INCIDENTS,
  guardLedgerKey,
  sendGuardIncidentEmail,
  type GuardEmailShop,
} from "../../app/services/storefront-guard-email.server";
import { toIncidentView } from "../../app/services/storefront-guard-home.server";
import {
  claimGuardEmailNoticeRendered,
  guardConsentHash,
  guardEmailNoticeForHome,
} from "../../app/services/storefront-guard-notice.server";
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
  guardEmailConsentHash: guardConsentHash("owner@example.com"),
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
  ledger.hasGuardAlert.mockResolvedValue(false);
  ledger.emailedGuardIncidentKeys.mockResolvedValue(new Set());
  ledger.recordGuardIncidentsEmailed.mockResolvedValue(undefined);
  guardModel.loadIncidentsToEmail.mockResolvedValue([incident()]);
  contact.refreshShopContact.mockResolvedValue({ email: null, storeName: null });
  contact.refreshShopAlertEmail.mockResolvedValue(null);
});
afterEach(() => {
  delete process.env.STOREFRONT_GUARD_LIVE_ENABLED;
  delete process.env.STOREFRONT_GUARD_EMAIL_ENABLED;
  delete process.env.SHOPIFY_APP_URL;
});

describe("guard email notice: offered by the loader, claimed after render (gc-1q1s.11)", () => {
  const noticeShop = { ...SHOP, guardEmailNoticeShownAt: null, guardEmailConsentHash: null };

  it("the loader offers it naming the owner email and writes nothing (Standard and Professional)", async () => {
    for (const plan of ["Standard", "Professional"]) {
      expect(await guardEmailNoticeForHome({ ...noticeShop, plan }, null)).toEqual({
        email: "owner@example.com",
      });
    }
    expect(ledger.claimGuardEmailNoticeShown).not.toHaveBeenCalled();
  });

  it("the rendered claim stamps the hash of the address shown (audit fix)", async () => {
    expect(await claimGuardEmailNoticeRendered(noticeShop, "owner@example.com", null)).toBe(
      "claimed",
    );
    expect(ledger.claimGuardEmailNoticeShown).toHaveBeenCalledExactlyOnceWith(
      SHOP.domain,
      guardConsentHash("owner@example.com"),
    );
  });

  it("the address shown is compared trimmed and in any case", async () => {
    expect(await claimGuardEmailNoticeRendered(noticeShop, " Owner@Example.COM ", null)).toBe(
      "claimed",
    );
  });

  it("a claim for an address other than the one the notice names now stamps nothing", async () => {
    expect(await claimGuardEmailNoticeRendered(noticeShop, "old@example.com", null)).toBe(
      "not_claimed",
    );
    expect(await claimGuardEmailNoticeRendered(noticeShop, null, null)).toBe("not_claimed");
    expect(ledger.claimGuardEmailNoticeShown).not.toHaveBeenCalled();
  });

  // gc-1q1s.12: email goes only to the address the notice named, so with no
  // address known there is no notice and nothing to claim.
  it("no owner email known: no notice, and a claim is refused (gc-1q1s.12)", async () => {
    const noAddress = { ...noticeShop, alertEmail: null };
    contact.refreshShopAlertEmail.mockResolvedValue(null);
    expect(await guardEmailNoticeForHome(noAddress, null)).toBeNull();
    expect(await guardEmailNoticeForHome(noAddress, {} as AdminApiContext)).toBeNull();
    expect(await claimGuardEmailNoticeRendered(noAddress, null, null)).toBe("not_claimed");
    expect(await claimGuardEmailNoticeRendered(noAddress, null, {} as AdminApiContext)).toBe(
      "not_claimed",
    );
    expect(ledger.claimGuardEmailNoticeShown).not.toHaveBeenCalled();
  });

  it("a legacy stamp with no address hash is no consent: the notice is offered and claimed again (gc-1q1s.12)", async () => {
    const legacy = {
      ...noticeShop,
      guardEmailNoticeShownAt: new Date("2026-10-20T00:00:00Z"),
      guardEmailConsentHash: null,
    };
    expect(await guardEmailNoticeForHome(legacy, null)).toEqual({ email: "owner@example.com" });
    expect(await claimGuardEmailNoticeRendered(legacy, "owner@example.com", null)).toBe("claimed");
    expect(ledger.claimGuardEmailNoticeShown).toHaveBeenCalledExactlyOnceWith(
      SHOP.domain,
      guardConsentHash("owner@example.com"),
    );
    // Turned off still wins over a legacy stamp.
    expect(await guardEmailNoticeForHome({ ...legacy, guardEmailOffAt: NOW }, null)).toBeNull();
  });

  it("a double post: the atomic claim stamps once, the repeat reports false", async () => {
    ledger.claimGuardEmailNoticeShown.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await claimGuardEmailNoticeRendered(noticeShop, "owner@example.com", null)).toBe(
      "claimed",
    );
    expect(await claimGuardEmailNoticeRendered(noticeShop, "owner@example.com", null)).toBe(
      "not_claimed",
    );
  });

  it("guardConsentHash ignores case and surrounding spaces, and is not the address", () => {
    expect(guardConsentHash(" Owner@Example.com ")).toBe(guardConsentHash("owner@example.com"));
    expect(guardConsentHash("owner@example.com")).toMatch(/^[0-9a-f]{32}$/);
    expect(guardConsentHash("a@example.com")).not.toBe(guardConsentHash("b@example.com"));
  });

  it.each([
    ["Free", { plan: "free" }],
    [
      "already shown",
      {
        guardEmailNoticeShownAt: NOW,
        guardEmailConsentHash: guardConsentHash("owner@example.com"),
      },
    ],
    ["turned off", { guardEmailOffAt: NOW }],
    ["unsubscribed", { alertsEnabled: false }],
  ])("is never offered (and never claimed) when %s", async (_label, over) => {
    expect(await guardEmailNoticeForHome({ ...noticeShop, ...over }, null)).toBeNull();
    expect(
      await claimGuardEmailNoticeRendered({ ...noticeShop, ...over }, "owner@example.com", null),
    ).toBe("not_claimed");
    expect(ledger.claimGuardEmailNoticeShown).not.toHaveBeenCalled();
  });

  it("is not offered or claimed while the email flag or the transport is off", async () => {
    const both = async () => [
      await guardEmailNoticeForHome(noticeShop, null),
      await claimGuardEmailNoticeRendered(noticeShop, "owner@example.com", null),
    ];
    delete process.env.STOREFRONT_GUARD_EMAIL_ENABLED;
    expect(await both()).toEqual([null, "not_claimed"]);
    process.env.STOREFRONT_GUARD_EMAIL_ENABLED = "true";
    delete process.env.STOREFRONT_GUARD_LIVE_ENABLED;
    expect(await both()).toEqual([null, "not_claimed"]);
    process.env.STOREFRONT_GUARD_LIVE_ENABLED = "true";
    alerts.getMerchantAlertConfigStatus.mockReturnValue({ configured: false, reason: "disabled" });
    expect(await both()).toEqual([null, "not_claimed"]);
    expect(ledger.claimGuardEmailNoticeShown).not.toHaveBeenCalled();
  });

  it("a failed claim reports failed (worth a retry) and never throws", async () => {
    ledger.claimGuardEmailNoticeShown.mockRejectedValueOnce(new Error("db"));
    expect(await claimGuardEmailNoticeRendered(noticeShop, "owner@example.com", null)).toBe(
      "failed",
    );
  });

  it("reads the owner email when none is cached, and names it", async () => {
    contact.refreshShopAlertEmail.mockResolvedValue("fresh@example.com");
    expect(
      await guardEmailNoticeForHome({ ...noticeShop, alertEmail: null }, {} as AdminApiContext),
    ).toEqual({ email: "fresh@example.com" });
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
    ["no_consent_address", { guardEmailConsentHash: null }],
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
    expect(ledger.recordMerchantAlert).toHaveBeenCalledTimes(2);
    expect(guardModel.markIncidentsEmailed).toHaveBeenCalled();
  });

  // Audit fixes: a stamp failure after a send never causes a resend, and a
  // transient ledger failure is retried so the throttle still counts it.
  it("a ledger write that fails once is retried and the email is counted", async () => {
    ledger.recordMerchantAlert.mockRejectedValueOnce(new Error("blip")).mockResolvedValue({});
    expect(await send()).toEqual({ sent: true, reason: "sent", count: 1 });
    expect(ledger.recordMerchantAlert).toHaveBeenCalledTimes(2);
  });

  it("a failed episode stamp after sending still reports sent (never throws, never resends)", async () => {
    guardModel.markIncidentsEmailed.mockRejectedValue(new Error("db"));
    expect(await send()).toEqual({ sent: true, reason: "sent", count: 1 });
  });

  it("already in the ledger (the stamp failed after an earlier send): stamps, never resends", async () => {
    ledger.hasGuardAlert.mockResolvedValue(true);
    expect(await send()).toEqual({ sent: false, reason: "already_sent" });
    expect(ledger.hasGuardAlert).toHaveBeenCalledWith("shop-1", guardLedgerKey([incident()]));
    expect(alerts.sendMerchantAlert).not.toHaveBeenCalled();
    expect(guardModel.markIncidentsEmailed).toHaveBeenCalledWith([incident()]);
  });

  // Audit fix: consent covers the address the notice named.
  it("sends to the address the notice named", async () => {
    contact.refreshShopContact.mockResolvedValue({ email: "OWNER@example.com", storeName: null });
    const consented = { guardEmailConsentHash: guardConsentHash("owner@example.com") };
    const out = await sendGuardIncidentEmail({
      shop: { ...SHOP, ...consented },
      incidentIds: ["inc-1"],
      admin: {} as AdminApiContext,
      now: NOW,
    });
    expect(out).toMatchObject({ sent: true });
    expect(alerts.sendMerchantAlert.mock.calls[0][0].to).toBe("OWNER@example.com");
  });

  it("a changed owner email gets no email; the notice is shown again first", async () => {
    contact.refreshShopContact.mockResolvedValue({ email: "new@example.com", storeName: null });
    const out = await sendGuardIncidentEmail({
      shop: { ...SHOP, guardEmailConsentHash: guardConsentHash("owner@example.com") },
      incidentIds: ["inc-1"],
      admin: {} as AdminApiContext,
      now: NOW,
    });
    expect(out).toEqual({ sent: false, reason: "recipient_changed" });
    expect(ledger.resetGuardEmailNotice).toHaveBeenCalledWith("shop-1");
    expect(alerts.sendMerchantAlert).not.toHaveBeenCalled();
    expect(guardModel.markIncidentsEmailed).not.toHaveBeenCalled();
  });

  // gc-1q1s.12: a consent stamp with no address hash (a legacy generic-wording
  // claim) is no consent; never "whatever the owner email is at send time".
  it("a consent stamp with no address hash sends nothing, even with an owner email (gc-1q1s.12)", async () => {
    contact.refreshShopContact.mockResolvedValue({ email: "new@example.com", storeName: null });
    for (const admin of [null, {} as AdminApiContext]) {
      const out = await sendGuardIncidentEmail({
        shop: { ...SHOP, guardEmailConsentHash: null },
        incidentIds: ["inc-1"],
        admin,
        now: NOW,
      });
      expect(out).toEqual({ sent: false, reason: "no_consent_address" });
    }
    expect(alerts.sendMerchantAlert).not.toHaveBeenCalled();
    expect(guardModel.loadIncidentsToEmail).not.toHaveBeenCalled();
    expect(guardModel.markIncidentsEmailed).not.toHaveBeenCalled();
    expect(ledger.recordMerchantAlert).not.toHaveBeenCalled();
  });

  it("never throws", async () => {
    guardModel.loadIncidentsToEmail.mockRejectedValue(new Error("db down"));
    expect(await send()).toEqual({ sent: false, reason: "exception" });
  });
});

describe("sendGuardIncidentEmail: per-episode ledger (wave 3 B5)", () => {
  const A = incident();
  const B = incident({
    id: "inc-2",
    kind: "SCRIPT_LOADER",
    fingerprint: "SCRIPT_LOADER:pay.example",
    host: "pay.example",
  });
  const send = (ids: string[]) =>
    sendGuardIncidentEmail({ shop: SHOP, incidentIds: ids, admin: null, now: NOW });

  it("an episode emailed in an earlier batch is never resent when the batch changes", async () => {
    // A was emailed alone; its episode stamp failed, so it is offered again with B.
    guardModel.loadIncidentsToEmail.mockResolvedValue([A, B]);
    ledger.emailedGuardIncidentKeys.mockResolvedValue(new Set([guardIncidentLedgerKey(A)]));
    expect(await send(["inc-1", "inc-2"])).toEqual({ sent: true, reason: "sent", count: 1 });
    const mail = alerts.sendMerchantAlert.mock.calls[0][0];
    expect(mail.text).toContain("pay.example");
    expect(mail.text).not.toContain("cartassure.top");
    expect(guardModel.markIncidentsEmailed).toHaveBeenCalledWith([A]);
    expect(guardModel.markIncidentsEmailed).toHaveBeenLastCalledWith([B]);
    expect(ledger.recordGuardIncidentsEmailed).toHaveBeenCalledWith(
      "shop-1",
      [guardIncidentLedgerKey(B)],
      "owner@example.com",
    );
  });

  it("every episode already emailed: stamps them, sends nothing", async () => {
    guardModel.loadIncidentsToEmail.mockResolvedValue([A, B]);
    ledger.emailedGuardIncidentKeys.mockResolvedValue(
      new Set([guardIncidentLedgerKey(A), guardIncidentLedgerKey(B)]),
    );
    expect(await send(["inc-1", "inc-2"])).toEqual({ sent: false, reason: "already_sent" });
    expect(alerts.sendMerchantAlert).not.toHaveBeenCalled();
    expect(guardModel.markIncidentsEmailed).toHaveBeenCalledWith([A, B]);
  });

  it("records each emailed episode after a send; a failing ledger write never fails the send", async () => {
    expect(await send(["inc-1"])).toMatchObject({ sent: true });
    expect(ledger.recordGuardIncidentsEmailed).toHaveBeenCalledWith(
      "shop-1",
      [guardIncidentLedgerKey(A)],
      "owner@example.com",
    );
    vi.clearAllMocks();
    alerts.getMerchantAlertConfigStatus.mockReturnValue({ configured: true });
    alerts.sendMerchantAlert.mockResolvedValue({ sent: true, reason: "sent" });
    ledger.countGuardAlertsSince.mockResolvedValue(0);
    ledger.ensureUnsubscribeToken.mockResolvedValue("tok");
    ledger.emailedGuardIncidentKeys.mockResolvedValue(new Set());
    ledger.recordGuardIncidentsEmailed.mockRejectedValue(new Error("db"));
    guardModel.loadIncidentsToEmail.mockResolvedValue([A]);
    contact.refreshShopContact.mockResolvedValue({ email: null, storeName: null });
    // Wave 4 M2: the failure is visible (the outcome and a counted log line,
    // never the recipient); the episode stamp still follows (no resend).
    expect(await send(["inc-1"])).toEqual({ sent: true, reason: "sent_not_recorded", count: 1 });
    expect(ledger.recordGuardIncidentsEmailed).toHaveBeenCalledTimes(2);
    expect(guardModel.markIncidentsEmailed).toHaveBeenCalledWith([A]);
    expect(logger.error).toHaveBeenCalledWith(
      "Guard email sent but episode ledger write failed",
      expect.objectContaining({ event: "guard_email_episode_ledger_failed", episodes: 1 }),
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("owner@example.com");
  });

  it("the episode key names the incident and its episode start", () => {
    expect(guardIncidentLedgerKey(A)).toBe(`guard-incident:inc-1:${OPENED.toISOString()}`);
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

  it("lists at most MAX_EMAIL_INCIDENTS incidents, known-malicious first, then 'and N more' (wave 4 H1)", () => {
    const loaders = Array.from({ length: 40 }, (_, i) =>
      toIncidentView(
        incident({
          id: `l${i}`,
          kind: "SCRIPT_LOADER",
          fingerprint: `SCRIPT_LOADER:h${i}.evil.example`,
          host: `h${i}.evil.example`,
        }),
      ),
    );
    const many = { ...body, incidents: [...loaders, toIncidentView(incident())] };
    expect(MAX_EMAIL_INCIDENTS).toBe(10);
    for (const out of [buildGuardEmailText(many), buildGuardEmailHtml(many)]) {
      expect(out).toContain("cartassure.top");
      expect(out.indexOf("cartassure.top")).toBeLessThan(out.indexOf("h0.evil.example"));
      expect(out).toContain("h8.evil.example");
      expect(out).not.toContain("h9.evil.example");
      expect(out).toContain("And 31 more on your Home page in GhostCode.");
    }
    expect(buildGuardEmailText(body)).not.toContain("more on your Home page");
    const ten = { ...body, incidents: loaders.slice(0, 10) };
    expect(buildGuardEmailText(ten)).toContain("h9.evil.example");
    expect(buildGuardEmailText(ten)).not.toContain("more on your Home page");
  });

  it("subject falls back to the domain", () => {
    expect(buildGuardEmailSubject(null, SHOP.domain)).toBe(
      `GhostCode checkout guard alert for ${SHOP.domain}`,
    );
  });
});

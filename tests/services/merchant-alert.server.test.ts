/**
 * Tests for app/services/merchant-alert.server.ts (gc-syz.4).
 * fetch is ALWAYS mocked: no test may reach the real Resend API.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const m = vi.hoisted(() => ({
  getLatest: vi.fn(),
  record: vi.fn(),
  ensureToken: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("../../app/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../app/models/merchant-alert.server", () => ({
  getLatestMerchantAlert: m.getLatest,
  recordMerchantAlert: m.record,
  ensureUnsubscribeToken: m.ensureToken,
}));
vi.mock("../../app/services/shop-alert-email.server", () => ({
  refreshShopAlertEmail: m.refresh,
}));

import {
  buildAlertSubject,
  buildAlertText,
  buildFindingSetHash,
  buildScanAdminUrl,
  getMerchantAlertConfigStatus,
  notifyNewFindings,
  sendMerchantAlert,
  MAX_FINDINGS_IN_EMAIL,
} from "../../app/services/merchant-alert.server";
import type { NewFinding, NotifyShop } from "../../app/services/merchant-alert.server";

const ORIGINAL_ENV = { ...process.env };
const fetchMock = vi.fn();

const finding = (
  filename: string,
  findingType = "GHOST_SCRIPT",
  severity = "HIGH",
): NewFinding => ({
  filename,
  findingType,
  severity,
  appName: "Klaviyo",
  description: "SECRET-SNIPPET <script src=x>",
});

const shop = (over: Partial<NotifyShop> = {}): NotifyShop => ({
  id: "shop-1",
  domain: "my-store.myshopify.com",
  plan: "Professional",
  alertsEnabled: true,
  alertEmail: "cached@example.com",
  ...over,
});

const ADMIN = { graphql: vi.fn() };

function enableEnv() {
  process.env.MERCHANT_ALERTS_ENABLED = "true";
  process.env.RESEND_API_KEY = "re_test";
  process.env.MERCHANT_ALERT_FROM = "Ghost Code <alerts@example.com>";
  process.env.SHOPIFY_APP_URL = "https://app.example.com/";
}

const notify = (over: Partial<Parameters<typeof notifyNewFindings>[0]> = {}) =>
  notifyNewFindings({
    shop: shop(),
    scan: { id: "scan-1" },
    newFindings: [finding("layout/theme.liquid")],
    admin: ADMIN,
    ...over,
  });

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.MERCHANT_ALERTS_ENABLED;
  delete process.env.RESEND_API_KEY;
  delete process.env.MERCHANT_ALERT_FROM;
  delete process.env.OPS_ALERT_FROM;
  enableEnv();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue({ ok: true, status: 200 });
  m.getLatest.mockResolvedValue(null);
  m.record.mockResolvedValue({});
  m.ensureToken.mockResolvedValue("tok123");
  m.refresh.mockResolvedValue("fresh@example.com");
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
});

describe("getMerchantAlertConfigStatus / env gates", () => {
  it.each([
    ["MERCHANT_ALERTS_ENABLED", "disabled"],
    ["RESEND_API_KEY", "no_transport"],
    ["MERCHANT_ALERT_FROM", "no_sender"],
  ])("missing %s => %s", (envVar, reason) => {
    delete process.env[envVar];
    expect(getMerchantAlertConfigStatus()).toEqual({ configured: false, reason });
  });

  it("anything but the exact string 'true' is disabled", () => {
    process.env.MERCHANT_ALERTS_ENABLED = "1";
    expect(getMerchantAlertConfigStatus()).toEqual({ configured: false, reason: "disabled" });
  });

  it("all three set => configured", () => {
    expect(getMerchantAlertConfigStatus()).toEqual({ configured: true });
  });
});

describe("sendMerchantAlert", () => {
  const input = {
    to: "a@example.com",
    subject: "s",
    text: "t",
    unsubscribeUrl: "https://app.example.com/unsubscribe/tok",
    idempotencyKey: "merchant-alert:scan-9",
  };

  it("posts to Resend with RFC 8058 headers and the Idempotency-Key", async () => {
    const result = await sendMerchantAlert(input);
    expect(result).toEqual({ sent: true, reason: "sent" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.headers["List-Unsubscribe"]).toBe("<https://app.example.com/unsubscribe/tok>");
    expect(init.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(init.headers["Idempotency-Key"]).toBe("merchant-alert:scan-9");
    expect(init.headers.Authorization).toBe("Bearer re_test");
    expect(init.signal).toBeDefined();
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ from: "Ghost Code <alerts@example.com>", to: "a@example.com" });
  });

  it("never falls back to the ops sender", async () => {
    process.env.OPS_ALERT_FROM = "Ops <ops@example.com>";
    delete process.env.MERCHANT_ALERT_FROM;
    const result = await sendMerchantAlert(input);
    expect(result).toEqual({ sent: false, reason: "no_sender" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["disabled", "MERCHANT_ALERTS_ENABLED"],
    ["no_transport", "RESEND_API_KEY"],
  ])("returns %s without fetching when %s is unset", async (reason, envVar) => {
    delete process.env[envVar];
    expect(await sendMerchantAlert(input)).toEqual({ sent: false, reason });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns http_error on 4xx and 5xx", async () => {
    for (const status of [400, 422, 500]) {
      fetchMock.mockResolvedValueOnce({ ok: false, status });
      expect(await sendMerchantAlert(input)).toEqual({ sent: false, reason: "http_error" });
    }
  });

  it("returns exception (never throws) on a thrown fetch or timeout", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network"));
    expect(await sendMerchantAlert(input)).toEqual({ sent: false, reason: "exception" });
    fetchMock.mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));
    expect(await sendMerchantAlert(input)).toEqual({ sent: false, reason: "exception" });
  });
});

describe("buildFindingSetHash", () => {
  const a = finding("a.liquid", "GHOST_SCRIPT");
  const b = finding("b.liquid", "GHOST_STYLE");

  it("is stable under reordering", () => {
    expect(buildFindingSetHash([a, b])).toBe(buildFindingSetHash([b, a]));
  });
  it("differs for different sets, files, or types", () => {
    expect(buildFindingSetHash([a])).not.toBe(buildFindingSetHash([a, b]));
    expect(buildFindingSetHash([a])).not.toBe(buildFindingSetHash([finding("c.liquid")]));
    expect(buildFindingSetHash([a])).not.toBe(
      buildFindingSetHash([finding("a.liquid", "GHOST_STYLE")]),
    );
  });
  it("ignores severity, appName, and description", () => {
    const variant: NewFinding = { ...a, severity: "LOW", appName: null, description: "x" };
    expect(buildFindingSetHash([a])).toBe(buildFindingSetHash([variant]));
  });
  it("is an 8-char hex string", () => {
    expect(buildFindingSetHash([a])).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("email copy", () => {
  const text = buildAlertText({
    shopDomain: "my-store.myshopify.com",
    newFindings: [finding("layout/theme.liquid"), finding("snippets/x.liquid", "GHOST_STYLE")],
    scanUrl: "https://admin.shopify.com/store/my-store/apps/ghost-code/app/scans/scan-1",
    unsubscribeUrl: "https://app.example.com/unsubscribe/tok",
  });

  it("uses monitoring framing and never 'instant'", () => {
    expect(text).toContain("continuous monitoring");
    expect(text.toLowerCase()).not.toContain("instant");
    expect(text.toLowerCase()).not.toContain("uninstall");
  });
  it("has no em dash or en dash in subject or body", () => {
    expect(text).not.toMatch(/[–—]/);
    expect(buildAlertSubject(2, "my-store.myshopify.com")).not.toMatch(/[–—]/);
  });
  it("lists type label and filename but no code snippet", () => {
    expect(text).toContain("- Scripts: layout/theme.liquid");
    expect(text).toContain("- Styles: snippets/x.liquid");
    expect(text).not.toContain("SECRET-SNIPPET");
    expect(text).not.toContain("<script");
  });
  it("includes the scan link and the unsubscribe link", () => {
    expect(text).toContain("/apps/ghost-code/app/scans/scan-1");
    expect(text).toContain("Turn off these emails: https://app.example.com/unsubscribe/tok");
  });
  it("caps the list and summarizes the rest", () => {
    const many = Array.from({ length: MAX_FINDINGS_IN_EMAIL + 3 }, (_, i) =>
      finding(`f${i}.liquid`),
    );
    const t = buildAlertText({
      shopDomain: "s.myshopify.com",
      newFindings: many,
      scanUrl: "u",
      unsubscribeUrl: "v",
    });
    expect(t.match(/^- Scripts:/gm)).toHaveLength(MAX_FINDINGS_IN_EMAIL);
    expect(t).toContain("- and 3 more");
  });
  it("subject pluralizes and names the shop", () => {
    expect(buildAlertSubject(1, "s.myshopify.com")).toBe(
      "Ghost Code found 1 new leftover code issue in s.myshopify.com",
    );
    expect(buildAlertSubject(3, "s.myshopify.com")).toBe(
      "Ghost Code found 3 new leftover code issues in s.myshopify.com",
    );
  });
  it("builds the admin deep link from the store handle", () => {
    expect(buildScanAdminUrl("my-store.myshopify.com", "scan-1")).toBe(
      "https://admin.shopify.com/store/my-store/apps/ghost-code/app/scans/scan-1",
    );
  });
});

describe("notifyNewFindings gating chain", () => {
  it("sends and records on the happy path", async () => {
    const outcome = await notify();
    expect(outcome).toEqual({ sent: true, reason: "sent" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1];
    expect(init.headers["Idempotency-Key"]).toBe("merchant-alert:scan-1");
    expect(init.headers["List-Unsubscribe"]).toBe("<https://app.example.com/unsubscribe/tok123>");
    const body = JSON.parse(init.body);
    expect(body.to).toBe("fresh@example.com");
    expect(body.subject).toBe(
      "Ghost Code found 1 new leftover code issue in my-store.myshopify.com",
    );
    expect(body.text).not.toMatch(/[–—]/);
    expect(m.record).toHaveBeenCalledWith({
      shopId: "shop-1",
      scanId: "scan-1",
      findingSetHash: buildFindingSetHash([finding("layout/theme.liquid")]),
      newCount: 1,
      recipient: "fresh@example.com",
    });
  });

  it.each([
    ["MERCHANT_ALERTS_ENABLED", "disabled"],
    ["RESEND_API_KEY", "no_transport"],
    ["MERCHANT_ALERT_FROM", "no_sender"],
  ])("env gate: missing %s => %s, nothing happens", async (envVar, reason) => {
    delete process.env[envVar];
    expect(await notify()).toEqual({ sent: false, reason });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(m.refresh).not.toHaveBeenCalled();
    expect(m.record).not.toHaveBeenCalled();
  });

  it("plan gate: Free is not eligible", async () => {
    expect(await notify({ shop: shop({ plan: "Free" }) })).toEqual({
      sent: false,
      reason: "plan_not_eligible",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opt-out: alertsEnabled false", async () => {
    expect(await notify({ shop: shop({ alertsEnabled: false }) })).toEqual({
      sent: false,
      reason: "shop_opted_out",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no new findings", async () => {
    expect(await notify({ newFindings: [] })).toEqual({ sent: false, reason: "no_new_findings" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("recipient: falls back to the cached email when refresh returns null", async () => {
    m.refresh.mockResolvedValue(null);
    await notify();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).to).toBe("cached@example.com");
  });

  it("recipient: admin null skips refresh and uses the cached email", async () => {
    await notify({ admin: null });
    expect(m.refresh).not.toHaveBeenCalled();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).to).toBe("cached@example.com");
  });

  it("no recipient at all => skip", async () => {
    m.refresh.mockResolvedValue(null);
    expect(await notify({ shop: shop({ alertEmail: null }) })).toEqual({
      sent: false,
      reason: "no_recipient",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dedup: same finding set as the latest alert => skip", async () => {
    m.getLatest.mockResolvedValue({
      findingSetHash: buildFindingSetHash([finding("layout/theme.liquid")]),
      sentAt: new Date(0),
    });
    expect(await notify()).toEqual({ sent: false, reason: "duplicate_set" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rate window: a different set inside the plan window => throttled", async () => {
    m.getLatest.mockResolvedValue({
      findingSetHash: "other",
      sentAt: new Date(Date.now() - 3600_000),
    });
    expect(await notify()).toEqual({ sent: false, reason: "throttled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rate window follows the plan: 2 days ago passes Professional (daily) but not Standard (weekly)", async () => {
    m.getLatest.mockResolvedValue({
      findingSetHash: "other",
      sentAt: new Date(Date.now() - 2 * 86_400_000),
    });
    expect((await notify({ shop: shop({ plan: "Standard" }) })).reason).toBe("throttled");
    expect((await notify({ shop: shop({ plan: "Professional" }) })).reason).toBe("sent");
  });

  describe("throttle tolerance (90% of the window)", () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
    afterEach(() => vi.useRealTimers());

    const sentAgo = (fraction: number) => {
      const now = new Date("2026-06-15T12:00:00Z");
      vi.setSystemTime(now);
      m.getLatest.mockResolvedValue({
        findingSetHash: "other",
        sentAt: new Date(now.getTime() - fraction * 86_400_000),
      });
    };

    it("89% of the window ago => throttled", async () => {
      sentAgo(0.89);
      expect((await notify()).reason).toBe("throttled");
    });
    it("91% of the window ago => sent (scheduler jitter must not throttle)", async () => {
      sentAgo(0.91);
      expect((await notify()).reason).toBe("sent");
    });
  });

  it("Resend 409 invalid_idempotent_request => send_failed, no record, no throw", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ name: "invalid_idempotent_request", message: "x" }),
    });
    expect(await notify()).toEqual({ sent: false, reason: "send_failed" });
    expect(m.record).not.toHaveBeenCalled();
  });

  it("a 409 with an unparseable body still fails cleanly", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => {
        throw new Error("bad json");
      },
    });
    expect(await notify()).toEqual({ sent: false, reason: "send_failed" });
    expect(m.record).not.toHaveBeenCalled();
  });

  it("no SHOPIFY_APP_URL => skip", async () => {
    delete process.env.SHOPIFY_APP_URL;
    expect(await notify()).toEqual({ sent: false, reason: "no_app_url" });
  });

  it("no unsubscribe token => skip (never send without an unsubscribe link)", async () => {
    m.ensureToken.mockResolvedValue(null);
    expect(await notify()).toEqual({ sent: false, reason: "no_unsubscribe_token" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["4xx", () => fetchMock.mockResolvedValue({ ok: false, status: 422 })],
    ["5xx", () => fetchMock.mockResolvedValue({ ok: false, status: 503 })],
    ["timeout", () => fetchMock.mockRejectedValue(new DOMException("t", "TimeoutError"))],
    ["throw", () => fetchMock.mockRejectedValue(new Error("boom"))],
  ])("Resend %s => no record, no throw", async (_name, arrange) => {
    arrange();
    expect(await notify()).toEqual({ sent: false, reason: "send_failed" });
    expect(m.record).not.toHaveBeenCalled();
  });

  it("ledger write failure after a successful send is reported, not thrown", async () => {
    m.record.mockRejectedValue(new Error("db"));
    expect(await notify()).toEqual({ sent: true, reason: "sent_not_recorded" });
  });

  it("never throws when a dependency throws", async () => {
    m.getLatest.mockRejectedValue(new Error("db down"));
    expect(await notify()).toEqual({ sent: false, reason: "exception" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

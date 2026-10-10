/**
 * Tests for app/services/merchant-alert.server.ts (gc-syz.4): the merchant
 * email transport (env gates, Resend send, links). The summary email that uses
 * it is covered in summary-email.server.test.ts (gc-ol95).
 * fetch is ALWAYS mocked: no test may reach the real Resend API.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../app/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from "../../app/lib/logger.server";
import {
  buildBodyUnsubscribeUrl,
  buildHeaderUnsubscribeUrl,
  buildScanAdminUrl,
  getMerchantAlertConfigStatus,
  sendMerchantAlert,
} from "../../app/services/merchant-alert.server";

const ORIGINAL_ENV = { ...process.env };
const fetchMock = vi.fn();

function enableEnv() {
  process.env.MERCHANT_ALERTS_ENABLED = "true";
  process.env.RESEND_API_KEY = "re_test";
  process.env.MERCHANT_ALERT_FROM = "Ghost Code <alerts@example.com>";
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.OPS_ALERT_FROM;
  enableEnv();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue({ ok: true, status: 200 });
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

  it("all three set => configured; no postal address is required (gc-ol95)", () => {
    delete process.env.MERCHANT_EMAIL_POSTAL_ADDRESS;
    expect(getMerchantAlertConfigStatus()).toEqual({ configured: true });
  });
});

describe("sendMerchantAlert", () => {
  const input = {
    to: "a@example.com",
    subject: "s",
    text: "t",
    unsubscribeUrl: "https://app.example.com/unsubscribe/tok",
    idempotencyKey: "summary-email:scan-9",
  };

  it("posts to Resend with RFC 8058 headers and the Idempotency-Key", async () => {
    const result = await sendMerchantAlert(input);
    expect(result).toEqual({ sent: true, reason: "sent" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.headers["List-Unsubscribe"]).toBe("<https://app.example.com/unsubscribe/tok>");
    expect(init.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(init.headers["Idempotency-Key"]).toBe("summary-email:scan-9");
    expect(init.headers.Authorization).toBe("Bearer re_test");
    expect(init.signal).toBeDefined();
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ from: "Ghost Code <alerts@example.com>", to: "a@example.com" });
  });

  it("sends the HTML part alongside the text when given, and omits it otherwise", async () => {
    await sendMerchantAlert({ ...input, html: "<p>h</p>" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      text: "t",
      html: "<p>h</p>",
    });
    await sendMerchantAlert(input);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).not.toHaveProperty("html");
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
    ["no_sender", "MERCHANT_ALERT_FROM"],
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

  it("Resend 409 invalid_idempotent_request => http_error with the code logged, no throw", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ name: "invalid_idempotent_request" }),
    });
    expect(await sendMerchantAlert(input)).toEqual({ sent: false, reason: "http_error" });
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).toContain(
      "invalid_idempotent_request",
    );
  });

  it("a 409 with an unparseable body still fails cleanly", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => {
        throw new Error("bad json");
      },
    });
    expect(await sendMerchantAlert(input)).toEqual({ sent: false, reason: "http_error" });
  });

  it("returns exception (never throws) on a thrown fetch or timeout", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network"));
    expect(await sendMerchantAlert(input)).toEqual({ sent: false, reason: "exception" });
    fetchMock.mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));
    expect(await sendMerchantAlert(input)).toEqual({ sent: false, reason: "exception" });
  });

  it("never logs the recipient address", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    await sendMerchantAlert(input);
    fetchMock.mockRejectedValueOnce(new Error("network"));
    await sendMerchantAlert(input);
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain("a@example.com");
  });
});

describe("links", () => {
  it("builds the admin deep link from the store handle", () => {
    expect(buildScanAdminUrl("my-store.myshopify.com", "scan-1")).toBe(
      "https://admin.shopify.com/store/my-store/apps/ghost-code/app/scans/scan-1",
    );
  });

  it("body link carries the token in the fragment; header link in the path", () => {
    expect(buildBodyUnsubscribeUrl("https://app.example.com", "tok")).toBe(
      "https://app.example.com/unsubscribe#t=tok",
    );
    expect(buildHeaderUnsubscribeUrl("https://app.example.com", "tok")).toBe(
      "https://app.example.com/unsubscribe/tok",
    );
  });
});

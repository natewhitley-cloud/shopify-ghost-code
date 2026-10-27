/**
 * Tests for app/services/support-email.server.ts (gc-3twe): Help messages go
 * to the support inbox from the verified merchant-mail sender, with reply_to
 * only for a consented merchant address, one retry without reply_to on a 4xx,
 * and a durable api_error record for every message that misses the inbox.
 * fetch is ALWAYS mocked: no test may reach the real Resend API.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../app/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../app/models/ops-event.server", () => ({
  recordApiError: vi.fn(),
}));

import { SUPPORT_EMAIL } from "../../app/lib/help";
import { logger } from "../../app/lib/logger.server";
import { recordApiError } from "../../app/models/ops-event.server";
import {
  sendSupportEmail,
  SUPPORT_EMAIL_FAILURE_CODE,
} from "../../app/services/support-email.server";

const ORIGINAL_ENV = { ...process.env };
const fetchMock = vi.fn();
const mockRecordApiError = vi.mocked(recordApiError);
const VERIFIED_FROM = "GhostCode <alerts@alpenglowsoftware.com>";
const DOMAIN = "s.myshopify.com";
const INPUT = {
  subject: "GhostCode help: Billing from s.myshopify.com",
  text: "Body\nReply to: owner@shop.com",
  shopDomain: DOMAIN,
  topic: "billing",
};

/** The JSON payload of the nth Resend call. */
const payload = (n = 0) => JSON.parse(fetchMock.mock.calls[n][1].body as string);

/** Every logged and recorded argument, serialized (for "never leaks" checks). */
const everythingLoggedOrRecorded = () =>
  JSON.stringify([
    vi.mocked(logger.warn).mock.calls,
    vi.mocked(logger.error).mock.calls,
    mockRecordApiError.mock.calls,
  ]);

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...ORIGINAL_ENV };
  process.env.RESEND_API_KEY = "re_test";
  process.env.MERCHANT_ALERT_FROM = VERIFIED_FROM;
  process.env.OPS_ALERT_EMAIL = "ops@example.com";
  delete process.env.OPS_ALERT_FROM;
  // Merchant-mail kill switch off: support mail must not depend on it.
  delete process.env.MERCHANT_ALERTS_ENABLED;
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue({ ok: true, status: 200 });
  mockRecordApiError.mockResolvedValue(undefined);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
});

describe("sendSupportEmail: delivery", () => {
  it("sends to the support inbox (not OPS_ALERT_EMAIL) from the verified sender", async () => {
    await expect(sendSupportEmail({ ...INPUT, replyTo: null })).resolves.toEqual({
      sent: true,
      reason: "sent",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.headers.Authorization).toBe("Bearer re_test");
    const body = payload();
    expect(body.to).toBe(SUPPORT_EMAIL);
    expect(body.to).toBe("support@alpenglowsoftware.com");
    expect(body.from).toBe(VERIFIED_FROM);
    expect(body.from).not.toContain("resend.dev");
    expect(body.subject).toBe(INPUT.subject);
    expect(body.text).toBe(INPUT.text);
    expect(mockRecordApiError).not.toHaveBeenCalled();
  });

  it("sets reply_to to the merchant's consented address", async () => {
    await sendSupportEmail({ ...INPUT, replyTo: "owner@shop.com" });
    expect(payload().reply_to).toBe("owner@shop.com");
  });

  it("sends no reply_to without an address", async () => {
    await sendSupportEmail({ ...INPUT, replyTo: null });
    expect(payload()).not.toHaveProperty("reply_to");
  });
});

describe("sendSupportEmail: 4xx with reply_to retries once without it", () => {
  it.each([400, 422, 499])("%i then OK: delivered without reply_to, body unchanged", async (s) => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: s });

    await expect(sendSupportEmail({ ...INPUT, replyTo: "owner@shop.com" })).resolves.toEqual({
      sent: true,
      reason: "sent_without_reply_to",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(payload(0).reply_to).toBe("owner@shop.com");
    expect(payload(1)).not.toHaveProperty("reply_to");
    expect(payload(1).text).toContain("Reply to: owner@shop.com");
    expect(mockRecordApiError).not.toHaveBeenCalled();
  });

  it("the retry failing too: one record, no third attempt", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 422 });

    await expect(sendSupportEmail({ ...INPUT, replyTo: "owner@shop.com" })).resolves.toEqual({
      sent: false,
      reason: "http_error",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockRecordApiError).toHaveBeenCalledTimes(1);
  });

  it("a 5xx is not retried", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });

    await sendSupportEmail({ ...INPUT, replyTo: "owner@shop.com" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a 4xx without reply_to is not retried", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 422 });

    await sendSupportEmail({ ...INPUT, replyTo: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("sendSupportEmail: failures are logged and recorded, never thrown", () => {
  it.each([
    ["RESEND_API_KEY", "no_transport"],
    ["MERCHANT_ALERT_FROM", "no_sender"],
  ])("missing %s: no send, a logged and recorded no-op (%s)", async (envVar, reason) => {
    delete process.env[envVar];

    await expect(sendSupportEmail({ ...INPUT, replyTo: "owner@shop.com" })).resolves.toEqual({
      sent: false,
      reason,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "Support email not delivered (transport not configured)",
      { context: "support-email", reason, subject: INPUT.subject },
    );
    expect(mockRecordApiError).toHaveBeenCalledExactlyOnceWith({
      level: "error",
      code: SUPPORT_EMAIL_FAILURE_CODE,
      shopDomain: DOMAIN,
      message: expect.stringContaining(reason),
      metadata: { reason, topic: "billing" },
    });
  });

  it("a non-OK response is logged, recorded with its status and returned", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });

    await expect(sendSupportEmail({ ...INPUT, replyTo: "owner@shop.com" })).resolves.toEqual({
      sent: false,
      reason: "http_error",
    });
    expect(logger.error).toHaveBeenCalledWith(
      "Support email send returned non-OK",
      expect.objectContaining({ status: 500 }),
    );
    expect(mockRecordApiError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: SUPPORT_EMAIL_FAILURE_CODE,
        metadata: { reason: "http_error", topic: "billing", status: 500 },
      }),
    );
  });

  it("a fetch rejection is logged, recorded and returned", async () => {
    fetchMock.mockRejectedValue(new TypeError("network"));

    await expect(sendSupportEmail({ ...INPUT, replyTo: null })).resolves.toEqual({
      sent: false,
      reason: "exception",
    });
    expect(logger.error).toHaveBeenCalledWith(
      "Support email send failed",
      expect.objectContaining({ errorName: "TypeError" }),
    );
    expect(mockRecordApiError).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { reason: "exception", topic: "billing" } }),
    );
  });

  it("a failing record is swallowed (logged), so the send still resolves", async () => {
    fetchMock.mockRejectedValue(new TypeError("network"));
    mockRecordApiError.mockRejectedValue(new Error("db down"));

    await expect(sendSupportEmail({ ...INPUT, replyTo: null })).resolves.toEqual({
      sent: false,
      reason: "exception",
    });
    expect(logger.error).toHaveBeenCalledWith(
      "Support email failure record failed",
      expect.objectContaining({ errorName: "Error" }),
    );
  });

  it("never logs or records the body or the merchant's address", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 422 });
    await sendSupportEmail({ ...INPUT, replyTo: "owner@shop.com" });
    delete process.env.RESEND_API_KEY;
    await sendSupportEmail({ ...INPUT, replyTo: "owner@shop.com" });

    expect(everythingLoggedOrRecorded()).not.toContain("owner@shop.com");
    expect(everythingLoggedOrRecorded()).not.toContain("Body");
  });
});

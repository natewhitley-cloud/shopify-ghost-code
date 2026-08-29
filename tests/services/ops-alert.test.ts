import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("../../app/lib/logger.server", () => ({ logger: mockLogger }));

import { sendOpsAlert, getOpsAlertConfigStatus } from "../../app/services/ops-alert.server";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  // Start from a clean env for the vars this module reads.
  delete process.env.OPS_ALERT_EMAIL;
  delete process.env.RESEND_API_KEY;
  delete process.env.OPS_ALERT_FROM;
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
});

describe("sendOpsAlert — inert when OPS_ALERT_EMAIL unset", () => {
  it("is a no-op that logs and never calls fetch", async () => {
    const result = await sendOpsAlert("subj", "body");

    expect(result).toEqual({ sent: false, reason: "disabled" });
    expect(fetch).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      "Ops alert suppressed (OPS_ALERT_EMAIL unset)",
      expect.objectContaining({ subject: "subj" }),
    );
  });
});

describe("sendOpsAlert — recipient set but no transport key", () => {
  it("logs the alert content and does not call fetch", async () => {
    process.env.OPS_ALERT_EMAIL = "ops@example.com";

    const result = await sendOpsAlert("subj", "body");

    expect(result).toEqual({ sent: false, reason: "no_transport" });
    expect(fetch).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Ops alert not delivered (RESEND_API_KEY unset)",
      expect.objectContaining({ subject: "subj", body: "body" }),
    );
  });
});

describe("sendOpsAlert — fully configured", () => {
  beforeEach(() => {
    process.env.OPS_ALERT_EMAIL = "ops@example.com";
    process.env.RESEND_API_KEY = "re_test";
  });

  it("POSTs to Resend with prefixed subject, recipient, and body", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
    });

    const result = await sendOpsAlert("Cron health", "detail");

    expect(result).toEqual({ sent: true, reason: "sent" });
    expect(fetch).toHaveBeenCalledTimes(1);

    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer re_test");

    const sent = JSON.parse(init.body);
    expect(sent.to).toBe("ops@example.com");
    expect(sent.subject).toBe("[GhostCode Ops] Cron health");
    expect(sent.text).toBe("detail");
    expect(sent.from).toContain("onboarding@resend.dev");
  });

  it("honors OPS_ALERT_FROM override", async () => {
    process.env.OPS_ALERT_FROM = "Alerts <alerts@brand.com>";
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
    });

    await sendOpsAlert("s", "b");

    const init = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(JSON.parse(init.body).from).toBe("Alerts <alerts@brand.com>");
  });

  it("returns http_error and logs on a non-OK response", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 422,
    });

    const result = await sendOpsAlert("s", "b");

    expect(result).toEqual({ sent: false, reason: "http_error" });
    expect(mockLogger.error).toHaveBeenCalledWith(
      "Ops alert send returned non-OK",
      expect.objectContaining({ status: 422 }),
    );
  });

  it("never throws — swallows a fetch rejection into an exception result", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network down"));

    const result = await sendOpsAlert("s", "b");

    expect(result).toEqual({ sent: false, reason: "exception" });
    expect(mockLogger.error).toHaveBeenCalledWith(
      "Ops alert send failed",
      expect.objectContaining({ subject: "s" }),
    );
  });
});

describe("getOpsAlertConfigStatus", () => {
  it("reports no_recipient when OPS_ALERT_EMAIL is unset", () => {
    expect(getOpsAlertConfigStatus()).toEqual({
      configured: false,
      reason: "no_recipient",
    });
  });

  it("reports no_transport when the recipient is set but RESEND_API_KEY is not", () => {
    process.env.OPS_ALERT_EMAIL = "ops@example.com";
    expect(getOpsAlertConfigStatus()).toEqual({
      configured: false,
      reason: "no_transport",
    });
  });

  it("reports configured when both vars are present", () => {
    process.env.OPS_ALERT_EMAIL = "ops@example.com";
    process.env.RESEND_API_KEY = "re_test";
    expect(getOpsAlertConfigStatus()).toEqual({
      configured: true,
      reason: "ok",
    });
  });
});

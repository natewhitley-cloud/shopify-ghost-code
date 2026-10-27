/**
 * gc-3twe audit L9: a Help message whose support email fails end to end.
 * createHelpMessage runs with the REAL support-email transport (fetch mocked,
 * never the real Resend API); the DB writes and the api_error record are
 * mocked at the model boundary. The submit must succeed and the missed
 * delivery must be recorded.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../app/models/merchant-feedback.server", () => ({
  createMerchantFeedback: vi.fn(),
  countMerchantFeedbackSince: vi.fn(),
}));

vi.mock("../../app/models/scan.server", () => ({
  getScansForShop: vi.fn(),
}));

vi.mock("../../app/models/ops-event.server", () => ({
  recordApiError: vi.fn(),
}));

vi.mock("../../app/services/nudge-stage.server", () => ({
  recordNudgeStageOnce: vi.fn(),
}));

vi.mock("../../app/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createMerchantFeedback } from "../../app/models/merchant-feedback.server";
import { recordApiError } from "../../app/models/ops-event.server";
import { getScansForShop } from "../../app/models/scan.server";
import { createHelpMessage } from "../../app/services/feedback.server";

const ORIGINAL_ENV = { ...process.env };
const fetchMock = vi.fn();
const SHOP = { id: "shop-1", domain: "merchant.myshopify.com", plan: "free" };
const INPUT = {
  topic: "bug" as const,
  message: "Scan stuck",
  csat: null,
  contactEmail: "owner@shop.com",
};

/** Wait until the fire-and-forget send chain has settled. */
const settle = () => vi.waitFor(() => expect(recordApiError).toHaveBeenCalled());

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...ORIGINAL_ENV };
  process.env.RESEND_API_KEY = "re_test";
  process.env.MERCHANT_ALERT_FROM = "GhostCode <alerts@alpenglowsoftware.com>";
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(createMerchantFeedback).mockResolvedValue({ id: "fb-1" } as never);
  vi.mocked(getScansForShop).mockResolvedValue({ items: [], hasNextPage: false } as never);
  vi.mocked(recordApiError).mockResolvedValue(undefined);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
});

describe("createHelpMessage with a failing support email", () => {
  it("Resend 5xx: the submit succeeds, the row is kept and the failure is recorded", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });

    await expect(createHelpMessage(SHOP, INPUT)).resolves.toEqual({ id: "fb-1" });
    await settle();

    expect(createMerchantFeedback).toHaveBeenCalledTimes(1);
    expect(recordApiError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        code: "support_email_delivery_failed",
        shopDomain: SHOP.domain,
        metadata: { reason: "http_error", topic: "bug", status: 503 },
      }),
    );
  });

  it("network error: same outcome", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    await expect(createHelpMessage(SHOP, INPUT)).resolves.toEqual({ id: "fb-1" });
    await settle();
    expect(recordApiError).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { reason: "exception", topic: "bug" } }),
    );
  });

  it("transport unconfigured: same outcome, nothing fetched", async () => {
    delete process.env.RESEND_API_KEY;

    await expect(createHelpMessage(SHOP, INPUT)).resolves.toEqual({ id: "fb-1" });
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recordApiError).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { reason: "no_transport", topic: "bug" } }),
    );
  });

  it("a 422 on the consented reply_to is retried without it and delivered (no record)", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 422 });
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });

    await createHelpMessage(SHOP, INPUT);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const second = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(second).not.toHaveProperty("reply_to");
    expect(second.text).toContain("Reply to: owner@shop.com");
    expect(recordApiError).not.toHaveBeenCalled();
  });
});

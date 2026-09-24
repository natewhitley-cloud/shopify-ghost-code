/**
 * Tests for app/services/feedback.server.ts (gc-97k.3): survey validation and
 * createFeedback (persist, once-per-merchant `converted`, fire-and-forget ops
 * email). The model write, the stage recorder and the ops alert are mocked at
 * their module boundaries.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../app/models/merchant-feedback.server", () => ({
  createMerchantFeedback: vi.fn(),
}));

vi.mock("../../app/services/nudge-stage.server", () => ({
  recordNudgeStageOnce: vi.fn(),
}));

vi.mock("../../app/services/ops-alert.server", () => ({
  sendOpsAlert: vi.fn(),
}));

vi.mock("../../app/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from "../../app/lib/logger.server";
import { createMerchantFeedback } from "../../app/models/merchant-feedback.server";
import {
  createFeedback,
  formatFeedbackEmail,
  validateFeedbackInput,
} from "../../app/services/feedback.server";
import type { FeedbackInput } from "../../app/services/feedback.server";
import { recordNudgeStageOnce } from "../../app/services/nudge-stage.server";
import { sendOpsAlert } from "../../app/services/ops-alert.server";

const mockCreate = createMerchantFeedback as ReturnType<typeof vi.fn>;
const mockRecordStage = recordNudgeStageOnce as ReturnType<typeof vi.fn>;
const mockSendOpsAlert = sendOpsAlert as ReturnType<typeof vi.fn>;
const mockLoggerError = logger.error as ReturnType<typeof vi.fn>;

/** Let queued microtasks (the fire-and-forget email chain) settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// validateFeedbackInput
// ---------------------------------------------------------------------------

describe("validateFeedbackInput", () => {
  describe("CSAT (required integer 1..5)", () => {
    it.each(["1", "2", "3", "4", "5", 1, 5, " 4 "])("accepts %j", (csat) => {
      const result = validateFeedbackInput({ csat });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.csat).toBe(Number(csat));
    });

    it.each([
      ["missing", undefined],
      ["null (form field absent)", null],
      ["blank", ""],
      ["whitespace", "  "],
      ["zero", "0"],
      ["six", "6"],
      ["negative", "-1"],
      ["non-integer", "3.5"],
      ["non-integer number", 4.2],
      ["non-numeric", "great"],
      ["NaN", Number.NaN],
      ["Infinity", "Infinity"],
      ["array", ["3"]],
    ])("rejects %s", (_label, csat) => {
      expect(validateFeedbackInput({ csat })).toEqual({
        ok: false,
        error: "Please choose a rating from 1 to 5.",
      });
    });
  });

  describe("open-text answers (optional, 2000-char cap)", () => {
    it("trims answers and collapses blank or non-string values to null", () => {
      const result = validateFeedbackInput({
        csat: "3",
        valuable: "  the scan  ",
        improvement: "   ",
        wtp: 42,
      });
      expect(result).toEqual({
        ok: true,
        value: {
          csat: 3,
          valuable: "the scan",
          improvement: null,
          wtp: null,
          contactEmail: null,
        },
      });
    });

    it("keeps an answer of exactly 2000 chars intact", () => {
      const text = "a".repeat(2000);
      const result = validateFeedbackInput({ csat: "3", valuable: text });
      expect(result.ok && result.value.valuable).toBe(text);
    });

    it.each(["valuable", "improvement", "wtp"] as const)(
      "caps an over-length %s answer at 2000 chars (truncated, as ClearSignal does)",
      (field) => {
        const result = validateFeedbackInput({ csat: "3", [field]: "b".repeat(2500) });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value[field]).toBe("b".repeat(2000));
      },
    );
  });

  describe("contact email (optional, 320-char cap, lightly validated)", () => {
    it("accepts a plausible email, trimmed", () => {
      const result = validateFeedbackInput({ csat: "5", contactEmail: "  owner@shop.com " });
      expect(result.ok && result.value.contactEmail).toBe("owner@shop.com");
    });

    it("treats a blank email as no contact", () => {
      const result = validateFeedbackInput({ csat: "5", contactEmail: "   " });
      expect(result.ok && result.value.contactEmail).toBeNull();
    });

    it.each(["not-an-email", "a@b", "a b@c.com", "@shop.com", "owner@", "two@@shop.com"])(
      "rejects %j",
      (contactEmail) => {
        expect(validateFeedbackInput({ csat: "5", contactEmail })).toEqual({
          ok: false,
          error: "That email doesn't look right. Leave it blank to skip contact.",
        });
      },
    );

    it("accepts an email of exactly 320 chars", () => {
      const email = `${"a".repeat(320 - "@shop.com".length)}@shop.com`;
      expect(email).toHaveLength(320);
      expect(validateFeedbackInput({ csat: "5", contactEmail: email }).ok).toBe(true);
    });

    it("rejects (does not truncate) an email over 320 chars", () => {
      const email = `${"a".repeat(321 - "@shop.com".length)}@shop.com`;
      expect(email).toHaveLength(321);
      expect(validateFeedbackInput({ csat: "5", contactEmail: email }).ok).toBe(false);
    });

    it("reports the CSAT error first when both are invalid", () => {
      const result = validateFeedbackInput({ csat: "9", contactEmail: "nope" });
      expect(result).toEqual({ ok: false, error: "Please choose a rating from 1 to 5." });
    });
  });
});

// ---------------------------------------------------------------------------
// createFeedback
// ---------------------------------------------------------------------------

describe("createFeedback", () => {
  const SHOP = { id: "shop-1", domain: "merchant.myshopify.com" };
  const INPUT: FeedbackInput = {
    csat: 4,
    valuable: "Finds leftovers",
    improvement: "Faster scans",
    wtp: "Auto cleanup",
    contactEmail: "owner@shop.com",
  };
  const ROW = { id: "fb-1", shopId: SHOP.id, ...INPUT, createdAt: new Date() };

  beforeEach(() => {
    mockCreate.mockResolvedValue(ROW);
    mockRecordStage.mockResolvedValue(true);
    mockSendOpsAlert.mockResolvedValue({ sent: true });
  });

  it("persists the row, records `converted` (stamps feedbackSubmittedAt) and returns the row", async () => {
    await expect(createFeedback(SHOP, INPUT)).resolves.toBe(ROW);

    expect(mockCreate).toHaveBeenCalledWith("shop-1", INPUT);
    expect(mockRecordStage).toHaveBeenCalledTimes(1);
    expect(mockRecordStage).toHaveBeenCalledWith("feedback", "converted", SHOP.domain);
    // The row is written before the stage is claimed.
    expect(mockCreate.mock.invocationCallOrder[0]).toBeLessThan(
      mockRecordStage.mock.invocationCallOrder[0],
    );
  });

  it("emails the operator with the CSAT, domain and every field", async () => {
    await createFeedback(SHOP, INPUT);
    await flush();

    expect(mockSendOpsAlert).toHaveBeenCalledTimes(1);
    const [subject, body] = mockSendOpsAlert.mock.calls[0];
    expect(subject).toBe("New feedback: CSAT 4/5 from merchant.myshopify.com");
    for (const value of [
      "merchant.myshopify.com",
      "4/5",
      "Finds leftovers",
      "Faster scans",
      "Auto cleanup",
      "owner@shop.com",
    ]) {
      expect(body).toContain(value);
    }
  });

  it("does not fail the submit when the ops alert rejects", async () => {
    mockSendOpsAlert.mockRejectedValue(new Error("resend down"));

    await expect(createFeedback(SHOP, INPUT)).resolves.toBe(ROW);
    await flush();
    expect(mockLoggerError).toHaveBeenCalledWith(
      "feedback-ops-alert-failed",
      expect.objectContaining({ shop: SHOP.domain, error: "resend down" }),
    );
  });

  it("does not fail the submit when the ops alert throws synchronously", async () => {
    mockSendOpsAlert.mockImplementation(() => {
      throw new Error("boom");
    });

    await expect(createFeedback(SHOP, INPUT)).resolves.toBe(ROW);
    await flush();
    expect(mockLoggerError).toHaveBeenCalledWith(
      "feedback-ops-alert-failed",
      expect.objectContaining({ error: "boom" }),
    );
  });

  it("does not wait for a slow ops alert", async () => {
    mockSendOpsAlert.mockReturnValue(new Promise(() => {}));

    await expect(createFeedback(SHOP, INPUT)).resolves.toBe(ROW);
  });

  it("a repeat submission still persists but emits no second `converted` (claim lost)", async () => {
    mockRecordStage.mockResolvedValue(false);

    await expect(createFeedback(SHOP, INPUT)).resolves.toBe(ROW);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("propagates a failed row write and records nothing else", async () => {
    mockCreate.mockRejectedValue(new Error("db down"));

    await expect(createFeedback(SHOP, INPUT)).rejects.toThrow("db down");
    await flush();
    expect(mockRecordStage).not.toHaveBeenCalled();
    expect(mockSendOpsAlert).not.toHaveBeenCalled();
  });
});

describe("formatFeedbackEmail", () => {
  it("marks blank answers and a missing email explicitly", () => {
    const body = formatFeedbackEmail("s.myshopify.com", {
      csat: 1,
      valuable: null,
      improvement: null,
      wtp: null,
      contactEmail: null,
    });
    expect(body).toContain("CSAT: 1/5");
    expect(body.match(/\(no answer\)/g)).toHaveLength(3);
    expect(body).toContain("Contact: (merchant did not leave an email)");
  });
});

/**
 * Tests for app/services/feedback.server.ts (gc-3twe, was gc-97k.3): Help
 * message validation and createHelpMessage (persist with server-built bug
 * context, `converted` for topic feedback only, fire-and-forget support email).
 * The model writes, the scan lookup, the stage recorder and the support email
 * are mocked at their module boundaries.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../app/models/merchant-feedback.server", () => ({
  createMerchantFeedback: vi.fn(),
  countMerchantFeedbackSince: vi.fn(),
}));

vi.mock("../../app/models/scan.server", () => ({
  getScansForShop: vi.fn(),
}));

vi.mock("../../app/services/nudge-stage.server", () => ({
  recordNudgeStageOnce: vi.fn(),
}));

vi.mock("../../app/services/support-email.server", () => ({
  sendSupportEmail: vi.fn(),
}));

vi.mock("../../app/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { HELP_TOPICS } from "../../app/lib/help";
import { logger } from "../../app/lib/logger.server";
import {
  countMerchantFeedbackSince,
  createMerchantFeedback,
} from "../../app/models/merchant-feedback.server";
import { getScansForShop } from "../../app/models/scan.server";
import {
  buildBugContext,
  createHelpMessage,
  formatHelpEmail,
  HELP_ERRORS,
  HELP_MAX_MESSAGES_PER_DAY,
  isHelpRateLimited,
  validateHelpMessage,
} from "../../app/services/feedback.server";
import type { HelpMessage } from "../../app/services/feedback.server";
import { recordNudgeStageOnce } from "../../app/services/nudge-stage.server";
import { sendSupportEmail } from "../../app/services/support-email.server";

const mockCreate = createMerchantFeedback as ReturnType<typeof vi.fn>;
const mockGetScans = getScansForShop as ReturnType<typeof vi.fn>;
const mockRecordStage = recordNudgeStageOnce as ReturnType<typeof vi.fn>;
const mockSend = sendSupportEmail as ReturnType<typeof vi.fn>;
const mockLoggerError = logger.error as ReturnType<typeof vi.fn>;
const mockLoggerWarn = logger.warn as ReturnType<typeof vi.fn>;

/** Let queued microtasks (the fire-and-forget email chain) settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.resetAllMocks();
});

const valid = (overrides: Record<string, unknown> = {}) =>
  validateHelpMessage({ topic: "bug", message: "It broke", ...overrides });

// ---------------------------------------------------------------------------
// validateHelpMessage
// ---------------------------------------------------------------------------

describe("validateHelpMessage", () => {
  describe("topic (one of the five)", () => {
    it.each(HELP_TOPICS.map((t) => t.value))("accepts %s", (topic) => {
      const result = valid({ topic });
      expect(result.ok && result.value.topic).toBe(topic);
    });

    it.each([
      ["missing", undefined],
      ["null (field absent)", null],
      ["blank", ""],
      ["unknown", "sales"],
      ["case variant", "Bug"],
      ["label instead of value", "Something's broken"],
      ["number", 1],
    ])("rejects %s", (_label, topic) => {
      expect(valid({ topic })).toEqual({ ok: false, error: HELP_ERRORS.topic });
    });

    it("reports the topic error before a blank message", () => {
      expect(validateHelpMessage({ topic: "nope", message: "" })).toEqual({
        ok: false,
        error: HELP_ERRORS.topic,
      });
    });
  });

  describe("message (required, 2000-char cap)", () => {
    it.each([
      ["missing", undefined],
      ["null", null],
      ["blank", ""],
      ["whitespace", "   \n "],
      ["non-string", 42],
    ])("rejects a %s message", (_label, message) => {
      expect(valid({ message })).toEqual({ ok: false, error: HELP_ERRORS.message });
    });

    it("trims the message", () => {
      const result = valid({ message: "  the scan hangs \n" });
      expect(result.ok && result.value.message).toBe("the scan hangs");
    });

    it("keeps a message of exactly 2000 chars intact", () => {
      const text = "a".repeat(2000);
      const result = valid({ message: text });
      expect(result.ok && result.value.message).toBe(text);
    });

    it("truncates an over-length message to 2000 chars", () => {
      const result = valid({ message: "b".repeat(2500) });
      expect(result.ok && result.value.message).toBe("b".repeat(2000));
    });
  });

  describe("csat (topic feedback only, optional)", () => {
    it.each(["1", "3", "5", " 4 ", 2])("feedback: accepts %j", (csat) => {
      const result = valid({ topic: "feedback", csat });
      expect(result.ok && result.value.csat).toBe(Number(csat));
    });

    it.each([
      ["missing", undefined],
      ["null (no radio picked)", null],
      ["blank", ""],
      ["whitespace", "  "],
    ])("feedback: %s csat is fine and stored as null", (_label, csat) => {
      const result = valid({ topic: "feedback", csat });
      expect(result).toEqual({
        ok: true,
        value: { topic: "feedback", message: "It broke", csat: null, contactEmail: null },
      });
    });

    it.each([
      ["zero", "0"],
      ["six", "6"],
      ["negative", "-1"],
      ["non-integer", "3.5"],
      ["non-numeric", "great"],
      ["Infinity", "Infinity"],
      ["array", ["3"]],
    ])("feedback: rejects a %s csat", (_label, csat) => {
      expect(valid({ topic: "feedback", csat })).toEqual({ ok: false, error: HELP_ERRORS.csat });
    });

    it.each(["bug", "howto", "billing", "other"])(
      "%s: ignores any csat sent, valid or not",
      (topic) => {
        for (const csat of ["4", "9", "junk"]) {
          const result = valid({ topic, csat });
          expect(result.ok && result.value.csat).toBeNull();
        }
      },
    );
  });

  describe("contact email + consent (optional, as a pair)", () => {
    it("accepts an email with the box ticked, trimmed", () => {
      const result = valid({ contactEmail: "  owner@shop.com ", contactConsent: "on" });
      expect(result.ok && result.value.contactEmail).toBe("owner@shop.com");
    });

    it("accepts neither email nor consent", () => {
      const result = valid({ contactEmail: "", contactConsent: null });
      expect(result.ok && result.value.contactEmail).toBeNull();
    });

    it("rejects an email without consent", () => {
      expect(valid({ contactEmail: "owner@shop.com" })).toEqual({
        ok: false,
        error: "Tick the box so we can email you, or leave the email blank.",
      });
    });

    it.each([
      ["no email", undefined],
      ["blank email", ""],
      ["whitespace email", "   "],
    ])("rejects consent with %s", (_label, contactEmail) => {
      expect(valid({ contactEmail, contactConsent: "on" })).toEqual({
        ok: false,
        error: "Add your email so we can reply.",
      });
    });

    it.each(["yes", "true", "", "ON"])("treats contactConsent %j as not ticked", (consent) => {
      expect(valid({ contactEmail: "owner@shop.com", contactConsent: consent })).toEqual({
        ok: false,
        error: HELP_ERRORS.emailWithoutConsent,
      });
    });

    it.each(["not-an-email", "a@b", "a b@c.com", "@shop.com", "owner@", "two@@shop.com"])(
      "rejects %j (even with consent)",
      (contactEmail) => {
        expect(valid({ contactEmail, contactConsent: "on" })).toEqual({
          ok: false,
          error: "That email doesn't look right. Leave it blank to skip contact.",
        });
      },
    );

    it.each([
      ["comma (a second address)", "a@b.co,evil@x.co"],
      ["angle brackets", "Owner <a@b.co>"],
      ["less-than", "a<b@c.co"],
      ["greater-than", "a>b@c.co"],
      ["double quote", '"a"@b.co'],
      ["parentheses", "a(b)@c.co"],
      ["semicolon", "a@b.co;c@d.co"],
      ["colon", "mailto:a@b.co"],
      ["non-ASCII local part", "jos\u00e9@shop.com"],
      ["non-ASCII domain", "a@sh\u00f6p.com"],
      ["newline (header injection)", "a@b.co\nBcc: x@y.co"],
    ])("rejects an email with %s", (_label, contactEmail) => {
      expect(valid({ contactEmail, contactConsent: "on" })).toEqual({
        ok: false,
        error: HELP_ERRORS.email,
      });
    });

    it.each(["o'brien@shop.com", "first.last+tag@sub.shop.co.uk", "a_b-c@x-y.io"])(
      "still accepts the ordinary address %j",
      (contactEmail) => {
        expect(valid({ contactEmail, contactConsent: "on" }).ok).toBe(true);
      },
    );

    it("reports an invalid email before the missing consent", () => {
      expect(valid({ contactEmail: "nope" })).toEqual({ ok: false, error: HELP_ERRORS.email });
    });

    it("accepts an email of exactly 320 chars", () => {
      const email = `${"a".repeat(320 - "@shop.com".length)}@shop.com`;
      expect(email).toHaveLength(320);
      expect(valid({ contactEmail: email, contactConsent: "on" }).ok).toBe(true);
    });

    it("rejects (does not truncate) an email over 320 chars", () => {
      const email = `${"a".repeat(321 - "@shop.com".length)}@shop.com`;
      expect(email).toHaveLength(321);
      expect(valid({ contactEmail: email, contactConsent: "on" })).toEqual({
        ok: false,
        error: HELP_ERRORS.email,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// isHelpRateLimited
// ---------------------------------------------------------------------------

describe("isHelpRateLimited", () => {
  const mockCount = countMerchantFeedbackSince as ReturnType<typeof vi.fn>;
  const NOW = new Date("2026-10-27T12:00:00Z");

  it("counts the shop's messages over the rolling 24h before now", async () => {
    mockCount.mockResolvedValue(0);
    await isHelpRateLimited("shop-1", NOW);
    expect(mockCount).toHaveBeenCalledWith("shop-1", new Date("2026-10-26T12:00:00Z"));
  });

  it("allows up to the limit: 9 sent means the 10th is accepted", async () => {
    expect(HELP_MAX_MESSAGES_PER_DAY).toBe(10);
    mockCount.mockResolvedValue(9);
    await expect(isHelpRateLimited("shop-1", NOW)).resolves.toBe(false);
  });

  it.each([10, 11, 50])("refuses once %i were sent (the 11th and beyond)", async (sent) => {
    mockCount.mockResolvedValue(sent);
    await expect(isHelpRateLimited("shop-1", NOW)).resolves.toBe(true);
  });

  it("the refusal points to the support email", () => {
    expect(HELP_ERRORS.rateLimited).toBe(
      "You've sent several messages today. Email support@alpenglowsoftware.com and we'll pick it up there.",
    );
  });
});

// ---------------------------------------------------------------------------
// buildBugContext
// ---------------------------------------------------------------------------

describe("buildBugContext", () => {
  const SHOP = { id: "shop-1", domain: "m.myshopify.com", plan: "Standard" };

  it("names the plan and the latest scan of any status (one-row lookup)", async () => {
    mockGetScans.mockResolvedValue({ items: [{ id: "scan-9" }], hasNextPage: true });
    await expect(buildBugContext(SHOP)).resolves.toBe("plan=Standard; latestScan=scan-9");
    expect(mockGetScans).toHaveBeenCalledWith("shop-1", { limit: 1 });
  });

  it("says none when the shop has no scans", async () => {
    mockGetScans.mockResolvedValue({ items: [], hasNextPage: false });
    await expect(buildBugContext(SHOP)).resolves.toBe("plan=Standard; latestScan=none");
  });

  it("says unavailable (and logs) when the lookup fails, instead of throwing", async () => {
    mockGetScans.mockRejectedValue(new Error("db down"));
    await expect(buildBugContext(SHOP)).resolves.toBe("plan=Standard; latestScan=unavailable");
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "help-context-scan-lookup-failed",
      expect.objectContaining({ shop: SHOP.domain }),
    );
  });
});

// ---------------------------------------------------------------------------
// createHelpMessage
// ---------------------------------------------------------------------------

describe("createHelpMessage", () => {
  const SHOP = { id: "shop-1", domain: "merchant.myshopify.com", plan: "free" };
  const BUG: HelpMessage = {
    topic: "bug",
    message: "Scan stuck at 50%",
    csat: null,
    contactEmail: "owner@shop.com",
  };
  const FEEDBACK: HelpMessage = {
    topic: "feedback",
    message: "Love it",
    csat: 5,
    contactEmail: null,
  };
  const ROW = { id: "fb-1" };

  beforeEach(() => {
    mockCreate.mockResolvedValue(ROW);
    mockRecordStage.mockResolvedValue(true);
    mockSend.mockResolvedValue({ sent: true, reason: "sent" });
    mockGetScans.mockResolvedValue({ items: [{ id: "scan-7" }], hasNextPage: false });
  });

  it("bug: persists with server-built context and the consent stamp, records no `converted`", async () => {
    await expect(createHelpMessage(SHOP, BUG)).resolves.toBe(ROW);

    expect(mockCreate).toHaveBeenCalledWith("shop-1", {
      topic: "bug",
      message: "Scan stuck at 50%",
      csat: null,
      contactEmail: "owner@shop.com",
      contactConsentAt: expect.any(Date),
      context: "plan=free; latestScan=scan-7",
    });
    expect(mockRecordStage).not.toHaveBeenCalled();
  });

  it.each(["howto", "billing", "other"] as const)(
    "%s: no context, no scan lookup, no `converted`",
    async (topic) => {
      await createHelpMessage(SHOP, { ...BUG, topic });

      expect(mockGetScans).not.toHaveBeenCalled();
      expect(mockCreate).toHaveBeenCalledWith(
        "shop-1",
        expect.objectContaining({ topic, context: null }),
      );
      expect(mockRecordStage).not.toHaveBeenCalled();
    },
  );

  it("feedback: persists csat, no context, records `converted` after the row write", async () => {
    await createHelpMessage(SHOP, FEEDBACK);

    expect(mockCreate).toHaveBeenCalledWith("shop-1", {
      topic: "feedback",
      message: "Love it",
      csat: 5,
      contactEmail: null,
      contactConsentAt: null,
      context: null,
    });
    expect(mockRecordStage).toHaveBeenCalledExactlyOnceWith("feedback", "converted", SHOP.domain);
    expect(mockCreate.mock.invocationCallOrder[0]).toBeLessThan(
      mockRecordStage.mock.invocationCallOrder[0],
    );
  });

  it("stores contactConsentAt only together with an email", async () => {
    await createHelpMessage(SHOP, { ...BUG, contactEmail: null });
    expect(mockCreate).toHaveBeenCalledWith(
      "shop-1",
      expect.objectContaining({ contactEmail: null, contactConsentAt: null }),
    );
  });

  it("emails the support inbox with the topic label, shop and the consented reply-to", async () => {
    await createHelpMessage(SHOP, BUG);
    await flush();

    expect(mockSend).toHaveBeenCalledTimes(1);
    const [{ subject, text, replyTo, shopDomain, topic }] = mockSend.mock.calls[0];
    expect(shopDomain).toBe(SHOP.domain);
    expect(topic).toBe("bug");
    expect(subject).toBe("GhostCode help: Something's broken from merchant.myshopify.com");
    expect(replyTo).toBe("owner@shop.com");
    expect(text).toContain("Reply to: owner@shop.com");
    expect(text).toContain("Context: plan=free; latestScan=scan-7");
    expect(text).toContain("Scan stuck at 50%");
  });

  it("without an email (no consent): no reply-to, no address anywhere", async () => {
    await createHelpMessage(SHOP, FEEDBACK);
    await flush();

    const [{ subject, text, replyTo }] = mockSend.mock.calls[0];
    expect(subject).toBe("GhostCode help: Idea or feedback from merchant.myshopify.com");
    expect(replyTo).toBeNull();
    expect(text).not.toContain("@");
    expect(text).toContain("CSAT: 5/5");
  });

  it("does not fail the submit when the support email rejects", async () => {
    mockSend.mockRejectedValue(new Error("resend down"));

    await expect(createHelpMessage(SHOP, BUG)).resolves.toBe(ROW);
    await flush();
    expect(mockLoggerError).toHaveBeenCalledWith(
      "help-support-email-failed",
      expect.objectContaining({ shop: SHOP.domain, errorName: "Error" }),
    );
  });

  it("does not fail the submit when the support email throws synchronously", async () => {
    mockSend.mockImplementation(() => {
      throw new Error("boom");
    });

    await expect(createHelpMessage(SHOP, BUG)).resolves.toBe(ROW);
    await flush();
    expect(mockLoggerError).toHaveBeenCalledWith("help-support-email-failed", expect.anything());
  });

  it("does not wait for a slow support email", async () => {
    mockSend.mockReturnValue(new Promise(() => {}));

    await expect(createHelpMessage(SHOP, BUG)).resolves.toBe(ROW);
  });

  it("a repeat feedback message still persists but emits no second `converted` (claim lost)", async () => {
    mockRecordStage.mockResolvedValue(false);

    await expect(createHelpMessage(SHOP, FEEDBACK)).resolves.toBe(ROW);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("propagates a failed row write and records or sends nothing else", async () => {
    mockCreate.mockRejectedValue(new Error("db down"));

    await expect(createHelpMessage(SHOP, FEEDBACK)).rejects.toThrow("db down");
    await flush();
    expect(mockRecordStage).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("formatHelpEmail", () => {
  it("carries the Reply-to address only when one was given (given = consented)", () => {
    const withEmail = formatHelpEmail(
      "s.myshopify.com",
      { topic: "howto", message: "How?", csat: null, contactEmail: "a@b.co" },
      null,
    );
    expect(withEmail).toContain("Reply to: a@b.co");

    const without = formatHelpEmail(
      "s.myshopify.com",
      { topic: "howto", message: "How?", csat: null, contactEmail: null },
      null,
    );
    expect(without).toContain("Reply to: (no email given; no reply wanted)");
    expect(without).not.toContain("a@b.co");
  });

  it("omits the CSAT and Context lines when absent", () => {
    const body = formatHelpEmail(
      "s.myshopify.com",
      { topic: "billing", message: "Charged twice", csat: null, contactEmail: null },
      null,
    );
    expect(body).toContain("Topic: Billing");
    expect(body).not.toContain("CSAT");
    expect(body).not.toContain("Context");
    expect(body).toContain("Charged twice");
  });
});

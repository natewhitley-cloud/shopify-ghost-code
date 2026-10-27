/**
 * Tests for app/routes/app.help.tsx (gc-3twe; was the gc-97k.3 feedback
 * survey route).
 *
 * Strategy:
 *   - Mock authenticate.admin() and the shop model.
 *   - validateHelpMessage is the REAL validator (only createHelpMessage is
 *     mocked), so the action is tested end to end through validation. A second
 *     block runs the REAL createHelpMessage (models mocked) to prove the
 *     context is built server-side and `converted` is feedback-only.
 *   - The page and the success state are rendered to static markup.
 */
import { renderToStaticMarkup } from "react-dom/server";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { createRoutesStub, MemoryRouter } from "react-router";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: vi.fn() },
}));

vi.mock("../../app/models/shop.server", () => ({
  getShopMetadata: vi.fn(),
}));

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

vi.mock("../../app/services/feedback.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/feedback.server")>();
  return { ...actual, createHelpMessage: vi.fn(actual.createHelpMessage) };
});

import { APP_STORE_REVIEW_URL, FEEDBACK_THANKS_COPY } from "../../app/lib/feedback-nudge";
import { HELP_COPY, HELP_GUIDES, SUPPORT_EMAIL } from "../../app/lib/help";
import {
  countMerchantFeedbackSince,
  createMerchantFeedback,
} from "../../app/models/merchant-feedback.server";
import { getScansForShop } from "../../app/models/scan.server";
import { getShopMetadata } from "../../app/models/shop.server";
import HelpPage, { action, HelpSent, loader } from "../../app/routes/app.help";
import { createHelpMessage } from "../../app/services/feedback.server";
import { recordNudgeStageOnce } from "../../app/services/nudge-stage.server";
import { sendSupportEmail } from "../../app/services/support-email.server";
import { authenticate } from "../../app/shopify.server";

const mockAuthenticateAdmin = authenticate.admin as ReturnType<typeof vi.fn>;
const mockGetShopMetadata = getShopMetadata as ReturnType<typeof vi.fn>;
const mockRecordStage = recordNudgeStageOnce as ReturnType<typeof vi.fn>;
const mockCreateHelp = createHelpMessage as ReturnType<typeof vi.fn>;
const mockCreateRow = createMerchantFeedback as ReturnType<typeof vi.fn>;
const mockGetScans = getScansForShop as ReturnType<typeof vi.fn>;
const mockSend = sendSupportEmail as ReturnType<typeof vi.fn>;
const mockCount = countMerchantFeedbackSince as ReturnType<typeof vi.fn>;

const DOMAIN = "merchant.myshopify.com";
const SHOP = { id: "shop-1", domain: DOMAIN, plan: "Standard" };

function loaderArgs(search: string): LoaderFunctionArgs {
  return {
    request: new Request(`https://app.example.com/app/help${search}`),
    params: {},
    context: {},
  } as LoaderFunctionArgs;
}

function actionArgs(fields: Record<string, string>): ActionFunctionArgs {
  return {
    request: new Request("https://app.example.com/app/help", {
      method: "POST",
      body: new URLSearchParams(fields),
    }),
    params: {},
    context: {},
  } as ActionFunctionArgs;
}

function renderPage(initialTopic: string): string {
  const Stub = createRoutesStub([
    { id: "help", path: "/app/help", Component: HelpPage as never, loader: () => null },
  ]);
  return renderToStaticMarkup(
    <Stub
      initialEntries={["/app/help"]}
      hydrationData={{ loaderData: { help: { initialTopic } } }}
    />,
  );
}

const esc = (s: string) => s.replace(/'/g, "&#x27;");

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticateAdmin.mockResolvedValue({ session: { shop: DOMAIN } });
  mockGetShopMetadata.mockResolvedValue(SHOP);
  mockRecordStage.mockResolvedValue(true);
  mockCreateRow.mockResolvedValue({ id: "fb-1" });
  mockGetScans.mockResolvedValue({ items: [{ id: "scan-42" }], hasNextPage: false });
  mockSend.mockResolvedValue({ sent: true, reason: "sent" });
  mockCount.mockResolvedValue(0);
});

// ---------------------------------------------------------------------------
// Loader: the nudge click and the preselected topic
// ---------------------------------------------------------------------------

describe("app.help loader", () => {
  it("records the feedback `clicked` stage with the session shop when src=nudge", async () => {
    const data = await loader(loaderArgs("?topic=feedback&src=nudge"));

    expect(mockRecordStage).toHaveBeenCalledExactlyOnceWith("feedback", "clicked", DOMAIN);
    expect(data).toEqual({ initialTopic: "feedback" });
  });

  it.each([
    ["no src", ""],
    ["another src", "?src=upgrade_preview"],
    ["empty src", "?src="],
    ["case variant", "?src=Nudge"],
    ["topic only", "?topic=feedback"],
  ])("does not count a click with %s", async (_label, search) => {
    await loader(loaderArgs(search));

    expect(mockRecordStage).not.toHaveBeenCalled();
  });

  it.each([
    ["", "bug"],
    ["?topic=howto", "howto"],
    ["?topic=billing", "billing"],
    ["?topic=other", "other"],
    ["?topic=bogus", "bug"],
    ["?topic=", "bug"],
    ["?topic=Feedback", "bug"],
  ])("preselects from %j: %s", async (search, initialTopic) => {
    await expect(loader(loaderArgs(search))).resolves.toEqual({ initialTopic });
  });

  it("requires an authenticated admin session", async () => {
    mockAuthenticateAdmin.mockRejectedValue(new Response(null, { status: 401 }));

    await expect(loader(loaderArgs("?src=nudge"))).rejects.toBeInstanceOf(Response);
    expect(mockRecordStage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Action: validate, persist (real service, models mocked)
// ---------------------------------------------------------------------------

describe("app.help action", () => {
  it("persists a bug report with server-built context and returns the reply-to", async () => {
    const result = await action(
      actionArgs({
        topic: "bug",
        message: "Scan stuck",
        contactEmail: "owner@shop.com",
        contactConsent: "on",
      }),
    );

    expect(result).toEqual({ ok: true, topic: "bug", replyTo: "owner@shop.com" });
    expect(mockCreateRow).toHaveBeenCalledWith("shop-1", {
      topic: "bug",
      message: "Scan stuck",
      csat: null,
      contactEmail: "owner@shop.com",
      contactConsentAt: expect.any(Date),
      context: "plan=Standard; latestScan=scan-42",
    });
    expect(mockRecordStage).not.toHaveBeenCalled();
  });

  it("never takes context (or csat) from the client", async () => {
    await action(
      actionArgs({
        topic: "bug",
        message: "Scan stuck",
        context: "plan=Professional; latestScan=forged",
        csat: "5",
      }),
    );

    expect(mockCreateRow).toHaveBeenCalledWith(
      "shop-1",
      expect.objectContaining({ context: "plan=Standard; latestScan=scan-42", csat: null }),
    );
  });

  it.each(["howto", "billing", "other"])(
    "%s: no context attached and no `converted`",
    async (topic) => {
      const result = await action(
        actionArgs({ topic, message: "Q", context: "plan=x; latestScan=y" }),
      );

      expect(result).toEqual({ ok: true, topic, replyTo: null });
      expect(mockCreateRow).toHaveBeenCalledWith(
        "shop-1",
        expect.objectContaining({ topic, context: null }),
      );
      expect(mockGetScans).not.toHaveBeenCalled();
      expect(mockRecordStage).not.toHaveBeenCalled();
    },
  );

  it("feedback: records `converted` once, with an optional rating", async () => {
    const result = await action(actionArgs({ topic: "feedback", message: "Great", csat: "4" }));

    expect(result).toEqual({ ok: true, topic: "feedback", replyTo: null });
    expect(mockCreateRow).toHaveBeenCalledWith(
      "shop-1",
      expect.objectContaining({ topic: "feedback", csat: 4, context: null }),
    );
    expect(mockRecordStage).toHaveBeenCalledExactlyOnceWith("feedback", "converted", DOMAIN);
  });

  it("feedback without a rating succeeds", async () => {
    const result = await action(actionArgs({ topic: "feedback", message: "Great" }));
    expect(result).toEqual({ ok: true, topic: "feedback", replyTo: null });
  });

  it("uses the SESSION shop for the row, the context and the email subject", async () => {
    await action(actionArgs({ topic: "bug", message: "x", shop: "evil.myshopify.com" }));

    expect(mockCreateHelp).toHaveBeenCalledWith(
      { id: "shop-1", domain: DOMAIN, plan: "Standard" },
      expect.anything(),
    );
  });

  it.each([
    ["unknown topic", { topic: "sales", message: "x" }],
    ["blank message", { topic: "bug", message: "   " }],
    ["out-of-range csat on feedback", { topic: "feedback", message: "x", csat: "9" }],
    ["email without consent", { topic: "bug", message: "x", contactEmail: "a@b.co" }],
    ["consent without email", { topic: "bug", message: "x", contactConsent: "on" }],
    ["invalid email", { topic: "bug", message: "x", contactEmail: "nope", contactConsent: "on" }],
  ])("rejects %s without persisting", async (_label, fields) => {
    const result = await action(actionArgs(fields as Record<string, string>));

    expect(result.ok).toBe(false);
    expect(mockCreateHelp).not.toHaveBeenCalled();
    expect(mockCreateRow).not.toHaveBeenCalled();
  });

  describe("per-shop limit: 10 messages per rolling 24h", () => {
    const LIMIT_ERROR =
      "You've sent several messages today. Email support@alpenglowsoftware.com and we'll pick it up there.";

    it("the 10th message (9 already sent) is accepted and emailed", async () => {
      mockCount.mockResolvedValue(9);

      const result = await action(actionArgs({ topic: "bug", message: "x" }));

      expect(result.ok).toBe(true);
      expect(mockCount).toHaveBeenCalledWith("shop-1", expect.any(Date));
      expect(mockCreateRow).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));
    });

    it("the 11th message (10 already sent) is refused: no row, no email", async () => {
      mockCount.mockResolvedValue(10);

      const result = await action(actionArgs({ topic: "bug", message: "x" }));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(result).toEqual({ ok: false, error: LIMIT_ERROR });
      expect(mockCreateHelp).not.toHaveBeenCalled();
      expect(mockCreateRow).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalled();
      expect(mockRecordStage).not.toHaveBeenCalled();
    });

    it("counts per shop: the session shop's id", async () => {
      await action(actionArgs({ topic: "bug", message: "x" }));
      expect(mockCount.mock.calls[0][0]).toBe("shop-1");
      const since = mockCount.mock.calls[0][1] as Date;
      expect(Date.now() - since.getTime()).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 1000);
      expect(Date.now() - since.getTime()).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 1000);
    });

    it("an invalid message is reported first and does not need the count", async () => {
      mockCount.mockResolvedValue(10);
      const result = await action(actionArgs({ topic: "bug", message: " " }));
      expect(result).toEqual({ ok: false, error: "Please write a message." });
    });
  });

  it("returns an error and persists nothing when the shop row is missing", async () => {
    mockGetShopMetadata.mockResolvedValue(null);

    const result = await action(actionArgs({ topic: "bug", message: "x" }));

    expect(result).toEqual({ ok: false, error: "Shop not found. Please reinstall the app." });
    expect(mockCreateRow).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Page: the form per topic
// ---------------------------------------------------------------------------

describe("HelpPage (form)", () => {
  it("renders the heading, intro, the five topics with the preselected one, and the shared fields", () => {
    const html = renderPage("bug");

    expect(html).toContain('heading="Help"');
    expect(html).toContain(HELP_COPY.intro);
    expect(html).toMatch(/<option value="bug" selected="">Something&#x27;s broken<\/option>/);
    for (const v of ["howto", "feedback", "billing", "other"]) {
      expect(html).toContain(`<option value="${v}"`);
    }
    expect(html).toContain(HELP_COPY.emailLabel);
    expect(html).toContain(HELP_COPY.emailHint);
    // The hint is the email input's description.
    expect(html).toMatch(/id="help-email"[^>]*aria-describedby="help-email-hint"/);
    expect(html).toContain(`<span id="help-email-hint"`);
    // Idle: Send is enabled.
    expect(html).not.toMatch(/<s-button type="submit"[^>]*disabled/);
    expect(html).toContain('name="contactConsent"');
    expect(html).toContain(HELP_COPY.consentLabel);
    expect(html).toMatch(/<s-button type="submit"[^>]*>Send<\/s-button>/);
  });

  it("bug: label, placeholder and the context note; no rating", () => {
    const html = renderPage("bug");

    expect(html).toContain("What happened?");
    expect(html).toContain(
      'placeholder="What you did, what you expected, and what happened instead."',
    );
    expect(html).toContain(esc(HELP_COPY.bugContextNote));
    expect(html).not.toContain('name="csat"');
  });

  it("feedback: the optional rating sits BELOW the message box; no context note", () => {
    const html = renderPage("feedback");

    expect(html).toContain("Your idea or feedback");
    expect(html).toContain(esc("placeholder=\"What's working, what isn't, what you'd add.\""));
    expect(html).toContain(HELP_COPY.csatLegend);
    expect(html.indexOf('name="message"')).toBeLessThan(html.indexOf('name="csat"'));
    expect(html).not.toMatch(/name="csat"[^>]*required/);
    expect(html).not.toContain(esc(HELP_COPY.bugContextNote));
  });

  it.each(["howto", "billing", "other"])("%s: generic label, no placeholder", (topic) => {
    const html = renderPage(topic);

    expect(html).toContain("Your message");
    expect(html).not.toMatch(/<textarea[^>]*placeholder=/);
    expect(html).not.toContain('name="csat"');
    expect(html).not.toContain(esc(HELP_COPY.bugContextNote));
  });

  it("lists the other ways to get help: the support email and the guides", () => {
    const html = renderPage("bug");

    expect(html).toContain(`heading="${HELP_COPY.otherWaysHeading}"`);
    expect(html).toContain(`href="mailto:${SUPPORT_EMAIL}"`);
    for (const g of HELP_GUIDES) {
      expect(html).toContain(`href="${g.url}"`);
      expect(html).toContain(esc(g.label));
    }
  });
});

// ---------------------------------------------------------------------------
// Success state: the neutral review ask (feedback only)
// ---------------------------------------------------------------------------

describe("HelpSent (success state)", () => {
  const render = (topic: "bug" | "feedback" | "howto", replyTo: string | null) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <HelpSent topic={topic} replyTo={replyTo} onReset={() => {}} />
      </MemoryRouter>,
    );

  it("names the reply address when an email was given", () => {
    const html = render("bug", "owner@shop.com");
    expect(html).toContain('heading="Message sent"');
    expect(html).toContain("Thanks. We&#x27;ll reply to owner@shop.com.");
    expect(html).toContain(HELP_COPY.sendAnother);
  });

  it("without an email: we read every message", () => {
    expect(render("howto", null)).toContain("Thanks. We read every message.");
  });

  it("feedback: shows the neutral review ask with a new-tab App Store link and a way to skip", () => {
    const html = render("feedback", null);
    expect(html).toContain(esc(FEEDBACK_THANKS_COPY.body));
    expect(html).toContain(`href="${APP_STORE_REVIEW_URL}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain(FEEDBACK_THANKS_COPY.reviewCta);
    expect(html).toContain(`>${FEEDBACK_THANKS_COPY.skip}</a>`);
  });

  it("feedback: thanks once (the banner), never again in the review ask", () => {
    for (const replyTo of [null, "owner@shop.com"]) {
      const html = render("feedback", replyTo);
      expect(html.match(/Thanks/g)).toHaveLength(1);
    }
    expect(FEEDBACK_THANKS_COPY.body).toBe(
      "Reviews on the Shopify App Store help other merchants decide. Let us know how we're doing there too.",
    );
  });

  it.each(["bug", "howto"] as const)("%s: no review ask", (topic) => {
    const html = render(topic, null);
    expect(html).not.toContain(APP_STORE_REVIEW_URL);
    expect(html).not.toContain(FEEDBACK_THANKS_COPY.reviewCta);
  });

  it("is identical whatever the rating: the action's result carries no CSAT", async () => {
    const shown: string[] = [];
    for (const csat of ["1", "5", ""]) {
      const result = await action(actionArgs({ topic: "feedback", message: "x", csat }));
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result).not.toHaveProperty("csat");
      shown.push(render(result.topic as "feedback", result.replyTo));
    }
    expect(new Set(shown).size).toBe(1);
    expect(shown[0]).toContain(APP_STORE_REVIEW_URL);
  });
});

/**
 * Tests for app/routes/app.feedback.tsx (gc-97k.3): the feedback survey route.
 *
 * Strategy:
 *   - Mock authenticate.admin() and the shop model.
 *   - validateFeedbackInput is the REAL validator (only createFeedback is
 *     mocked), so the action is tested end to end through validation.
 *   - The success-state component is rendered to static markup to prove the
 *     neutral review ask is identical whatever the rating.
 */
import { renderToStaticMarkup } from "react-dom/server";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { MemoryRouter } from "react-router";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: vi.fn() },
}));

vi.mock("../../app/models/shop.server", () => ({
  getShopMetadata: vi.fn(),
  dismissReviewPrompt: vi.fn(),
}));

vi.mock("../../app/services/nudge-stage.server", () => ({
  recordNudgeStageOnce: vi.fn(),
}));

vi.mock("../../app/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../app/services/feedback.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/feedback.server")>();
  return { ...actual, createFeedback: vi.fn() };
});

import { APP_STORE_REVIEW_URL, FEEDBACK_THANKS_COPY } from "../../app/lib/feedback-nudge";
import { logger } from "../../app/lib/logger.server";
import { dismissReviewPrompt, getShopMetadata } from "../../app/models/shop.server";
import { action, FeedbackThanks, loader } from "../../app/routes/app.feedback";
import { createFeedback } from "../../app/services/feedback.server";
import { recordNudgeStageOnce } from "../../app/services/nudge-stage.server";
import { authenticate } from "../../app/shopify.server";

const mockAuthenticateAdmin = authenticate.admin as ReturnType<typeof vi.fn>;
const mockGetShopMetadata = getShopMetadata as ReturnType<typeof vi.fn>;
const mockDismissReviewPrompt = dismissReviewPrompt as ReturnType<typeof vi.fn>;
const mockRecordStage = recordNudgeStageOnce as ReturnType<typeof vi.fn>;
const mockCreateFeedback = createFeedback as ReturnType<typeof vi.fn>;

const DOMAIN = "merchant.myshopify.com";
const SHOP = { id: "shop-1", domain: DOMAIN, plan: "free", hasSeenReviewPrompt: false };

function loaderArgs(search: string): LoaderFunctionArgs {
  return {
    request: new Request(`https://app.example.com/app/feedback${search}`),
    params: {},
    context: {},
  } as LoaderFunctionArgs;
}

function actionArgs(fields: Record<string, string>): ActionFunctionArgs {
  return {
    request: new Request("https://app.example.com/app/feedback", {
      method: "POST",
      body: new URLSearchParams(fields),
    }),
    params: {},
    context: {},
  } as ActionFunctionArgs;
}

beforeEach(() => {
  vi.resetAllMocks();
  mockAuthenticateAdmin.mockResolvedValue({ session: { shop: DOMAIN } });
  mockGetShopMetadata.mockResolvedValue(SHOP);
  mockRecordStage.mockResolvedValue(true);
  mockCreateFeedback.mockResolvedValue({ id: "fb-1" });
  mockDismissReviewPrompt.mockResolvedValue({ id: "shop-1" });
});

// ---------------------------------------------------------------------------
// Loader: the nudge click
// ---------------------------------------------------------------------------

describe("app.feedback loader", () => {
  it("records the feedback `clicked` stage with the session shop when src=nudge", async () => {
    await loader(loaderArgs("?src=nudge"));

    expect(mockRecordStage).toHaveBeenCalledTimes(1);
    expect(mockRecordStage).toHaveBeenCalledWith("feedback", "clicked", DOMAIN);
  });

  it.each([
    ["no src", ""],
    ["another src", "?src=upgrade_preview"],
    ["empty src", "?src="],
    ["case variant", "?src=Nudge"],
  ])("does not count a click with %s", async (_label, search) => {
    await loader(loaderArgs(search));

    expect(mockRecordStage).not.toHaveBeenCalled();
  });

  it("requires an authenticated admin session", async () => {
    mockAuthenticateAdmin.mockRejectedValue(new Response(null, { status: 401 }));

    await expect(loader(loaderArgs("?src=nudge"))).rejects.toBeInstanceOf(Response);
    expect(mockRecordStage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Action: validate, persist, mark the review prompt seen
// ---------------------------------------------------------------------------

describe("app.feedback action", () => {
  const FULL = {
    csat: "4",
    valuable: "Finds leftovers",
    improvement: "Faster scans",
    wtp: "Auto cleanup",
    contactEmail: "owner@shop.com",
  };

  it("persists a valid submission for the session shop and returns ok", async () => {
    const result = await action(actionArgs(FULL));

    expect(result).toEqual({ ok: true });
    expect(mockCreateFeedback).toHaveBeenCalledWith(
      { id: "shop-1", domain: DOMAIN },
      {
        csat: 4,
        valuable: "Finds leftovers",
        improvement: "Faster scans",
        wtp: "Auto cleanup",
        contactEmail: "owner@shop.com",
      },
    );
  });

  it("accepts a CSAT-only submission (every other field optional)", async () => {
    const result = await action(actionArgs({ csat: "3" }));

    expect(result).toEqual({ ok: true });
    expect(mockCreateFeedback).toHaveBeenCalledWith(
      { id: "shop-1", domain: DOMAIN },
      { csat: 3, valuable: null, improvement: null, wtp: null, contactEmail: null },
    );
  });

  // Proves there is no sentiment gating: the lowest and highest ratings get the
  // same outcome, and both retire the separate review banner.
  it.each(["1", "5"])("CSAT %s: succeeds and sets hasSeenReviewPrompt", async (csat) => {
    const result = await action(actionArgs({ csat }));

    expect(result).toEqual({ ok: true });
    expect(mockDismissReviewPrompt).toHaveBeenCalledTimes(1);
    expect(mockDismissReviewPrompt).toHaveBeenCalledWith("shop-1");
  });

  it("skips the hasSeenReviewPrompt write when it is already set", async () => {
    mockGetShopMetadata.mockResolvedValue({ ...SHOP, hasSeenReviewPrompt: true });

    await expect(action(actionArgs({ csat: "2" }))).resolves.toEqual({ ok: true });
    expect(mockDismissReviewPrompt).not.toHaveBeenCalled();
  });

  it("still succeeds when marking the review prompt seen fails (feedback already saved)", async () => {
    mockDismissReviewPrompt.mockRejectedValue(new Error("db blip"));

    await expect(action(actionArgs({ csat: "5" }))).resolves.toEqual({ ok: true });
    expect(logger.error).toHaveBeenCalledWith(
      "feedback-mark-review-seen-failed",
      expect.objectContaining({ shop: DOMAIN, error: "db blip" }),
    );
  });

  it.each([
    ["missing CSAT", { valuable: "x" }],
    ["CSAT 0", { csat: "0" }],
    ["CSAT 6", { csat: "6" }],
    ["non-integer CSAT", { csat: "2.5" }],
    ["invalid email", { csat: "4", contactEmail: "nope" }],
    ["over-length email", { csat: "4", contactEmail: `${"a".repeat(320)}@x.co` }],
  ])("rejects %s without persisting or touching the review prompt", async (_label, fields) => {
    const result = await action(actionArgs(fields as Record<string, string>));

    expect(result.ok).toBe(false);
    expect(mockCreateFeedback).not.toHaveBeenCalled();
    expect(mockDismissReviewPrompt).not.toHaveBeenCalled();
  });

  it("returns an error and persists nothing when the shop row is missing", async () => {
    mockGetShopMetadata.mockResolvedValue(null);

    const result = await action(actionArgs({ csat: "4" }));

    expect(result).toEqual({ ok: false, error: "Shop not found. Please reinstall the app." });
    expect(mockCreateFeedback).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Success state: the neutral review ask
// ---------------------------------------------------------------------------

describe("FeedbackThanks (success state)", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <FeedbackThanks />
    </MemoryRouter>,
  );

  it("shows the neutral review ask with a new-tab App Store link and a way to skip", () => {
    expect(html).toContain(FEEDBACK_THANKS_COPY.body.replace(/'/g, "&#x27;"));
    expect(html).toContain(`href="${APP_STORE_REVIEW_URL}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain(FEEDBACK_THANKS_COPY.reviewCta);
    expect(html).toContain(`>${FEEDBACK_THANKS_COPY.skip}</a>`);
  });

  it("takes no rating, so the ask cannot vary by CSAT", () => {
    expect(FeedbackThanks.length).toBe(0);
  });
});

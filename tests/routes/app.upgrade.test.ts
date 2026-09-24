/**
 * Tests for app/routes/app.upgrade.tsx (gc-97k.4): the upgrade-preview CTA's
 * click-recording resource route.
 *
 * Strategy:
 *   - Mock authenticate.admin() to control the session and capture the admin
 *     `redirect` helper (the library helper that performs the top-level,
 *     iframe-escaping redirect).
 *   - Mock the once-per-merchant stage recorder; its dedupe is covered in
 *     tests/services/upgrade-preview-nudge.server.test.ts.
 *   - buildPricingPlansUrl is the REAL helper Settings uses, so the destination
 *     is asserted as a literal URL.
 */
import type { LoaderFunctionArgs } from "react-router";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: vi.fn() },
}));

vi.mock("../../app/services/upgrade-preview-nudge.server", () => ({
  recordUpgradePreviewStageOnce: vi.fn(),
}));

import { loader } from "../../app/routes/app.upgrade";
import { recordUpgradePreviewStageOnce } from "../../app/services/upgrade-preview-nudge.server";
import { authenticate } from "../../app/shopify.server";

const mockAuthenticateAdmin = authenticate.admin as ReturnType<typeof vi.fn>;
const mockRecordStage = recordUpgradePreviewStageOnce as ReturnType<typeof vi.fn>;
const mockRedirect = vi.fn();

const SHOP = "nw-dev-store-2.myshopify.com";
const PRICING_URL =
  "https://admin.shopify.com/store/nw-dev-store-2/charges/ghost-code/pricing_plans";
const REDIRECT_RESPONSE = new Response(null, { status: 302 });

function args(search: string): LoaderFunctionArgs {
  return {
    request: new Request(`https://app.example.com/app/upgrade${search}`),
    params: {},
    context: {},
  } as LoaderFunctionArgs;
}

beforeEach(() => {
  vi.resetAllMocks();
  mockAuthenticateAdmin.mockResolvedValue({ session: { shop: SHOP }, redirect: mockRedirect });
  mockRecordStage.mockResolvedValue(true);
  mockRedirect.mockReturnValue(REDIRECT_RESPONSE);
});

describe("app.upgrade loader", () => {
  it("records the upgrade-preview click with the unmodified session shop", async () => {
    await loader(args("?src=upgrade_preview"));

    expect(mockRecordStage).toHaveBeenCalledTimes(1);
    expect(mockRecordStage).toHaveBeenCalledWith("clicked", SHOP);
  });

  it("top-level redirects to the Managed Pricing plan page for the session's store", async () => {
    const result = await loader(args("?src=upgrade_preview"));

    expect(mockRedirect).toHaveBeenCalledTimes(1);
    expect(mockRedirect).toHaveBeenCalledWith(PRICING_URL, { target: "_top" });
    expect(result).toBe(REDIRECT_RESPONSE);
  });

  it("records the click before redirecting (the redirect may throw for embedded requests)", async () => {
    const order: string[] = [];
    mockRecordStage.mockImplementation(async () => {
      order.push("record");
      return true;
    });
    mockRedirect.mockImplementation(() => {
      order.push("redirect");
      throw REDIRECT_RESPONSE;
    });

    await expect(loader(args("?src=upgrade_preview"))).rejects.toBe(REDIRECT_RESPONSE);
    expect(order).toEqual(["record", "redirect"]);
  });

  it("does not record without src, but still redirects to the plan page", async () => {
    await loader(args(""));

    expect(mockRecordStage).not.toHaveBeenCalled();
    expect(mockRedirect).toHaveBeenCalledWith(PRICING_URL, { target: "_top" });
  });

  it("does not record for an unknown src value", async () => {
    await loader(args("?src=settings"));

    expect(mockRecordStage).not.toHaveBeenCalled();
  });

  it("still redirects when the click was already recorded (claim lost)", async () => {
    mockRecordStage.mockResolvedValue(false);

    await loader(args("?src=upgrade_preview"));

    expect(mockRedirect).toHaveBeenCalledWith(PRICING_URL, { target: "_top" });
  });

  it("builds the store handle from the authenticated session, never from the query string", async () => {
    await loader(
      args("?src=upgrade_preview&shop=attacker.myshopify.com&host=abc&embedded=1&id_token=t"),
    );

    expect(mockRecordStage).toHaveBeenCalledWith("clicked", SHOP);
    expect(mockRedirect).toHaveBeenCalledWith(PRICING_URL, { target: "_top" });
  });

  it("propagates an auth redirect from authenticate.admin without recording", async () => {
    const authBounce = new Response(null, { status: 302, headers: { Location: "/auth/login" } });
    mockAuthenticateAdmin.mockRejectedValue(authBounce);

    await expect(loader(args("?src=upgrade_preview"))).rejects.toBe(authBounce);
    expect(mockRecordStage).not.toHaveBeenCalled();
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});

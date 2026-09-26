/**
 * Tests for app/routes/app.review-request.tsx (gc-97k.7): the review popup's
 * result report (POST action). The recorder is mocked; its once-ever claim and
 * shown/not_shown split are covered in tests/services/review-request.server.test.ts.
 */
import type { ActionFunctionArgs } from "react-router";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: vi.fn() },
}));

vi.mock("../../app/services/review-request.server", () => ({
  recordReviewRequestResult: vi.fn(),
}));

import * as reviewRoute from "../../app/routes/app.review-request";
import { action } from "../../app/routes/app.review-request";
import { recordReviewRequestResult } from "../../app/services/review-request.server";
import { authenticate } from "../../app/shopify.server";

const mockAuthenticateAdmin = authenticate.admin as ReturnType<typeof vi.fn>;
const mockRecord = recordReviewRequestResult as ReturnType<typeof vi.fn>;

const SHOP = "nw-dev-store-2.myshopify.com";

function args(body: Record<string, string>): ActionFunctionArgs {
  return {
    request: new Request("https://app.example.com/app/review-request", {
      method: "POST",
      body: new URLSearchParams(body),
    }),
    params: {},
    context: {},
  } as ActionFunctionArgs;
}

beforeEach(() => {
  vi.resetAllMocks();
  mockAuthenticateAdmin.mockResolvedValue({ session: { shop: SHOP } });
  mockRecord.mockResolvedValue(true);
});

describe("app.review-request action", () => {
  it.each(["success", "cooldown-period", "already-reviewed", "unavailable", "error"])(
    "records %s for the unmodified session shop and returns 204",
    async (code) => {
      const res = await action(args({ code }));

      expect(mockRecord).toHaveBeenCalledTimes(1);
      expect(mockRecord).toHaveBeenCalledWith(SHOP, code, expect.any(Date));
      expect(res.status).toBe(204);
    },
  );

  it.each([{}, { code: "" }, { code: "SUCCESS" }, { code: "free text" }])(
    "rejects a missing or unknown code (%o) with 400 and no write",
    async (body) => {
      const res = await action(args(body as Record<string, string>));

      expect(res.status).toBe(400);
      expect(mockRecord).not.toHaveBeenCalled();
    },
  );

  it("returns 204 when the request was already recorded (claim lost)", async () => {
    mockRecord.mockResolvedValue(false);

    const res = await action(args({ code: "success" }));

    expect(res.status).toBe(204);
  });

  it("ignores cross-shop input: the domain always comes from the session", async () => {
    await action(args({ code: "success", shop: "attacker.myshopify.com" }));

    expect(mockRecord).toHaveBeenCalledWith(SHOP, "success", expect.any(Date));
  });

  it("propagates an auth bounce without recording", async () => {
    const authBounce = new Response(null, { status: 401 });
    mockAuthenticateAdmin.mockRejectedValue(authBounce);

    await expect(action(args({ code: "success" }))).rejects.toBe(authBounce);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("exports no loader (no GET surface)", () => {
    expect("loader" in reviewRoute).toBe(false);
  });
});

/**
 * gc-np1d.5: best-effort click ping for value actions whose button navigates on
 * its own (the Clean copy card, Standard's do-it-yourself, the result page's
 * Preview). Records `clicked` once per merchant for an allow-listed key only,
 * always for the session shop, and never redirects.
 */
import type { ActionFunctionArgs } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../app/shopify.server", () => ({ authenticate: { admin: vi.fn() } }));
vi.mock("../../app/services/nudge-stage.server", () => ({ recordNudgeStageOnce: vi.fn() }));

import * as route from "../../app/routes/app.value-action-click";
import { action } from "../../app/routes/app.value-action-click";
import { recordNudgeStageOnce } from "../../app/services/nudge-stage.server";
import { authenticate } from "../../app/shopify.server";

const mockAuth = authenticate.admin as ReturnType<typeof vi.fn>;
const mockStage = recordNudgeStageOnce as ReturnType<typeof vi.fn>;
const SHOP = "nw-dev-store-2.myshopify.com";

const args = (body: Record<string, string>): ActionFunctionArgs =>
  ({
    request: new Request("https://app.example.com/app/value-action-click", {
      method: "POST",
      body: new URLSearchParams(body),
    }),
    params: {},
    context: {},
  }) as ActionFunctionArgs;

beforeEach(() => {
  vi.resetAllMocks();
  mockAuth.mockResolvedValue({ session: { shop: SHOP } });
  mockStage.mockResolvedValue(true);
});

describe("value action click ping", () => {
  it.each(["clean_copy_action", "clean_copy_diy", "clean_copy_preview"])(
    "records %s clicked for the session shop and returns 204",
    async (src) => {
      const res = await action(args({ src }));
      expect(mockStage).toHaveBeenCalledWith(src, "clicked", SHOP);
      expect(res.status).toBe(204);
    },
  );

  it.each([
    "",
    "upgrade_preview",
    "clean_copy_upsell",
    "scan_header",
    "CLEAN_COPY_ACTION",
    "x".repeat(500),
  ])("ignores %s (not a ping key) and still returns 204", async (src) => {
    const res = await action(args({ src }));
    expect(mockStage).not.toHaveBeenCalled();
    expect(res.status).toBe(204);
  });

  it("ignores a shop named in the body", async () => {
    await action(args({ src: "clean_copy_action", shop: "other.myshopify.com" }));
    expect(mockStage).toHaveBeenCalledWith("clean_copy_action", "clicked", SHOP);
  });

  it("a body that is not form data records nothing and never returns 500", async () => {
    const res = await action({
      request: new Request("https://app.example.com/app/value-action-click", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ src: "clean_copy_action" }),
      }),
      params: {},
      context: {},
    } as ActionFunctionArgs);
    expect(mockStage).not.toHaveBeenCalled();
    expect(res.status).toBe(204);
  });

  it("has no loader (nothing to navigate to)", () => {
    expect("loader" in route).toBe(false);
  });
});

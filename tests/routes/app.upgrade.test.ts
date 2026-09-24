/**
 * Tests for app/routes/app.upgrade.tsx (gc-97k.4, reworked in the gc-97k
 * review): the upgrade-preview CTA's best-effort click ping (POST action).
 *
 * Strategy:
 *   - Mock authenticate.admin() to control the session.
 *   - Mock the once-per-merchant stage recorder; its dedupe is covered in
 *     tests/services/upgrade-preview-nudge.server.test.ts.
 *   - Navigation is NOT this route's job (the CTA is a plain top-level link),
 *     so the action must never redirect: always 204.
 */
import type { ActionFunctionArgs } from "react-router";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: vi.fn() },
}));

vi.mock("../../app/services/upgrade-preview-nudge.server", () => ({
  recordUpgradePreviewStageOnce: vi.fn(),
}));

import * as upgradeRoute from "../../app/routes/app.upgrade";
import { action } from "../../app/routes/app.upgrade";
import { recordUpgradePreviewStageOnce } from "../../app/services/upgrade-preview-nudge.server";
import { authenticate } from "../../app/shopify.server";

const mockAuthenticateAdmin = authenticate.admin as ReturnType<typeof vi.fn>;
const mockRecordStage = recordUpgradePreviewStageOnce as ReturnType<typeof vi.fn>;

const SHOP = "nw-dev-store-2.myshopify.com";

function args(body: Record<string, string>): ActionFunctionArgs {
  return {
    request: new Request("https://app.example.com/app/upgrade", {
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
  mockRecordStage.mockResolvedValue(true);
});

describe("app.upgrade action", () => {
  it("records the upgrade-preview click once with the unmodified session shop, returns 204", async () => {
    const res = await action(args({ src: "upgrade_preview" }));

    expect(mockRecordStage).toHaveBeenCalledTimes(1);
    expect(mockRecordStage).toHaveBeenCalledWith("clicked", SHOP);
    expect(res.status).toBe(204);
    expect(res.headers.get("Location")).toBeNull();
  });

  it("does not record without src (still 204)", async () => {
    const res = await action(args({}));

    expect(mockRecordStage).not.toHaveBeenCalled();
    expect(res.status).toBe(204);
  });

  it("does not record for an unknown src value", async () => {
    const res = await action(args({ src: "settings" }));

    expect(mockRecordStage).not.toHaveBeenCalled();
    expect(res.status).toBe(204);
  });

  it("returns 204 when the click was already recorded (claim lost)", async () => {
    mockRecordStage.mockResolvedValue(false);

    const res = await action(args({ src: "upgrade_preview" }));

    expect(res.status).toBe(204);
  });

  it("ignores cross-shop input: the domain always comes from the session", async () => {
    const res = await action(
      args({
        src: "upgrade_preview",
        shop: "attacker.myshopify.com",
        shopDomain: "x.myshopify.com",
      }),
    );

    expect(mockRecordStage).toHaveBeenCalledTimes(1);
    expect(mockRecordStage).toHaveBeenCalledWith("clicked", SHOP);
    expect(res.status).toBe(204);
  });

  it("propagates an auth bounce from authenticate.admin without recording", async () => {
    const authBounce = new Response(null, { status: 401 });
    mockAuthenticateAdmin.mockRejectedValue(authBounce);

    await expect(action(args({ src: "upgrade_preview" }))).rejects.toBe(authBounce);
    expect(mockRecordStage).not.toHaveBeenCalled();
  });

  it("exports no loader: GET cannot redirect anywhere (no open-redirect surface)", () => {
    expect("loader" in upgradeRoute).toBe(false);
  });
});

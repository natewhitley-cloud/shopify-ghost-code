/**
 * End-to-end regression for gc-4hk with the REAL Shopify library.
 *
 * Unlike the route unit tests (which mock `authenticate.webhook`), this file
 * builds a real `shopifyApp` (future.expiringOfflineAccessTokens on, same as
 * app/shopify.server.ts) over an in-memory session store holding an EXPIRED
 * offline session with a DEAD refresh token, stubs the network so Shopify's
 * refresh endpoint rejects it exactly as it did for de66e6-c4 on 2026-09-23,
 * and sends real-HMAC webhooks through the real route actions.
 *
 * Before the fix every one of these webhooks threw the library's
 * `new Response(500)` (Shopify retry storm; an uninstall/redact never lands).
 */

import type { ActionFunctionArgs } from "react-router";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The web-api adapter captures `fetch` when it is first imported, so the stub
// must be installed before any @shopify import (vi.hoisted runs first).
const { fetchMock } = vi.hoisted(() => {
  const fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return { fetchMock };
});

vi.mock("../../app/shopify.server", async () => {
  await import("@shopify/shopify-app-react-router/adapters/node");
  const { shopifyApp, ApiVersion, AppDistribution, Session } =
    await import("@shopify/shopify-app-react-router/server");
  const { TEST_WEBHOOK_SECRET } = await import("../test-utils/signed-webhook");

  const sessions = new Map<string, InstanceType<typeof Session>>();
  const sessionStorage = {
    storeSession: async (s: InstanceType<typeof Session>) => {
      sessions.set(s.id, s);
      return true;
    },
    loadSession: async (id: string) => sessions.get(id),
    deleteSession: async (id: string) => sessions.delete(id),
    deleteSessions: async (ids: string[]) => {
      ids.forEach((id) => sessions.delete(id));
      return true;
    },
    findSessionsByShop: async (shop: string) =>
      [...sessions.values()].filter((s) => s.shop === shop),
  };

  const shopify = shopifyApp({
    apiKey: "test-api-key",
    apiSecretKey: TEST_WEBHOOK_SECRET,
    apiVersion: ApiVersion.July26,
    appUrl: "https://ghost-code.test",
    authPathPrefix: "/auth",
    sessionStorage,
    distribution: AppDistribution.AppStore,
    future: { expiringOfflineAccessTokens: true },
  });

  return {
    apiVersion: ApiVersion.July26,
    authenticate: shopify.authenticate,
    unauthenticated: shopify.unauthenticated,
    sessionStorage,
    Session,
  };
});

vi.mock("../../app/models/shop.server", () => ({
  markShopUninstalledWithEvent: vi.fn(),
  deleteShopData: vi.fn(),
  getShopMetadata: vi.fn(),
  updateThemePublishTimestamp: vi.fn(),
}));

vi.mock("../../app/models/ops-event.server", () => ({
  recordWebhookFailure: vi.fn(),
}));

vi.mock("../../app/services/scan-dispatch.server", () => ({
  dispatchScan: vi.fn(),
}));

vi.mock("../../app/services/theme-fetcher.server", () => ({
  fetchMainTheme: vi.fn(),
}));

vi.mock("../../app/lib/plan-gating.server", () => ({
  canUseAutoRescan: vi.fn(),
}));

vi.mock("../../app/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { canUseAutoRescan } from "../../app/lib/plan-gating.server";
import { recordWebhookFailure } from "../../app/models/ops-event.server";
import {
  deleteShopData,
  getShopMetadata,
  markShopUninstalledWithEvent,
  updateThemePublishTimestamp,
} from "../../app/models/shop.server";
import { action as gdprAction } from "../../app/routes/webhooks";
import { action as uninstalledAction } from "../../app/routes/webhooks.app.uninstalled";
import { action as publishAction } from "../../app/routes/webhooks.themes.publish";
import { dispatchScan } from "../../app/services/scan-dispatch.server";
import { fetchMainTheme } from "../../app/services/theme-fetcher.server";
import * as shopifyServer from "../../app/shopify.server";
import { signedWebhookRequest, stubWebhookEnv } from "../test-utils/signed-webhook";

const SHOP = "de66e6-c4.myshopify.com";

// Test-only view of the extra exports the mock factory adds.
const { sessionStorage, Session } = shopifyServer as unknown as {
  sessionStorage: {
    storeSession: (s: unknown) => Promise<boolean>;
    deleteSession: (id: string) => Promise<boolean>;
  };
  Session: new (params: Record<string, unknown>) => unknown;
};

function args(request: Request): ActionFunctionArgs {
  return { request, params: {}, context: {} } as ActionFunctionArgs;
}

/** Shopify's reply to a refresh with a dead refresh token (the de66e6-c4 case). */
function refreshEndpointRejects() {
  fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({
        error: "invalid_request",
        error_description: "This request requires an active refresh_token",
      }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    ),
  );
}

beforeEach(async () => {
  vi.resetAllMocks();
  stubWebhookEnv();
  refreshEndpointRejects();
  const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await sessionStorage.storeSession(
    new Session({
      id: `offline_${SHOP}`,
      shop: SHOP,
      state: "",
      isOnline: false,
      accessToken: "shpat_expired",
      scope: "read_themes",
      expires: past,
      refreshToken: "shprt_dead",
      refreshTokenExpires: past,
    }),
  );
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await sessionStorage.deleteSession(`offline_${SHOP}`);
});

describe("gc-4hk: expired offline session + dead refresh token (real library)", () => {
  it("precondition: the real authenticate.webhook throws the refresh wrapper Response(500)", async () => {
    // Documents the library behavior the fix exists for. If a library upgrade
    // changes this, re-check the helper's rejection classification.
    const promise = shopifyServer.authenticate.webhook(
      signedWebhookRequest({ topic: "app/uninstalled", shop: SHOP }),
    );
    await expect(promise).rejects.toBeInstanceOf(Response);
    await expect(promise).rejects.toMatchObject({ status: 500 });
    // ...and it really did attempt the refresh against Shopify.
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`https://${SHOP}/admin/oauth/access_token`),
      expect.anything(),
    );
  });

  it("app/uninstalled returns 200 and still marks the shop uninstalled (sessions deleted)", async () => {
    vi.mocked(markShopUninstalledWithEvent).mockResolvedValue({ newlyMarked: true, found: true });

    const res = await uninstalledAction(
      args(signedWebhookRequest({ topic: "app/uninstalled", shop: SHOP })),
    );

    expect((res as Response).status).toBe(200);
    expect(markShopUninstalledWithEvent).toHaveBeenCalledWith(SHOP, {
      source: "webhook",
      message: "app/uninstalled",
    });
    expect(recordWebhookFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "APP_UNINSTALLED",
        shop: SHOP,
        degradedReason: "offline_session_failed",
      }),
    );
  });

  it("shop/redact returns 200 and the redact actually runs", async () => {
    vi.mocked(deleteShopData).mockResolvedValue({ id: "shop-1" } as never);

    const res = await gdprAction(
      args(
        signedWebhookRequest({ topic: "shop/redact", shop: SHOP, payload: { shop_domain: SHOP } }),
      ),
    );

    expect((res as Response).status).toBe(200);
    expect(deleteShopData).toHaveBeenCalledWith(SHOP);
  });

  it("themes/publish (Pro) returns 200: timestamp written, auto-rescan skipped, no retry", async () => {
    vi.mocked(getShopMetadata).mockResolvedValue({ id: "shop-1", plan: "Professional" } as never);
    vi.mocked(canUseAutoRescan).mockReturnValue(true);

    const res = await publishAction(
      args(signedWebhookRequest({ topic: "themes/publish", shop: SHOP, payload: { id: 1 } })),
    );

    expect((res as Response).status).toBe(200);
    expect(updateThemePublishTimestamp).toHaveBeenCalledWith(SHOP);
    // The REAL unauthenticated.admin hit the same dead refresh token.
    expect(fetchMainTheme).not.toHaveBeenCalled();
    expect(dispatchScan).not.toHaveBeenCalled();
    expect(recordWebhookFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "THEMES_PUBLISH",
        shop: SHOP,
        degradedReason: "admin_auth_unavailable",
      }),
    );
  });

  it("a forged webhook for the same dead-token shop is still rejected 401 by the real library", async () => {
    const promise = uninstalledAction(
      args(
        signedWebhookRequest({ topic: "app/uninstalled", shop: SHOP, secret: "attacker-secret" }),
      ),
    );

    await expect(promise).rejects.toMatchObject({ status: 401 });
    expect(markShopUninstalledWithEvent).not.toHaveBeenCalled();
    expect(recordWebhookFailure).not.toHaveBeenCalled();
    // HMAC fails first, so the library never even attempts the refresh.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

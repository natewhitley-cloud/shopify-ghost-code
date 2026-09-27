/**
 * Tests for app/lib/webhook-auth.server.ts (gc-4hk).
 *
 * `authenticate.webhook` is mocked to control WHAT the library does (succeed,
 * reject, or blow up after HMAC). The fallback's HMAC check is NOT mocked: it is
 * the real `@shopify/shopify-api` `webhooks.validate`, fed a request signed with
 * a real HMAC (tests/test-utils/signed-webhook.ts), so a forged/tampered request
 * genuinely fails validation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../app/shopify.server", () => ({
  apiVersion: "2026-07",
  authenticate: {
    webhook: vi.fn(),
  },
}));

vi.mock("../../app/models/ops-event.server", () => ({
  recordWebhookFailure: vi.fn(),
}));

vi.mock("../../app/lib/logger.server", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { logger } from "../../app/lib/logger.server";
import {
  authenticateWebhookTolerant,
  DEGRADED_REASON_OFFLINE_SESSION,
} from "../../app/lib/webhook-auth.server";
import { recordWebhookFailure } from "../../app/models/ops-event.server";
import { authenticate } from "../../app/shopify.server";
import {
  signedWebhookRequest,
  stubWebhookEnv,
  TEST_API_VERSION,
} from "../test-utils/signed-webhook";

const mockAuthenticateWebhook = authenticate.webhook as ReturnType<typeof vi.fn>;
const mockRecordWebhookFailure = recordWebhookFailure as ReturnType<typeof vi.fn>;
const mockLoggerError = logger.error as ReturnType<typeof vi.fn>;

const SHOP = "de66e6-c4.myshopify.com";
const PAYLOAD = { id: 123456789, name: "Dawn" };

/** What the library throws when the refresh token is dead (refresh-token.mjs). */
const refreshWrapper500 = () =>
  new Response(undefined, { status: 500, statusText: "Internal Server Error" });

/** Mimic the library: consume the body, then fail after "HMAC validation". */
function libraryConsumesBodyThenThrows(err: unknown) {
  mockAuthenticateWebhook.mockImplementationOnce(async (request: Request) => {
    await request.text();
    throw err;
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  stubWebhookEnv();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("authenticateWebhookTolerant: library succeeds", () => {
  it("returns the library's context unchanged plus degraded: false, and records nothing", async () => {
    const libraryContext = { shop: SHOP, topic: "THEMES_PUBLISH", admin: {}, session: {} };
    mockAuthenticateWebhook.mockResolvedValueOnce(libraryContext);

    const result = await authenticateWebhookTolerant(
      signedWebhookRequest({ topic: "themes/publish", shop: SHOP, payload: PAYLOAD }),
    );

    expect(result).toEqual({ ...libraryContext, degraded: false });
    expect(mockRecordWebhookFailure).not.toHaveBeenCalled();
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it("a shop with NO stored session (library returns admin: undefined) is NOT degraded", async () => {
    // admin === undefined alone must never be read as "degraded": no degraded
    // row was recorded for this delivery, so handlers must still record theirs.
    const noSessionContext = {
      shop: SHOP,
      topic: "THEMES_PUBLISH",
      admin: undefined,
      session: undefined,
    };
    mockAuthenticateWebhook.mockResolvedValueOnce(noSessionContext);

    const result = await authenticateWebhookTolerant(
      signedWebhookRequest({ topic: "themes/publish", shop: SHOP, payload: PAYLOAD }),
    );

    expect(result.admin).toBeUndefined();
    expect(result.degraded).toBe(false);
    expect(mockRecordWebhookFailure).not.toHaveBeenCalled();
  });

  it("leaves the original request body readable for the library", async () => {
    let bodySeenByLibrary: string | undefined;
    mockAuthenticateWebhook.mockImplementationOnce(async (request: Request) => {
      bodySeenByLibrary = await request.text();
      return { shop: SHOP, topic: "THEMES_PUBLISH" };
    });

    await authenticateWebhookTolerant(
      signedWebhookRequest({ topic: "themes/publish", shop: SHOP, payload: PAYLOAD }),
    );

    expect(bodySeenByLibrary).toBe(JSON.stringify(PAYLOAD));
  });
});

describe("authenticateWebhookTolerant: deliberate rejections are re-thrown unchanged", () => {
  it.each([
    [401, "Unauthorized"],
    [400, "Bad Request"],
    [405, "Method not allowed"],
  ])(
    "re-throws the library's %i Response as the SAME object, with no fallback",
    async (status, statusText) => {
      const rejection = new Response(undefined, { status, statusText });
      mockAuthenticateWebhook.mockRejectedValueOnce(rejection);

      // Even a correctly-signed request must not be rescued: the library's
      // verdict stands for every deliberate rejection.
      await expect(
        authenticateWebhookTolerant(signedWebhookRequest({ topic: "app/uninstalled", shop: SHOP })),
      ).rejects.toBe(rejection);

      expect(mockRecordWebhookFailure).not.toHaveBeenCalled();
      expect(mockLoggerError).not.toHaveBeenCalled();
    },
  );
});

describe("authenticateWebhookTolerant: failure after HMAC (dead refresh token)", () => {
  it.each([
    ["the refresh helper's Response(500) wrapper", refreshWrapper500],
    ["a thrown Error (e.g. InvalidJwtError / storeSession failure)", () => new Error("boom")],
  ])("valid HMAC + %s -> no-session context with the right fields", async (_label, makeError) => {
    libraryConsumesBodyThenThrows(makeError());

    const result = await authenticateWebhookTolerant(
      signedWebhookRequest({ topic: "themes/publish", shop: SHOP, payload: PAYLOAD }),
    );

    expect(result).toEqual({
      apiVersion: TEST_API_VERSION,
      shop: SHOP,
      topic: "THEMES_PUBLISH",
      webhookId: "webhook-id-1",
      payload: PAYLOAD,
      subTopic: undefined,
      session: undefined,
      admin: undefined,
      webhookType: "webhooks",
      name: undefined,
      triggeredAt: undefined,
      eventId: undefined,
      degraded: true,
    });
  });

  it("reads the payload from the up-front clone even though the library consumed the body", async () => {
    libraryConsumesBodyThenThrows(refreshWrapper500());

    const result = await authenticateWebhookTolerant(
      signedWebhookRequest({ topic: "app/uninstalled", shop: SHOP, payload: PAYLOAD }),
    );

    expect(result.payload).toEqual(PAYLOAD);
  });

  it("records a degraded webhook_failure ops event keyed on the verified topic + shop", async () => {
    libraryConsumesBodyThenThrows(refreshWrapper500());

    await authenticateWebhookTolerant(
      signedWebhookRequest({ topic: "app/uninstalled", shop: SHOP }),
    );

    expect(mockRecordWebhookFailure).toHaveBeenCalledTimes(1);
    const input = mockRecordWebhookFailure.mock.calls[0][0];
    expect(input).toMatchObject({
      topic: "APP_UNINSTALLED",
      shop: SHOP,
      degradedReason: DEGRADED_REASON_OFFLINE_SESSION,
    });
    expect(input.error).toBeInstanceOf(Error);
    expect((input.error as Error).message).toBe("Response 500");
  });

  it("passes a thrown Error through to the ops event as-is", async () => {
    const err = new Error("refresh rejected: invalid_subject_token");
    libraryConsumesBodyThenThrows(err);

    await authenticateWebhookTolerant(signedWebhookRequest({ topic: "shop/redact", shop: SHOP }));

    expect(mockRecordWebhookFailure).toHaveBeenCalledWith(
      expect.objectContaining({ topic: "SHOP_REDACT", shop: SHOP, error: err }),
    );
  });

  it("logs the failure with the shop domain from the header", async () => {
    libraryConsumesBodyThenThrows(refreshWrapper500());

    await authenticateWebhookTolerant(
      signedWebhookRequest({ topic: "app/uninstalled", shop: SHOP }),
    );

    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining("webhook-auth-degraded"),
      expect.objectContaining({ shop: SHOP, topic: "app/uninstalled", error: "Response 500" }),
    );
  });
});

describe("authenticateWebhookTolerant: the fallback never weakens HMAC verification", () => {
  it("throws 401 when the request was signed with a different secret", async () => {
    libraryConsumesBodyThenThrows(refreshWrapper500());

    const promise = authenticateWebhookTolerant(
      signedWebhookRequest({ topic: "app/uninstalled", shop: SHOP, secret: "attacker-secret" }),
    );

    await expect(promise).rejects.toBeInstanceOf(Response);
    await expect(promise).rejects.toMatchObject({ status: 401 });
    expect(mockRecordWebhookFailure).not.toHaveBeenCalled();
  });

  it("throws 401 when the body was tampered with after signing", async () => {
    libraryConsumesBodyThenThrows(new Error("boom"));

    const promise = authenticateWebhookTolerant(
      signedWebhookRequest({
        topic: "shop/redact",
        shop: SHOP,
        payload: { shop_domain: SHOP },
        tamperedBody: JSON.stringify({ shop_domain: "victim.myshopify.com" }),
      }),
    );

    await expect(promise).rejects.toMatchObject({ status: 401 });
    expect(mockRecordWebhookFailure).not.toHaveBeenCalled();
  });

  it("rejects (400, as the library does for MissingHmac) when the HMAC header is absent", async () => {
    libraryConsumesBodyThenThrows(new Error("boom"));

    const promise = authenticateWebhookTolerant(
      signedWebhookRequest({
        topic: "app/uninstalled",
        shop: SHOP,
        omitHeaders: ["X-Shopify-Hmac-Sha256"],
      }),
    );

    await expect(promise).rejects.toBeInstanceOf(Response);
    await expect(promise).rejects.toMatchObject({ status: 400 });
    expect(mockRecordWebhookFailure).not.toHaveBeenCalled();
  });

  it("throws 400 when the HMAC is valid but a required header is missing", async () => {
    libraryConsumesBodyThenThrows(refreshWrapper500());

    const promise = authenticateWebhookTolerant(
      signedWebhookRequest({
        topic: "app/uninstalled",
        shop: SHOP,
        omitHeaders: ["X-Shopify-Topic"],
      }),
    );

    await expect(promise).rejects.toMatchObject({ status: 400 });
    expect(mockRecordWebhookFailure).not.toHaveBeenCalled();
  });

  it("validates against SHOPIFY_API_SECRET at call time (a rotated secret is honored)", async () => {
    vi.stubEnv("SHOPIFY_API_SECRET", "rotated-secret");
    libraryConsumesBodyThenThrows(refreshWrapper500());

    // Signed with the OLD test secret -> must now be rejected.
    await expect(
      authenticateWebhookTolerant(signedWebhookRequest({ topic: "app/uninstalled", shop: SHOP })),
    ).rejects.toMatchObject({ status: 401 });

    libraryConsumesBodyThenThrows(refreshWrapper500());
    const result = await authenticateWebhookTolerant(
      signedWebhookRequest({ topic: "app/uninstalled", shop: SHOP, secret: "rotated-secret" }),
    );
    expect(result.shop).toBe(SHOP);
  });
});

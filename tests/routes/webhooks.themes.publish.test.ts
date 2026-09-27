/**
 * Tests for the webhooks.themes.publish webhook handler.
 *
 * Strategy:
 *   - Mock authenticate.webhook() to control what topic/shop/payload the handler sees.
 *   - Mock unauthenticated.admin() + fetchMainTheme() to control the MAIN theme lookup.
 *   - Mock getShopMetadata(), canUseAutoRescan(), and dispatchScan() (the unified
 *     scan-dispatch service) to verify orchestration behavior without any real I/O.
 *   - Key invariant: the themeId passed to dispatchScan comes from fetchMainTheme
 *     (not the webhook payload), ensuring the active theme is scanned.
 *   - dispatchScan internals (createScan + inngest.send) are tested separately in
 *     tests/services/scan-dispatch.server.test.ts.
 */

import { ScanOrigin } from "@prisma/client";
import { HttpResponseError, InvalidJwtError } from "@shopify/shopify-api";
import { SessionNotFoundError } from "@shopify/shopify-app-react-router/server";
import type { ActionFunctionArgs } from "react-router";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (hoisted by Vitest before imports)
// ---------------------------------------------------------------------------

vi.mock("../../app/shopify.server", () => ({
  apiVersion: "2026-07",
  authenticate: {
    webhook: vi.fn(),
  },
  unauthenticated: {
    admin: vi.fn(),
  },
}));

vi.mock("../../app/services/theme-fetcher.server", () => ({
  fetchMainTheme: vi.fn(),
}));

vi.mock("../../app/models/shop.server", () => ({
  getShopMetadata: vi.fn(),
  updateThemePublishTimestamp: vi
    .fn()
    .mockResolvedValue({ id: "shop-1", domain: "test.myshopify.com" }),
}));

vi.mock("../../app/services/scan-dispatch.server", () => ({
  dispatchScan: vi.fn(),
}));

vi.mock("../../app/lib/plan-gating.server", () => ({
  canUseAutoRescan: vi.fn(),
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

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

import { canUseAutoRescan } from "../../app/lib/plan-gating.server";
import { recordWebhookFailure } from "../../app/models/ops-event.server";
import { getShopMetadata, updateThemePublishTimestamp } from "../../app/models/shop.server";
import { action } from "../../app/routes/webhooks.themes.publish";
import { dispatchScan } from "../../app/services/scan-dispatch.server";
import { fetchMainTheme } from "../../app/services/theme-fetcher.server";
import { authenticate, unauthenticated } from "../../app/shopify.server";
import { signedWebhookRequest, stubWebhookEnv } from "../test-utils/signed-webhook";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockAuthenticateWebhook = authenticate.webhook as ReturnType<typeof vi.fn>;
const mockUnauthenticatedAdmin = unauthenticated.admin as ReturnType<typeof vi.fn>;
const mockFetchMainTheme = fetchMainTheme as ReturnType<typeof vi.fn>;
const mockGetShopMetadata = getShopMetadata as ReturnType<typeof vi.fn>;
const mockDispatchScan = dispatchScan as ReturnType<typeof vi.fn>;
const mockCanUseAutoRescan = canUseAutoRescan as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Test data constants
// ---------------------------------------------------------------------------

const SHOP_DOMAIN = "test-shop.myshopify.com";
const SHOP_ID = "shop-abc-123";
const THEME_GID = "gid://shopify/Theme/123456789";
const THEME_NAME = "Dawn";
const SCAN_ID = "scan-xyz-789";

const MOCK_SHOP_PROFESSIONAL = {
  id: SHOP_ID,
  domain: SHOP_DOMAIN,
  plan: "Professional",
  accessToken: "test-token",
};

const MOCK_SHOP_FREE = {
  id: "shop-free-111",
  domain: SHOP_DOMAIN,
  plan: "free",
  accessToken: "test-token",
};

const MOCK_SHOP_STANDARD = {
  id: "shop-std-222",
  domain: SHOP_DOMAIN,
  plan: "Standard",
  accessToken: "test-token",
};

const MOCK_SCAN = {
  id: SCAN_ID,
  shopId: SHOP_ID,
  themeId: THEME_GID,
  themeName: THEME_NAME,
  status: "PENDING",
};

const MOCK_MAIN_THEME = {
  id: THEME_GID,
  name: THEME_NAME,
  updatedAt: "2026-03-28T00:00:00Z",
};

const MOCK_ADMIN = { graphql: vi.fn() };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest() {
  return new Request("https://example.com/webhooks/themes/publish", {
    method: "POST",
    body: JSON.stringify({ id: 123456789, name: THEME_NAME }),
    headers: { "Content-Type": "application/json" },
  });
}

function setupWebhookAuth(overrides?: { shop?: string; payload?: Record<string, unknown> }) {
  mockAuthenticateWebhook.mockResolvedValue({
    topic: "THEMES_PUBLISH",
    shop: overrides?.shop ?? SHOP_DOMAIN,
    payload: overrides?.payload ?? { id: 123456789, name: THEME_NAME },
  });
}

// ---------------------------------------------------------------------------
// Setup: reset mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  setupWebhookAuth();
  mockGetShopMetadata.mockResolvedValue(MOCK_SHOP_PROFESSIONAL);
  mockCanUseAutoRescan.mockReturnValue(true);
  mockDispatchScan.mockResolvedValue({ scan: MOCK_SCAN });
  mockUnauthenticatedAdmin.mockResolvedValue({ admin: MOCK_ADMIN });
  mockFetchMainTheme.mockResolvedValue(MOCK_MAIN_THEME);
});

// ---------------------------------------------------------------------------
// Happy path — Professional plan shop
// ---------------------------------------------------------------------------

describe("webhooks.themes.publish — Professional plan (happy path)", () => {
  it("returns 200", async () => {
    const response = await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(response.status).toBe(200);
  });

  it("calls dispatchScan with the MAIN theme GID from fetchMainTheme", async () => {
    await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(mockDispatchScan).toHaveBeenCalledOnce();
    const [shopId, themeId, themeName] = mockDispatchScan.mock.calls[0];

    expect(shopId).toBe(SHOP_ID);
    expect(themeId).toBe(THEME_GID);
    expect(themeId).toMatch(/^gid:\/\/shopify\/Theme\//);
    expect(themeName).toBe(THEME_NAME);
  });

  it("dispatches with AUTO_PUBLISH origin so the auto-rescan is exempt from the manual quota (GC-iji)", async () => {
    await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(mockDispatchScan).toHaveBeenCalledOnce();
    const options = mockDispatchScan.mock.calls[0][3];
    expect(options).toEqual(expect.objectContaining({ origin: ScanOrigin.AUTO_PUBLISH }));
  });

  it("looks up the shop by the domain from the webhook", async () => {
    await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(mockGetShopMetadata).toHaveBeenCalledWith(SHOP_DOMAIN);
  });

  it("checks canUseAutoRescan with the shop's plan", async () => {
    await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(mockCanUseAutoRescan).toHaveBeenCalledWith(MOCK_SHOP_PROFESSIONAL.plan);
  });

  it("fetches the MAIN theme via unauthenticated admin context", async () => {
    await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(mockUnauthenticatedAdmin).toHaveBeenCalledWith(SHOP_DOMAIN);
    expect(mockFetchMainTheme).toHaveBeenCalledWith(MOCK_ADMIN);
  });
});

// ---------------------------------------------------------------------------
// Non-Professional plans — no scan created
// ---------------------------------------------------------------------------

describe("webhooks.themes.publish — non-Professional plans", () => {
  it("returns 200 silently for a Free-plan shop (no scan, no dispatch)", async () => {
    mockGetShopMetadata.mockResolvedValue(MOCK_SHOP_FREE);
    mockCanUseAutoRescan.mockReturnValue(false);

    const response = await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(response.status).toBe(200);
    expect(mockDispatchScan).not.toHaveBeenCalled();
  });

  it("returns 200 silently for a Standard-plan shop (no scan, no dispatch)", async () => {
    mockGetShopMetadata.mockResolvedValue(MOCK_SHOP_STANDARD);
    mockCanUseAutoRescan.mockReturnValue(false);

    const response = await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(response.status).toBe(200);
    expect(mockDispatchScan).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Unknown shop — shop not in DB
// ---------------------------------------------------------------------------

describe("webhooks.themes.publish — unknown shop", () => {
  it("returns 200 silently when shop is not found in DB", async () => {
    mockGetShopMetadata.mockResolvedValue(null);

    const response = await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(response.status).toBe(200);
  });

  it("does not call dispatchScan when shop is not in DB", async () => {
    mockGetShopMetadata.mockResolvedValue(null);

    await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(mockDispatchScan).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GID format invariant — themeId always comes from fetchMainTheme
// ---------------------------------------------------------------------------

describe("webhooks.themes.publish — GID format regression", () => {
  it("themeId in dispatchScan comes from fetchMainTheme, not webhook payload", async () => {
    // Webhook payload has a different ID than what fetchMainTheme returns.
    // The handler must query the live MAIN theme and use that GID.
    setupWebhookAuth({ payload: { id: 999999999, name: "Wrong Theme" } });
    mockFetchMainTheme.mockResolvedValue({
      id: "gid://shopify/Theme/111111111",
      name: "Correct Theme",
      updatedAt: "2026-03-28T00:00:00Z",
    });

    await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    const [, themeId, themeName] = mockDispatchScan.mock.calls[0];
    expect(themeId).toBe("gid://shopify/Theme/111111111");
    expect(themeName).toBe("Correct Theme");
  });
});

// ---------------------------------------------------------------------------
// fetchMainTheme returns null — no MAIN theme available
// ---------------------------------------------------------------------------

describe("webhooks.themes.publish — no MAIN theme", () => {
  it("returns 200 when fetchMainTheme returns null", async () => {
    mockFetchMainTheme.mockResolvedValue(null);

    const response = await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(response.status).toBe(200);
  });

  it("does not call dispatchScan when no MAIN theme is found", async () => {
    mockFetchMainTheme.mockResolvedValue(null);

    await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(mockDispatchScan).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Scan already in progress — dispatchScan throws (createScan conflict)
// ---------------------------------------------------------------------------

describe("webhooks.themes.publish — scan already in progress", () => {
  it("returns 200 when dispatchScan throws (scan already in progress)", async () => {
    mockDispatchScan.mockRejectedValue(new Error("A scan is already in progress for this shop."));

    const response = await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(response.status).toBe(200);
  });

  it("returns 200 when dispatchScan throws (quota exceeded)", async () => {
    mockDispatchScan.mockRejectedValue(
      new Error("Scan limit reached: 1 of 1 scans used this month."),
    );

    const response = await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(response.status).toBe(200);
  });

  it("only catches createScan-class errors — inngest.send failures are swallowed inside dispatchScan", async () => {
    // dispatchScan swallows inngest.send failures internally and still resolves.
    // This means the webhook action never sees inngest errors and always returns 200.
    mockDispatchScan.mockResolvedValue({ scan: MOCK_SCAN }); // send failed inside, but resolved

    const response = await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(response.status).toBe(200);
    expect(mockDispatchScan).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// gc-4hk: dead offline token (webhook auth + Pro auto-rescan Admin API auth)
// ---------------------------------------------------------------------------

describe("webhooks.themes.publish — dead refresh token (gc-4hk)", () => {
  const mockRecordWebhookFailure = recordWebhookFailure as ReturnType<typeof vi.fn>;
  const mockUpdateTimestamp = updateThemePublishTimestamp as ReturnType<typeof vi.fn>;

  function httpError(code: number, body: Record<string, unknown> = {}) {
    return new HttpResponseError({ message: `HTTP ${code}`, code, statusText: "", body });
  }

  function run(request: Request = makeRequest()) {
    return action({ request, params: {}, context: {} } as unknown as ActionFunctionArgs);
  }

  beforeEach(() => stubWebhookEnv());
  afterEach(() => vi.unstubAllEnvs());

  it("webhook auth refresh failure: returns 200 and writes the publish timestamp", async () => {
    mockAuthenticateWebhook.mockReset();
    mockAuthenticateWebhook.mockImplementationOnce(async (request: Request) => {
      await request.text();
      throw new Response(undefined, { status: 500 });
    });
    mockCanUseAutoRescan.mockReturnValue(false);

    const response = await run(
      signedWebhookRequest({ topic: "themes/publish", shop: SHOP_DOMAIN, payload: { id: 1 } }),
    );

    expect(response.status).toBe(200);
    expect(mockUpdateTimestamp).toHaveBeenCalledWith(SHOP_DOMAIN);
  });

  it.each([
    ["SessionNotFoundError (no offline session)", () => new SessionNotFoundError("no session")],
    ["InvalidJwtError (refresh rejected)", () => new InvalidJwtError("bad jwt")],
    [
      "the refresh wrapper Response(500) (dead refresh token)",
      () => new Response(undefined, { status: 500 }),
    ],
    [
      "HttpResponseError 400 invalid_subject_token",
      () => httpError(400, { error: "invalid_subject_token" }),
    ],
  ])(
    "Pro: unauthenticated.admin throws %s -> 200, timestamp kept, no scan, degraded event",
    async (_label, makeErr) => {
      mockUnauthenticatedAdmin.mockRejectedValueOnce(makeErr());

      const response = await run();

      expect(response.status).toBe(200);
      expect(mockUpdateTimestamp).toHaveBeenCalledWith(SHOP_DOMAIN);
      expect(mockFetchMainTheme).not.toHaveBeenCalled();
      expect(mockDispatchScan).not.toHaveBeenCalled();
      expect(mockRecordWebhookFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: "THEMES_PUBLISH",
          shop: SHOP_DOMAIN,
          degradedReason: "admin_auth_unavailable",
        }),
      );
    },
  );

  it("Pro: fetchMainTheme 401 (revoked token) -> 200, no scan, degraded event", async () => {
    mockFetchMainTheme.mockRejectedValueOnce(httpError(401));

    const response = await run();

    expect(response.status).toBe(200);
    expect(mockDispatchScan).not.toHaveBeenCalled();
    expect(mockRecordWebhookFailure).toHaveBeenCalledWith(
      expect.objectContaining({ degradedReason: "admin_auth_unavailable" }),
    );
  });

  it.each([
    ["fetchMainTheme 429 (throttled)", "fetch", () => httpError(429)],
    ["fetchMainTheme 500", "fetch", () => httpError(500)],
    ["fetchMainTheme GraphQL error", "fetch", () => new Error("[theme-fetcher] Failed")],
    ["unauthenticated.admin 400 without invalid_subject_token", "admin", () => httpError(400)],
    ["unauthenticated.admin DB error", "admin", () => new Error("connection refused")],
  ])(
    "Pro: genuine error (%s) keeps record-and-rethrow (Shopify retries)",
    async (_label, where, makeErr) => {
      const err = makeErr();
      if (where === "fetch") mockFetchMainTheme.mockRejectedValueOnce(err);
      else mockUnauthenticatedAdmin.mockRejectedValueOnce(err);

      await expect(run()).rejects.toBe(err);

      expect(mockRecordWebhookFailure).toHaveBeenCalledWith({
        topic: "THEMES_PUBLISH",
        shop: SHOP_DOMAIN,
        error: err,
      });
      expect(mockDispatchScan).not.toHaveBeenCalled();
    },
  );
});

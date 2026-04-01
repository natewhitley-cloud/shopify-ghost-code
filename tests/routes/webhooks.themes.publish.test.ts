/**
 * Tests for the webhooks.themes.publish webhook handler.
 *
 * Strategy:
 *   - Mock authenticate.webhook() to control what topic/shop/payload the handler sees.
 *   - Mock unauthenticated.admin() + fetchMainTheme() to control the MAIN theme lookup.
 *   - Mock getShopMetadata(), createScan(), canUseAutoRescan(), inngest.send()
 *     to verify orchestration behavior without any real I/O.
 *   - Key invariant: the themeId passed to createScan and inngest.send comes from
 *     fetchMainTheme (not the webhook payload), ensuring the active theme is scanned.
 */

import type { ActionFunctionArgs } from "react-router";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (hoisted by Vitest before imports)
// ---------------------------------------------------------------------------

vi.mock("../../app/shopify.server", () => ({
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

vi.mock("../../app/models/scan.server", () => ({
  createScan: vi.fn(),
}));

vi.mock("../../app/lib/plan-gating.server", () => ({
  canUseAutoRescan: vi.fn(),
}));

vi.mock("../../inngest/client", () => ({
  inngest: {
    send: vi.fn(),
  },
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
import { createScan } from "../../app/models/scan.server";
import { getShopMetadata } from "../../app/models/shop.server";
import { action } from "../../app/routes/webhooks.themes.publish";
import { fetchMainTheme } from "../../app/services/theme-fetcher.server";
import { authenticate, unauthenticated } from "../../app/shopify.server";
import { inngest } from "../../inngest/client";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockAuthenticateWebhook = authenticate.webhook as ReturnType<typeof vi.fn>;
const mockUnauthenticatedAdmin = unauthenticated.admin as ReturnType<typeof vi.fn>;
const mockFetchMainTheme = fetchMainTheme as ReturnType<typeof vi.fn>;
const mockGetShopMetadata = getShopMetadata as ReturnType<typeof vi.fn>;
const mockCreateScan = createScan as ReturnType<typeof vi.fn>;
const mockCanUseAutoRescan = canUseAutoRescan as ReturnType<typeof vi.fn>;
const mockInngestSend = inngest.send as ReturnType<typeof vi.fn>;

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
  mockCreateScan.mockResolvedValue(MOCK_SCAN);
  mockInngestSend.mockResolvedValue(undefined);
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

  it("creates a scan with the MAIN theme GID from fetchMainTheme", async () => {
    await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(mockCreateScan).toHaveBeenCalledOnce();
    const [shopId, themeId, themeName] = mockCreateScan.mock.calls[0];

    expect(shopId).toBe(SHOP_ID);
    expect(themeId).toBe(THEME_GID);
    expect(themeId).toMatch(/^gid:\/\/shopify\/Theme\//);
    expect(themeName).toBe(THEME_NAME);
  });

  it("sends a scan/requested event with the MAIN theme GID", async () => {
    await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(mockInngestSend).toHaveBeenCalledOnce();
    const event = mockInngestSend.mock.calls[0][0];

    expect(event.name).toBe("scan/requested");
    expect(event.data.shopId).toBe(SHOP_ID);
    expect(event.data.scanId).toBe(SCAN_ID);
    expect(event.data.themeId).toBe(THEME_GID);
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
  it("returns 200 silently for a Free-plan shop (no scan, no event)", async () => {
    mockGetShopMetadata.mockResolvedValue(MOCK_SHOP_FREE);
    mockCanUseAutoRescan.mockReturnValue(false);

    const response = await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(response.status).toBe(200);
    expect(mockCreateScan).not.toHaveBeenCalled();
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  it("returns 200 silently for a Standard-plan shop (no scan, no event)", async () => {
    mockGetShopMetadata.mockResolvedValue(MOCK_SHOP_STANDARD);
    mockCanUseAutoRescan.mockReturnValue(false);

    const response = await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(response.status).toBe(200);
    expect(mockCreateScan).not.toHaveBeenCalled();
    expect(mockInngestSend).not.toHaveBeenCalled();
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

  it("does not create a scan when shop is not in DB", async () => {
    mockGetShopMetadata.mockResolvedValue(null);

    await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(mockCreateScan).not.toHaveBeenCalled();
  });

  it("does not send an Inngest event when shop is not in DB", async () => {
    mockGetShopMetadata.mockResolvedValue(null);

    await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(mockInngestSend).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GID format invariant — themeId always comes from fetchMainTheme
// ---------------------------------------------------------------------------

describe("webhooks.themes.publish — GID format regression", () => {
  it("themeId in createScan comes from fetchMainTheme, not webhook payload", async () => {
    // Webhook payload has a different ID than what fetchMainTheme returns
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

    const [, themeId, themeName] = mockCreateScan.mock.calls[0];
    expect(themeId).toBe("gid://shopify/Theme/111111111");
    expect(themeName).toBe("Correct Theme");
  });

  it("themeId in createScan and inngest.send are identical", async () => {
    await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    const [, scanThemeId] = mockCreateScan.mock.calls[0];
    const event = mockInngestSend.mock.calls[0][0];

    expect(scanThemeId).toBe(event.data.themeId);
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

  it("does not create a scan when no MAIN theme is found", async () => {
    mockFetchMainTheme.mockResolvedValue(null);

    await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(mockCreateScan).not.toHaveBeenCalled();
  });

  it("does not send an Inngest event when no MAIN theme is found", async () => {
    mockFetchMainTheme.mockResolvedValue(null);

    await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(mockInngestSend).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Scan already in progress — createScan throws
// ---------------------------------------------------------------------------

describe("webhooks.themes.publish — scan already in progress", () => {
  it("returns 200 when createScan throws (scan already in progress)", async () => {
    mockCreateScan.mockRejectedValue(new Error("Scan already in progress"));

    const response = await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(response.status).toBe(200);
  });

  it("does not send an Inngest event when createScan throws", async () => {
    mockCreateScan.mockRejectedValue(new Error("Scan already in progress"));

    await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(mockInngestSend).not.toHaveBeenCalled();
  });
});

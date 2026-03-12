/**
 * Tests for the webhooks.themes.publish webhook handler.
 *
 * Strategy:
 *   - Mock authenticate.webhook() to control what topic/shop/payload the handler sees.
 *   - Mock getShopByDomain(), createScan(), canUseAutoRescan(), inngest.send()
 *     to verify orchestration behavior without any real I/O.
 *   - Key invariant: the themeId passed to createScan and inngest.send must be
 *     a GID-formatted string ("gid://shopify/Theme/<id>"), NOT the bare numeric id.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActionFunctionArgs } from "react-router";

// ---------------------------------------------------------------------------
// Module mocks (hoisted by Vitest before imports)
// ---------------------------------------------------------------------------

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    webhook: vi.fn(),
  },
}));

vi.mock("../../app/models/shop.server", () => ({
  getShopByDomain: vi.fn(),
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

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

import { canUseAutoRescan } from "../../app/lib/plan-gating.server";
import { createScan } from "../../app/models/scan.server";
import { getShopByDomain } from "../../app/models/shop.server";
import { action } from "../../app/routes/webhooks.themes.publish";
import { authenticate } from "../../app/shopify.server";
import { inngest } from "../../inngest/client";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockAuthenticateWebhook = authenticate.webhook as ReturnType<typeof vi.fn>;
const mockGetShopByDomain = getShopByDomain as ReturnType<typeof vi.fn>;
const mockCreateScan = createScan as ReturnType<typeof vi.fn>;
const mockCanUseAutoRescan = canUseAutoRescan as ReturnType<typeof vi.fn>;
const mockInngestSend = inngest.send as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Test data constants
// ---------------------------------------------------------------------------

const SHOP_DOMAIN = "test-shop.myshopify.com";
const SHOP_ID = "shop-abc-123";
const THEME_NUMERIC_ID = 123456789;
const THEME_GID = `gid://shopify/Theme/${THEME_NUMERIC_ID}`;
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest() {
  return new Request("https://example.com/webhooks/themes/publish", {
    method: "POST",
    body: JSON.stringify({ id: THEME_NUMERIC_ID, name: THEME_NAME }),
    headers: { "Content-Type": "application/json" },
  });
}

function setupWebhookAuth(overrides?: { shop?: string; payload?: Record<string, unknown> }) {
  mockAuthenticateWebhook.mockResolvedValue({
    topic: "THEMES_PUBLISH",
    shop: overrides?.shop ?? SHOP_DOMAIN,
    payload: overrides?.payload ?? { id: THEME_NUMERIC_ID, name: THEME_NAME },
  });
}

// ---------------------------------------------------------------------------
// Setup: reset mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Default happy-path wiring
  setupWebhookAuth();
  mockGetShopByDomain.mockResolvedValue(MOCK_SHOP_PROFESSIONAL);
  mockCanUseAutoRescan.mockReturnValue(true);
  mockCreateScan.mockResolvedValue(MOCK_SCAN);
  mockInngestSend.mockResolvedValue(undefined);
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

  it("creates a scan with a GID-formatted themeId, NOT a bare numeric string", async () => {
    await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(mockCreateScan).toHaveBeenCalledOnce();
    const [shopId, themeId, themeName] = mockCreateScan.mock.calls[0];

    expect(shopId).toBe(SHOP_ID);
    // Must be GID format, not a bare number or numeric string
    expect(themeId).toBe(THEME_GID);
    expect(themeId).toMatch(/^gid:\/\/shopify\/Theme\//);
    expect(themeId).not.toBe(String(THEME_NUMERIC_ID));
    expect(themeId).not.toBe(THEME_NUMERIC_ID);
    expect(themeName).toBe(THEME_NAME);
  });

  it("sends a scan/requested event with the GID-formatted themeId", async () => {
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
    // Critical fix: themeId in event must match GID format
    expect(event.data.themeId).toBe(THEME_GID);
    expect(event.data.themeId).toMatch(/^gid:\/\/shopify\/Theme\//);
  });

  it("looks up the shop by the domain from the webhook", async () => {
    await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(mockGetShopByDomain).toHaveBeenCalledWith(SHOP_DOMAIN);
  });

  it("checks canUseAutoRescan with the shop's plan", async () => {
    await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(mockCanUseAutoRescan).toHaveBeenCalledWith(MOCK_SHOP_PROFESSIONAL.plan);
  });

  it("constructs the correct GID from a numeric payload id", async () => {
    // Payload has a numeric id (as Shopify delivers it)
    setupWebhookAuth({ payload: { id: 987654321, name: "Debut" } });
    mockCreateScan.mockResolvedValue({ ...MOCK_SCAN, themeId: "gid://shopify/Theme/987654321" });

    await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    const [, themeId] = mockCreateScan.mock.calls[0];
    expect(themeId).toBe("gid://shopify/Theme/987654321");
  });
});

// ---------------------------------------------------------------------------
// Non-Professional plans — no scan created
// ---------------------------------------------------------------------------

describe("webhooks.themes.publish — non-Professional plans", () => {
  it("returns 200 silently for a Free-plan shop (no scan, no event)", async () => {
    mockGetShopByDomain.mockResolvedValue(MOCK_SHOP_FREE);
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
    mockGetShopByDomain.mockResolvedValue(MOCK_SHOP_STANDARD);
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
    mockGetShopByDomain.mockResolvedValue(null);

    const response = await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(response.status).toBe(200);
  });

  it("does not create a scan when shop is not in DB", async () => {
    mockGetShopByDomain.mockResolvedValue(null);

    await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(mockCreateScan).not.toHaveBeenCalled();
  });

  it("does not send an Inngest event when shop is not in DB", async () => {
    mockGetShopByDomain.mockResolvedValue(null);

    await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  it("does not call canUseAutoRescan when shop is not in DB", async () => {
    mockGetShopByDomain.mockResolvedValue(null);

    await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(mockCanUseAutoRescan).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GID format invariant — explicit regression tests for S-01 fix
// ---------------------------------------------------------------------------

describe("webhooks.themes.publish — GID format regression (S-01)", () => {
  it("themeId in createScan call is never a plain numeric string", async () => {
    await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    const [, themeId] = mockCreateScan.mock.calls[0];
    // Must not be just the stringified number
    expect(themeId).not.toBe("123456789");
    expect(themeId).not.toBe(123456789);
  });

  it("themeId in inngest.send event data is never a plain numeric string", async () => {
    await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    const event = mockInngestSend.mock.calls[0][0];
    expect(event.data.themeId).not.toBe("123456789");
    expect(event.data.themeId).not.toBe(123456789);
  });

  it("themeId in createScan and inngest.send are identical (referential consistency)", async () => {
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

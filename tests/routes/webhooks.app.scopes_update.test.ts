/**
 * Tests for the webhooks.app.scopes_update webhook handler (S-04 fix).
 *
 * Strategy:
 *   - Mock authenticate.webhook() to control what payload/session the handler sees.
 *   - Mock db.session.update to verify it is called (or not) with the correct scope string.
 *   - Key invariant: db.session.update is only called when payload.current is a
 *     non-empty string array AND a session is present. All paths return 200.
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

vi.mock("../../app/db.server", () => ({
  default: {
    session: {
      update: vi.fn(),
    },
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

import db from "../../app/db.server";
import { action } from "../../app/routes/webhooks.app.scopes_update";
import { authenticate } from "../../app/shopify.server";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockAuthenticateWebhook = authenticate.webhook as ReturnType<typeof vi.fn>;
const mockSessionUpdate = db.session.update as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Test data constants
// ---------------------------------------------------------------------------

const SHOP_DOMAIN = "test-shop.myshopify.com";
const SESSION_ID = "session-abc-123";
const SCOPES_ARRAY = ["read_products", "write_products"];
const SCOPES_STRING = "read_products,write_products";

const MOCK_SESSION = {
  id: SESSION_ID,
  shop: SHOP_DOMAIN,
  scope: "read_products",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest() {
  return new Request("https://example.com/webhooks/app/scopes_update", {
    method: "POST",
    body: JSON.stringify({ current: SCOPES_ARRAY }),
    headers: { "Content-Type": "application/json" },
  });
}

function setupWebhookAuth(overrides?: {
  payload?: Record<string, unknown>;
  session?: typeof MOCK_SESSION | null;
}) {
  mockAuthenticateWebhook.mockResolvedValue({
    topic: "APP_SUBSCRIPTIONS_UPDATE",
    shop: SHOP_DOMAIN,
    payload: overrides?.payload ?? { current: SCOPES_ARRAY },
    session: overrides?.session !== undefined ? overrides.session : MOCK_SESSION,
  });
}

// ---------------------------------------------------------------------------
// Setup: reset mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Default happy-path wiring
  setupWebhookAuth();
  mockSessionUpdate.mockResolvedValue(MOCK_SESSION);
});

// ---------------------------------------------------------------------------
// Happy path — valid session + non-empty scope array
// ---------------------------------------------------------------------------

describe("webhooks.app.scopes_update — happy path", () => {
  it("returns 200", async () => {
    const response = await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(response.status).toBe(200);
  });

  it("calls db.session.update with scope as a comma-joined string", async () => {
    await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(mockSessionUpdate).toHaveBeenCalledOnce();
    expect(mockSessionUpdate).toHaveBeenCalledWith({
      where: { id: SESSION_ID },
      data: { scope: SCOPES_STRING },
    });
  });

  it("joins multiple scopes into a comma-separated string (not JSON or other format)", async () => {
    setupWebhookAuth({ payload: { current: ["read_orders", "write_orders", "read_customers"] } });

    await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    const callArg = mockSessionUpdate.mock.calls[0][0];
    expect(callArg.data.scope).toBe("read_orders,write_orders,read_customers");
  });

  it("uses the session id from authenticate.webhook as the where clause key", async () => {
    const customSession = { ...MOCK_SESSION, id: "session-custom-999" };
    setupWebhookAuth({ session: customSession });

    await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    const callArg = mockSessionUpdate.mock.calls[0][0];
    expect(callArg.where.id).toBe("session-custom-999");
  });
});

// ---------------------------------------------------------------------------
// Missing / falsy payload.current — no DB update
// ---------------------------------------------------------------------------

describe("webhooks.app.scopes_update — missing or falsy payload.current", () => {
  it("returns 200 when payload.current is undefined", async () => {
    setupWebhookAuth({ payload: {} });

    const response = await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(response.status).toBe(200);
    expect(mockSessionUpdate).not.toHaveBeenCalled();
  });

  it("returns 200 when payload.current is null", async () => {
    setupWebhookAuth({ payload: { current: null } });

    const response = await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(response.status).toBe(200);
    expect(mockSessionUpdate).not.toHaveBeenCalled();
  });

  it("returns 200 when payload.current is a plain string (not an array)", async () => {
    setupWebhookAuth({ payload: { current: "read_products" } });

    const response = await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(response.status).toBe(200);
    expect(mockSessionUpdate).not.toHaveBeenCalled();
  });

  it("returns 200 when payload.current is an empty array", async () => {
    setupWebhookAuth({ payload: { current: [] } });

    const response = await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(response.status).toBe(200);
    expect(mockSessionUpdate).not.toHaveBeenCalled();
  });

  it("returns 200 when payload.current is a number", async () => {
    setupWebhookAuth({ payload: { current: 42 } });

    const response = await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(response.status).toBe(200);
    expect(mockSessionUpdate).not.toHaveBeenCalled();
  });

  it("returns 200 when payload itself is null", async () => {
    mockAuthenticateWebhook.mockResolvedValue({
      topic: "APP_SUBSCRIPTIONS_UPDATE",
      shop: SHOP_DOMAIN,
      payload: null,
      session: MOCK_SESSION,
    });

    const response = await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(response.status).toBe(200);
    expect(mockSessionUpdate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// No session — no DB update
// ---------------------------------------------------------------------------

describe("webhooks.app.scopes_update — no session", () => {
  it("returns 200 when session is null", async () => {
    setupWebhookAuth({ session: null });

    const response = await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(response.status).toBe(200);
  });

  it("does not call db.session.update when session is null", async () => {
    setupWebhookAuth({ session: null });

    await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(mockSessionUpdate).not.toHaveBeenCalled();
  });

  it("does not call db.session.update when session is undefined", async () => {
    mockAuthenticateWebhook.mockResolvedValue({
      topic: "APP_SUBSCRIPTIONS_UPDATE",
      shop: SHOP_DOMAIN,
      payload: { current: SCOPES_ARRAY },
      session: undefined,
    });

    await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);

    expect(mockSessionUpdate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Always returns 200 — no retry loops (regression: S-04)
// ---------------------------------------------------------------------------

describe("webhooks.app.scopes_update — always returns 200 (no retry loops)", () => {
  it("returns 200 on the happy path", async () => {
    const response = await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);
    expect(response.status).toBe(200);
  });

  it("returns 200 when payload.current is undefined", async () => {
    setupWebhookAuth({ payload: {} });
    const response = await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);
    expect(response.status).toBe(200);
  });

  it("returns 200 when payload.current is null", async () => {
    setupWebhookAuth({ payload: { current: null } });
    const response = await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);
    expect(response.status).toBe(200);
  });

  it("returns 200 when payload.current is empty array", async () => {
    setupWebhookAuth({ payload: { current: [] } });
    const response = await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);
    expect(response.status).toBe(200);
  });

  it("returns 200 when session is null", async () => {
    setupWebhookAuth({ session: null });
    const response = await action({
      request: makeRequest(),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs);
    expect(response.status).toBe(200);
  });
});
